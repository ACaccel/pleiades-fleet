import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '../../../src/plugins/notification-relay/internal/request';
import { evaluateCi } from '../../../scripts/auto-deployment/ci';
import {
  initialState,
  recoverController,
  runCycle,
} from '../../../scripts/auto-deployment/controller';
import type {
  AutoDeploymentConfig,
  AutoDeploymentState,
  CiRun,
  CiSnapshot,
  ControllerAdapters,
  DeploymentHost,
} from '../../../scripts/auto-deployment/contracts';
import {
  deploymentNotice,
  flushOutbox,
  MAX_DELIVERIES_PER_FLUSH,
  MAX_NOTIFICATION_ATTEMPTS,
  MAX_OUTBOX_THREADS,
  notificationKey,
  OUTBOX_RETENTION_MS,
  queueNotice,
} from '../../../scripts/auto-deployment/notifications';
import {
  createRelayClient,
  validateRelayConfig,
} from '../../../scripts/auto-deployment/relay-client';
import {
  parseControllerState,
  readControllerState,
  writeControllerState,
} from '../../../scripts/auto-deployment/state';
import { selectBotTargets } from '../../../scripts/auto-deployment/targets';

const BASE = '1'.repeat(40);
const SHA = '2'.repeat(40);
const NEXT = '3'.repeat(40);
const config: AutoDeploymentConfig = {
  branch: 'dev',
  enabledBots: ['tomori', 'konata'],
  operationalInputs: [{ source: '/etc/pleiades/tomori.env', destination: 'inputs/tomori.env' }],
};

function successfulRun(path: string, jobs: readonly string[], sha = SHA): CiRun {
  return {
    id: 1,
    runNumber: 1,
    runAttempt: 1,
    workflowPath: `.github/workflows/${path}.yml`,
    headSha: sha,
    headBranch: 'dev',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    jobs: jobs.map((name) => ({
      name,
      runAttempt: 1,
      status: 'completed',
      conclusion: 'success',
    })),
  };
}
function readyCi(sha = SHA): CiSnapshot {
  return {
    runs: [
      successfulRun('ci', ['quality', 'tests', 'security'], sha),
      successfulRun('codeql', ['analyze'], sha),
    ],
    migrationRequired: false,
  };
}

function fixture() {
  let saved: AutoDeploymentState = {
    ...initialState(),
    deployed: { tomori: BASE, konata: BASE },
  };
  let now = 1_000;
  const host = {
    fetchDevSha: vi.fn<DeploymentHost['fetchDevSha']>(async () => SHA),
    readCi: vi.fn<DeploymentHost['readCi']>(async () => readyCi()),
    changedPaths: vi.fn<DeploymentHost['changedPaths']>(async () => ['src/bot/tomori/index.ts']),
    createCheckout: vi.fn<DeploymentHost['createCheckout']>(async (sha) => ({
      sha,
      directory: `/srv/releases/${sha}`,
    })),
    prepare: vi.fn<DeploymentHost['prepare']>(async () => undefined),
    build: vi.fn<DeploymentHost['build']>(async () => undefined),
    deploy: vi.fn<DeploymentHost['deploy']>(async (_checkout, targets, progress) => {
      for (const component of [...targets.bots, ...targets.databaseServices]) {
        await progress({ component, state: 'running' });
        await progress({ component, state: 'done' });
      }
    }),
    recover: vi.fn<DeploymentHost['recover']>(async () => undefined),
  };
  const put = vi.fn<(key: string, notification: Notification) => Promise<void>>(
    async () => undefined,
  );
  const warn = vi.fn();
  let locked = false;
  const adapters: ControllerAdapters = {
    host,
    now: () => now,
    warn,
    notifier: { put },
    store: {
      async withLock<T>(operation: () => Promise<T>): Promise<T> {
        if (locked) throw new Error('Lock held');
        locked = true;
        try {
          return await operation();
        } finally {
          locked = false;
        }
      },
      async load() {
        return structuredClone(saved);
      },
      async save(state) {
        saved = structuredClone(state);
      },
    },
  };
  return {
    adapters,
    host,
    put,
    warn,
    state: () => structuredClone(saved),
    seed: (value: AutoDeploymentState) => (saved = structuredClone(value)),
    advance: (duration: number) => (now += duration),
  };
}

