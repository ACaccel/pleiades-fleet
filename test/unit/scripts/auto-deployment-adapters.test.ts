import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../../../scripts/auto-deployment/controller';
import { createFileStateStore } from '../../../scripts/auto-deployment/file-store';
import {
  createDeploymentHost,
  migrationInputsChanged,
} from '../../../scripts/auto-deployment/host';
import {
  readAutoDeploymentSettings,
  type AutoDeploymentSettings,
} from '../../../scripts/auto-deployment/settings';

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pleiades-adapter-test-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('real cross-process controller flock', () => {
  it('rejects a concurrent cycle and releases the parent-held lock after completion', async () => {
    const directory = join(temporaryRoot(), 'state');
    const first = createFileStateStore(directory);
    const second = createFileStateStore(directory);
    const acquired = deferred();
    const release = deferred();
    const concurrentOperation = vi.fn();
    const pending = first.withLock(async () => {
      acquired.resolve();
      await release.promise;
      return 'first';
    });
    await acquired.promise;
    try {
      await expect(second.withLock(concurrentOperation)).rejects.toThrow(
        'Another deployment cycle',
      );
      expect(concurrentOperation).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await expect(pending).resolves.toBe('first');
    }
    await expect(second.withLock(async () => 'next')).resolves.toBe('next');
  });

  it('releases the lock after an operation throws and preserves validated state', async () => {
    const directory = join(temporaryRoot(), 'state');
    const store = createFileStateStore(directory);
    await expect(
      store.withLock(async () => {
        const state = initialState();
        state.deployed.konata = 'a'.repeat(40);
        await store.save(state);
        throw new Error('synthetic deployment failure');
      }),
    ).rejects.toThrow('synthetic deployment failure');
    const another = createFileStateStore(directory);
    await another.withLock(async () => {
      expect((await another.load()).deployed.konata).toBe('a'.repeat(40));
    });
    expect(statSync(join(directory, 'cycle.lock')).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'state.json')).mode & 0o777).toBe(0o600);
  });

  it('rejects a public state directory before running any operation', async () => {
    const directory = join(temporaryRoot(), 'state');
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o777);
    const operation = vi.fn();
    await expect(createFileStateStore(directory).withLock(operation)).rejects.toThrow('private');
    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects unsafe lock permissions and a symlink lock without changing its target', async () => {
    const root = temporaryRoot();
    const directory = join(root, 'state');
    mkdirSync(directory, { mode: 0o700 });
    const lock = join(directory, 'cycle.lock');
    writeFileSync(lock, '', { mode: 0o600 });
    chmodSync(lock, 0o644);
    await expect(createFileStateStore(directory).withLock(async () => undefined)).rejects.toThrow(
      'permissions',
    );
    rmSync(lock);
    const outside = join(root, 'outside');
    writeFileSync(outside, 'synthetic external file', { mode: 0o600 });
    symlinkSync(outside, lock);
    await expect(createFileStateStore(directory).withLock(async () => undefined)).rejects.toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('synthetic external file');
  });
});

function settingsFixture() {
  const root = temporaryRoot();
  const source = join(root, 'source');
  const stateDirectory = join(root, 'state');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(join(stateDirectory, 'inputs'), { recursive: true, mode: 0o700 });
  const settings: AutoDeploymentSettings = {
    repository: 'example/pleiades-fleet',
    branch: 'dev',
    source,
    checkout: join(root, 'release'),
    stateDirectory,
    enabledBots: ['tomori'],
    condaExecutable: '/usr/bin/conda',
    operationalInputs: [
      { source: join(stateDirectory, 'inputs/deployment.json'), destination: 'deployment.json' },
      { source: join(stateDirectory, 'inputs/tomori.env'), destination: 'src/bot/tomori/.env' },
      {
        source: join(stateDirectory, 'inputs/tomori.json'),
        destination: 'src/bot/tomori/config.json',
      },
    ],
  };
  const path = join(root, 'auto-deploy.json');
  const read = (override: Record<string, unknown> = {}) => {
    writeFileSync(path, JSON.stringify({ ...settings, ...override }), { mode: 0o600 });
    return readAutoDeploymentSettings(path);
  };
  return { root, settings, read };
}