describe('exact dev push CI approval', () => {
  it('requires the CI jobs and CodeQL for the exact SHA and push event', () => {
    expect(evaluateCi(SHA, readyCi()).ready).toBe(true);
    for (const replacement of [
      { headSha: BASE },
      { event: 'pull_request' },
      { headBranch: 'main' },
      { status: 'queued' },
      { conclusion: 'cancelled' },
      { jobs: successfulRun('ci', ['quality', 'tests']).jobs },
    ]) {
      const snapshot = readyCi();
      expect(
        evaluateCi(SHA, {
          ...snapshot,
          runs: [{ ...snapshot.runs[0]!, ...replacement }, snapshot.runs[1]!],
        }).ready,
      ).toBe(false);
    }
    expect(evaluateCi(SHA, { runs: [readyCi().runs[0]!], migrationRequired: false }).ready).toBe(
      false,
    );
  });

  it('never accepts an older successful run or an earlier successful attempt', () => {
    const older = successfulRun('ci', ['quality', 'tests', 'security']);
    const codeql = readyCi().runs[1]!;
    const latest = {
      ...older,
      runNumber: 2,
      id: 2,
      status: 'in_progress',
      conclusion: null,
    };
    expect(
      evaluateCi(SHA, {
        runs: [older, latest, codeql],
        migrationRequired: false,
      }).ready,
    ).toBe(false);
    const rerun = { ...older, runAttempt: 2 };
    expect(
      evaluateCi(SHA, {
        runs: [older, rerun, codeql],
        migrationRequired: false,
      }).ready,
    ).toBe(false);
  });

  it('requires a migration drill when expected or already triggered', () => {
    const snapshot = readyCi();
    expect(evaluateCi(SHA, { ...snapshot, migrationRequired: true }).ready).toBe(false);
    const drill = successfulRun('migration-drill', ['migration-drill']);
    expect(
      evaluateCi(SHA, {
        runs: [...snapshot.runs, drill],
        migrationRequired: true,
      }).ready,
    ).toBe(true);
    expect(
      evaluateCi(SHA, {
        runs: [...snapshot.runs, { ...drill, conclusion: 'failure' }],
        migrationRequired: false,
      }).ready,
    ).toBe(false);
  });
});

describe('conservative per-bot target selection', () => {
  it('limits changes inside known composition roots to that bot', () => {
    expect(
      selectBotTargets(['tomori', 'konata'], {
        tomori: ['src/bot/tomori/index.ts', 'docs/configuration.md'],
        konata: ['src/bot/tomori/index.ts'],
      }),
    ).toEqual(['tomori']);
  });

  it('treats unknown, shared, runtime and dependency edits as affecting every enabled bot', () => {
    for (const path of [
      'src/core/config/env.ts',
      'package-lock.json',
      'environment.yml',
      'mystery',
      'src/bot/future/index.ts',
    ])
      expect(
        selectBotTargets(['tomori', 'konata'], {
          tomori: [path],
          konata: [path],
        }),
      ).toEqual(['tomori', 'konata']);
    expect(selectBotTargets(['tomori', 'konata'], { tomori: null })).toEqual(['tomori', 'konata']);
  });

  it('does not restart for documented safe paths but does restart unknown markdown inside code', () => {
    expect(selectBotTargets(['tomori'], { tomori: ['README.md', 'docs/deploy.md'] })).toEqual([]);
    expect(selectBotTargets(['tomori'], { tomori: ['src/README.md'] })).toEqual(['tomori']);
  });
});