describe('dev-only settings and operational snapshots', () => {
  it('accepts an independent dev checkout with explicit per-bot private inputs', () => {
    const f = settingsFixture();
    expect(f.read()).toEqual(f.settings);
  });

  it('rejects main, duplicate enabled bots and arbitrary destination paths', () => {
    const f = settingsFixture();
    expect(() => f.read({ branch: 'main' })).toThrow();
    expect(() => f.read({ enabledBots: ['tomori', 'tomori'] })).toThrow();
    expect(() =>
      f.read({
        operationalInputs: [
          ...f.settings.operationalInputs,
          {
            source: join(f.settings.stateDirectory, 'inputs/escape'),
            destination: '../../outside',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects shared and nested development/release directories', () => {
    const f = settingsFixture();
    expect(() => f.read({ checkout: f.settings.source })).toThrow('separate');
    expect(() => f.read({ checkout: join(f.settings.source, 'release') })).toThrow('separate');
    expect(() => f.read({ checkout: f.root })).toThrow('separate');
    expect(() => f.read({ checkout: f.settings.stateDirectory })).toThrow('outside');
  });

  it('rejects symlink source or state directories', () => {
    const f = settingsFixture();
    const linkedSource = join(f.root, 'linked-source');
    const linkedState = join(f.root, 'linked-state');
    symlinkSync(f.settings.source, linkedSource);
    symlinkSync(f.settings.stateDirectory, linkedState);
    expect(() => f.read({ source: linkedSource })).toThrow('symlinks');
    expect(() => f.read({ stateDirectory: linkedState })).toThrow('symlinks');
  });

  it('rejects live developer inputs, duplicate destinations and missing required files', () => {
    const f = settingsFixture();
    const [deployment, env, config] = f.settings.operationalInputs;
    expect(() =>
      f.read({
        operationalInputs: [
          deployment,
          { ...env, source: join(f.settings.source, '.env') },
          config,
        ],
      }),
    ).toThrow('independent snapshots');
    expect(() => f.read({ operationalInputs: [deployment, env, config, env] })).toThrow(
      'unique destinations',
    );
    expect(() => f.read({ operationalInputs: [env, config] })).toThrow('deployment.json');
    expect(() => f.read({ operationalInputs: [deployment, env] })).toThrow(
      'Missing operational input',
    );
  });
});

function migrationWorkflow(patterns: readonly string[]): string {
  return [
    'on:',
    '  pull_request:',
    '    paths: &drill-paths',
    ...patterns.map((pattern) => `      - '${pattern}'`),
    '  push:',
    '    branches: [dev]',
    '    paths: *drill-paths',
  ].join('\n');
}

describe('migration workflow path gate', () => {
  const workflow = migrationWorkflow(['tools/migration/**', '.nvmrc', 'scripts/setup-node.mjs']);

  it('recognizes exact runtime pins and recursive migration inputs', () => {
    for (const path of ['.nvmrc', 'scripts/setup-node.mjs', 'tools/migration/nested/config.ts'])
      expect(migrationInputsChanged([path], workflow)).toBe(true);
    expect(migrationInputsChanged(['README.md', 'docs/deployment.md'], workflow)).toBe(false);
    expect(migrationInputsChanged(['tools/migration-other/file.ts'], workflow)).toBe(false);
    expect(migrationInputsChanged([], workflow)).toBe(false);
  });

  it('fails closed for unknown history, missing blocks and unsupported glob syntax', () => {
    expect(migrationInputsChanged(null, workflow)).toBe(true);
    expect(migrationInputsChanged(['README.md'], 'on: {push: {paths: [".nvmrc"]}}')).toBe(true);
    for (const pattern of [
      'scripts/*.sh',
      'tools/*/**',
      '**/migration/**',
      '!docs/**',
      'tools/{a,b}/**',
      'scripts/setup-?.mjs',
    ])
      expect(migrationInputsChanged(['README.md'], migrationWorkflow([pattern]))).toBe(true);
  });
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit(root: string): string {
  git(root, 'add', '--all');
  git(
    root,
    '-c',
    'user.name=Deployment Tests',
    '-c',
    'user.email=deployment@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    'test: add synthetic fixture',
  );
  return git(root, 'rev-parse', 'HEAD');
}

async function hostFixture() {
  const f = settingsFixture();
  git(f.settings.source, 'init', '--initial-branch=dev');
  writeFileSync(
    join(f.settings.source, '.gitignore'),
    '.env\nconfig.json\ndeployment.json\n/ignored-parent\n',
  );
  writeFileSync(join(f.settings.source, 'README.md'), 'Synthetic deployment fixture.\n');
  const sha = commit(f.settings.source);
  const host = createDeploymentHost(f.settings);
  const checkout = await host.createCheckout(sha);
  const input = f.settings.operationalInputs[1]!;
  writeFileSync(input.source, 'SYNTHETIC_SETTING=one\n', { mode: 0o600 });
  return { ...f, sha, host, checkout, input };
}

describe('release checkout input boundary', () => {
  it('creates an independent clean worktree and copies a private snapshot without a live link', async () => {
    const f = await hostFixture();
    await f.host.prepare(f.checkout, f.sha, [f.input]);
    const destination = join(f.checkout.directory, f.input.destination);
    expect(readFileSync(destination, 'utf8')).toBe('SYNTHETIC_SETTING=one\n');
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    writeFileSync(f.input.source, 'SYNTHETIC_SETTING=two\n');
    expect(readFileSync(destination, 'utf8')).toBe('SYNTHETIC_SETTING=one\n');
    expect(git(f.checkout.directory, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
  });

  it('seeds disabled bot examples for type checking without copying credentials', async () => {
    const f = await hostFixture();
    mkdirSync(join(f.settings.source, 'src/bot/gopher'), { recursive: true });
    writeFileSync(
      join(f.settings.source, 'src/bot/gopher/config.example.json'),
      '{"language":"en"}',
    );
    const sha = commit(f.settings.source);
    const checkout = await f.host.createCheckout(sha);
    await f.host.prepare(checkout, sha, [f.input]);
    expect(readFileSync(join(checkout.directory, 'src/bot/gopher/config.json'), 'utf8')).toBe(
      '{"language":"en"}',
    );
    expect(existsSync(join(checkout.directory, 'src/bot/gopher/.env'))).toBe(false);
  });

  it('rejects a dangling destination symlink without writing outside the checkout', async () => {
    const f = await hostFixture();
    const destination = join(f.checkout.directory, f.input.destination);
    mkdirSync(join(f.checkout.directory, 'src/bot/tomori'), { recursive: true });
    const outside = join(f.root, 'outside-not-created');
    symlinkSync(outside, destination);
    await expect(f.host.prepare(f.checkout, f.sha, [f.input])).rejects.toThrow('regular file');
    expect(existsSync(outside)).toBe(false);
  });

  it('rejects input symlinks and refuses overwriting any tracked source file', async () => {
    const f = await hostFixture();
    const linkedInput = join(f.settings.stateDirectory, 'inputs/linked.env');
    symlinkSync(f.input.source, linkedInput);
    await expect(
      f.host.prepare(f.checkout, f.sha, [{ ...f.input, source: linkedInput }]),
    ).rejects.toThrow('regular snapshots');
    await expect(
      f.host.prepare(f.checkout, f.sha, [{ ...f.input, destination: 'README.md' }]),
    ).rejects.toThrow('tracked files');
    expect(readFileSync(join(f.checkout.directory, 'README.md'), 'utf8')).toBe(
      'Synthetic deployment fixture.\n',
    );
  });

  it('rejects ignored parent symlinks and leaves external files intact', async () => {
    const f = await hostFixture();
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '.env'), 'synthetic external content\n');
    symlinkSync(outside, join(f.checkout.directory, 'ignored-parent'));
    await expect(
      f.host.prepare(f.checkout, f.sha, [{ ...f.input, destination: 'ignored-parent/.env' }]),
    ).rejects.toThrow();
    expect(readFileSync(join(outside, '.env'), 'utf8')).toBe('synthetic external content\n');
  });

  it('preserves whitespace in NUL-separated diff paths and returns both rename endpoints', async () => {
    const f = await hostFixture();
    mkdirSync(join(f.settings.source, ' docs'));
    writeFileSync(join(f.settings.source, ' docs/unknown.ts'), 'export {};\n');
    const next = commit(f.settings.source);
    expect(await f.host.changedPaths(f.sha, next)).toContain(' docs/unknown.ts');
    mkdirSync(join(f.settings.source, 'src/bot/konata'), { recursive: true });
    git(f.settings.source, 'mv', ' docs/unknown.ts', 'src/bot/konata/new.ts');
    const renamed = commit(f.settings.source);
    expect(await f.host.changedPaths(next, renamed)).toEqual([
      ' docs/unknown.ts',
      'src/bot/konata/new.ts',
    ]);
    expect(await f.host.changedPaths('f'.repeat(40), renamed)).toBeNull();
  });
});