describe('durable deployment controller', () => {
  it('leaves service baselines unchanged for documentation-only edits', async () => {
    const f = fixture();
    f.host.changedPaths.mockResolvedValue(['docs/contributing/deployment.md', 'README.md']);
    expect((await runCycle(config, f.adapters)).kind).toBe('unchanged');
    expect(f.state().deployed).toEqual({ tomori: BASE, konata: BASE });
    expect(f.state().lastInspectedSha).toBe(SHA);
    expect(f.host.build).not.toHaveBeenCalled();
    expect(f.host.deploy).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it('uses the exact independent checkout, explicit input snapshot and per-bot baseline', async () => {
    const f = fixture();
    expect(await runCycle(config, f.adapters)).toEqual({
      kind: 'deployed',
      sha: SHA,
    });
    expect(f.host.prepare).toHaveBeenCalledWith(
      { sha: SHA, directory: `/srv/releases/${SHA}` },
      SHA,
      config.operationalInputs,
    );
    expect(f.host.deploy.mock.calls[0]?.[1]).toEqual({
      bots: ['tomori'],
      databaseServices: [],
    });
    expect(f.state().deployed).toEqual({ tomori: SHA, konata: BASE });
    expect(f.state().install).toBeUndefined();
    expect(f.host.readCi).toHaveBeenCalledTimes(2);
    expect(f.put.mock.calls.every(([key]) => key === notificationKey(SHA))).toBe(true);
  });

  it('never loses an un-deployed bot edit when a newer commit is inspected', async () => {
    const f = fixture();
    await runCycle(config, f.adapters);
    f.host.fetchDevSha.mockResolvedValue(NEXT);
    f.host.readCi.mockResolvedValue(readyCi(NEXT));
    f.host.changedPaths.mockImplementation(async (base) =>
      base === SHA ? ['docs/readme.md'] : ['src/bot/konata/index.ts', 'docs/readme.md'],
    );
    expect(await runCycle(config, f.adapters)).toEqual({
      kind: 'deployed',
      sha: NEXT,
    });
    expect(f.host.changedPaths).toHaveBeenCalledWith(BASE, NEXT);
    expect(f.host.deploy.mock.calls[1]?.[1].bots).toEqual(['konata']);
    expect(f.state().deployed).toEqual({ tomori: SHA, konata: NEXT });
  });

  it('never builds or installs without approved CI', async () => {
    const f = fixture();
    f.host.readCi.mockResolvedValue({ runs: [], migrationRequired: false });
    expect((await runCycle(config, f.adapters)).kind).toBe('waiting');
    expect(f.host.createCheckout).not.toHaveBeenCalled();
    expect(f.host.deploy).not.toHaveBeenCalled();
  });

  it('blocks build failures at the same SHA until explicit retry and keeps one thread', async () => {
    const f = fixture();
    f.host.build.mockRejectedValueOnce(new Error('sensitive private command output'));
    expect((await runCycle(config, f.adapters)).kind).toBe('build_failed');
    expect((await runCycle(config, f.adapters)).kind).toBe('halted');
    expect(f.host.build).toHaveBeenCalledTimes(1);
    expect((await runCycle(config, f.adapters, { retryFailedBuild: true })).kind).toBe('deployed');
    expect(f.state().attempt).toBe(2);
    expect(f.put.mock.calls.at(-1)?.[1].description).toContain('Attempt 2');
    expect(JSON.stringify(f.put.mock.calls)).not.toContain('sensitive');
    expect(new Set(f.put.mock.calls.map(([key]) => key)).size).toBe(1);
  });

  it('checks CI again after the pre-stop notification and defers superseded candidates', async () => {
    const f = fixture();
    f.host.fetchDevSha.mockResolvedValueOnce(SHA).mockResolvedValueOnce(NEXT);
    expect((await runCycle(config, f.adapters)).kind).toBe('superseded');
    expect(f.host.deploy).not.toHaveBeenCalled();
    expect(f.state().install).toBeUndefined();
    const other = fixture();
    other.host.readCi
      .mockResolvedValueOnce(readyCi())
      .mockResolvedValueOnce({ runs: [], migrationRequired: false });
    expect((await runCycle(config, other.adapters)).kind).toBe('superseded');
    expect(other.host.deploy).not.toHaveBeenCalled();
  });

  it('persists the installation marker before privilege and requires explicit recovery after failure', async () => {
    const f = fixture();
    f.host.deploy.mockImplementation(async () => {
      expect(f.state().install?.sha).toBe(SHA);
      throw new Error('private install failure');
    });
    expect((await runCycle(config, f.adapters)).kind).toBe('install_failed');
    expect(f.state().install?.sha).toBe(SHA);
    expect((await runCycle(config, f.adapters)).kind).toBe('halted');
    expect(f.host.deploy).toHaveBeenCalledTimes(1);
    f.host.recover.mockRejectedValueOnce(new Error('Still recovering'));
    await expect(recoverController(f.adapters)).rejects.toThrow('Still recovering');
    expect(f.state().install).toBeDefined();
    expect(await recoverController(f.adapters)).toBe(true);
    expect(f.state().install).toBeUndefined();
    expect(f.state().deployed.tomori).toBe(BASE);
  });

  it('attempts notifications before Konata stops and retries the newest state after readiness', async () => {
    const f = fixture();
    f.host.changedPaths.mockResolvedValue(['package-lock.json']);
    let offline = false;
    const delivered: Notification[] = [];
    f.put.mockImplementation(async (_key, payload) => {
      if (offline) throw new Error('Relay temporarily offline');
      delivered.push(structuredClone(payload));
    });
    f.host.deploy.mockImplementation(async (_checkout, targets, progress) => {
      expect(delivered.length).toBeGreaterThan(0);
      expect(targets.bots).toContain('konata');
      offline = true;
      await progress({ component: 'konata', state: 'running' });
      expect(
        f.state().outbox[0]?.notification.stages.find((stage) => stage.label === 'konata')?.state,
      ).toBe('running');
      offline = false;
    });
    expect((await runCycle(config, f.adapters)).kind).toBe('deployed');
    expect(delivered.at(-1)?.status).toBe('succeeded');
    expect(delivered.at(-1)?.description).toContain('Bots: tomori, konata');
    expect(delivered.at(-1)?.description).toContain('Database services: none');
    expect(f.state().outbox).toEqual([]);
  });

  it('keeps notification failures independent from deployment success and retries even while halted', async () => {
    const f = fixture();
    f.put.mockRejectedValue(new Error('Secret-bearing network failure'));
    expect((await runCycle(config, f.adapters)).kind).toBe('deployed');
    expect(f.state().outbox).toHaveLength(1);
    expect(f.state().outbox[0]?.notification.status).toBe('succeeded');
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain('Secret-bearing');
    const state = f.state();
    state.install = {
      sha: SHA,
      attempt: 1,
      checkout: { directory: '/srv/old', sha: SHA },
      targets: { bots: ['tomori'], databaseServices: [] },
    };
    f.seed(state);
    f.advance(60_000);
    f.put.mockResolvedValue(undefined);
    expect((await runCycle(config, f.adapters)).kind).toBe('halted');
    expect(f.state().outbox).toEqual([]);
  });

  it('includes database services only for an explicit one-time cutover', async () => {
    const f = fixture();
    await runCycle(config, f.adapters, {
      cutoverDatabaseServices: ['mongodb-pleiades.service'],
    });
    expect(f.host.deploy.mock.calls[0]?.[1].databaseServices).toEqual(['mongodb-pleiades.service']);
    expect(f.put.mock.calls.at(-1)?.[1].description).toContain('mongodb-pleiades.service');
  });

  it('holds the whole-cycle lock rather than allowing parallel builds or installs', async () => {
    const f = fixture();
    let release: () => void = () => undefined;
    f.host.build.mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = runCycle(config, f.adapters);
    await vi.waitFor(() => expect(f.host.build).toHaveBeenCalledOnce());
    await expect(runCycle(config, f.adapters)).rejects.toThrow('Lock held');
    release();
    await first;
    expect(f.host.deploy).toHaveBeenCalledOnce();
  });
});

describe('bounded latest-only notification outbox', () => {
  it('bounds work per flush and prioritizes the current deployment over stale threads', async () => {
    const f = fixture();
    const state = initialState();
    const notice = deploymentNotice(SHA, 1, { bots: ['konata'], databaseServices: [] });
    for (let index = 0; index < 20; index++)
      queueNotice(state, index.toString(16).padStart(40, '0'), notice, 1_000);
    queueNotice(state, SHA, notice, 1_000);
    f.put.mockRejectedValue(new Error('Offline'));
    await flushOutbox(state, f.adapters, notificationKey(SHA));
    expect(f.put).toHaveBeenCalledTimes(MAX_DELIVERIES_PER_FLUSH);
    expect(f.put.mock.calls[0]?.[0]).toBe(notificationKey(SHA));
    expect(state.outbox).toHaveLength(21);
  });

  it('replaces stale progress and bounds retained threads', () => {
    const state = initialState();
    const notice = deploymentNotice(SHA, 1, {
      bots: ['konata'],
      databaseServices: [],
    });
    queueNotice(state, SHA, notice, 100);
    notice.status = 'succeeded';
    queueNotice(state, SHA, notice, 200);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.notification.status).toBe('succeeded');
    for (let index = 0; index <= MAX_OUTBOX_THREADS; index++)
      queueNotice(state, index.toString(16).padStart(40, '0'), notice, index + 300);
    expect(state.outbox).toHaveLength(MAX_OUTBOX_THREADS);
  });

  it('retains and retries a failed result across a multi-hour outage with bounded sends', async () => {
    const f = fixture();
    const state = initialState();
    const notice = deploymentNotice(SHA, 1, {
      bots: ['konata'],
      databaseServices: [],
    });
    notice.status = 'failed';
    queueNotice(state, SHA, notice, 1_000);
    f.put.mockRejectedValue(new Error('Offline'));
    await flushOutbox(state, f.adapters);
    expect(state.outbox[0]?.attempts).toBe(1);
    await flushOutbox(state, f.adapters);
    expect(f.put).toHaveBeenCalledTimes(1);
    f.advance(2 * 60 * 60 * 1000);
    f.put.mockResolvedValue(undefined);
    await flushOutbox(state, f.adapters);
    expect(state.outbox).toHaveLength(0);
    queueNotice(state, SHA, notice, 1_000);
    state.outbox[0]!.attempts = MAX_NOTIFICATION_ATTEMPTS;
    await flushOutbox(state, f.adapters);
    expect(state.outbox).toHaveLength(1);
    f.advance(OUTBOX_RETENTION_MS);
    await flushOutbox(state, f.adapters);
    expect(state.outbox).toEqual([]);
  });
});

const temporaryRoots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pleiades-auto-test-'));
  temporaryRoots.push(root);
  return root;
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('protected durable state and loopback relay', () => {
  it('round-trips state atomically and refuses malformed, public or linked files', async () => {
    const root = temporaryRoot();
    const file = join(root, 'state.json');
    const uid = process.getuid?.() ?? 0;
    expect(await readControllerState(file, uid)).toBeUndefined();
    await writeControllerState(file, initialState());
    expect(await readControllerState(file, uid)).toEqual(initialState());
    expect(() => parseControllerState({ ...initialState(), version: 2 })).toThrow();
    chmodSync(file, 0o644);
    await expect(readControllerState(file, uid)).rejects.toThrow('permissions');
    chmodSync(file, 0o600);
    const link = join(root, 'linked.json');
    symlinkSync(file, link);
    await expect(readControllerState(link, uid)).rejects.toThrow('Cannot open');
  });

  it('accepts only loopback endpoints and secret-free configuration', () => {
    const base = {
      route: 'pleiades-deploy',
      keyFile: '/etc/pleiades/key',
      ownerUid: 1000,
    };
    for (const endpoint of [
      'https://127.0.0.1',
      'http://localhost',
      'http://example.com',
      'http://127.0.0.1/?token=secret',
      'http://secret@127.0.0.1',
      'http://127.0.0.1/path',
    ])
      expect(() => validateRelayConfig({ ...base, endpoint })).toThrow();
    expect(validateRelayConfig({ ...base, endpoint: 'http://127.0.0.1:38121' }).hostname).toBe(
      '127.0.0.1',
    );
  });

  it('uses idempotent PUT with a 0600 owner key and suppresses secret-bearing errors', async () => {
    const root = temporaryRoot();
    const keyFile = join(root, 'relay.key');
    writeFileSync(keyFile, 'synthetic-test-key-only-000000000000', { mode: 0o600 });
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    const client = createRelayClient(
      {
        endpoint: 'http://127.0.0.1:38121',
        route: 'pleiades-deploy',
        keyFile,
        ownerUid: process.getuid?.() ?? 0,
      },
      request,
    );
    const notice = deploymentNotice(SHA, 1, {
      bots: ['konata'],
      databaseServices: [],
    });
    await client.put(notificationKey(SHA), notice);
    expect(request.mock.calls[0]?.[0].toString()).toContain(
      `/notifications/pleiades-deploy/${notificationKey(SHA)}`,
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      redirect: 'error',
    });
    chmodSync(keyFile, 0o644);
    await expect(client.put(notificationKey(SHA), notice)).rejects.toThrow(
      'Deployment notification delivery failed',
    );
    expect(request).toHaveBeenCalledOnce();
    chmodSync(keyFile, 0o600);
    request.mockRejectedValueOnce(new Error('synthetic-test-key-only-000000000000'));
    await expect(client.put(notificationKey(SHA), notice)).rejects.toThrow(
      /^Deployment notification delivery failed$/,
    );
  });
});
