/**
 * Unit tests for the alarm service and plugin.
 *
 * The service takes a typed `AlarmDeps` bundle, so these tests inject a
 * fake registry, repos and Discord client without any handler-registry
 * or real Discord / Mongo wiring.
 */
import type { Job } from 'node-schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { err, ok } from '../../../src/core/result';
import { createContainer } from '../../../src/core/ioc';
import { TOKENS } from '../../../src/bot/tokens';
import { databaseErrorFrom } from '../../../src/persistence/error-translator';
import { createAlarmPlugin } from '../../../src/plugins/alarm';
import {
  alarmJobKey,
  cancelAlarm,
  createAlarm,
  fireAlarm,
  rebootAlarmJobs,
  type AlarmDeps,
} from '../../../src/application/alarm/alarm';
import { buildSendableChannel } from '../../fixtures/discord/channel-builder';
import { buildPluginContext, echoTranslator, silentLogger } from '../../fixtures/runtime';

// Far enough in the real future that node-schedule (which runs on the
// real clock) returns a live, cancellable Job.
const FUTURE = 4_102_444_800_000; // 2100-01-01T00:00:00Z

const dbErr = () => err(databaseErrorFrom(new Error('boom'), { operation: 'test' }));

const alarmDoc = (overrides: Record<string, unknown> = {}) => ({
  alarm_id: 'a1',
  channel_id: 'chan-1',
  creator_id: 'u1',
  message: 'stand-up time',
  fire_at: FUTURE,
  mention_everyone: false,
  ...overrides,
});

interface FakeReposOverrides {
  listAll?: ReturnType<typeof vi.fn>;
  listByCreator?: ReturnType<typeof vi.fn>;
  findByAlarmId?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  deleteByAlarmId?: ReturnType<typeof vi.fn>;
}

const makeRepos = (overrides: FakeReposOverrides = {}) => ({
  alarm: {
    listAll: overrides.listAll ?? vi.fn().mockResolvedValue(ok([])),
    listByCreator: overrides.listByCreator ?? vi.fn().mockResolvedValue(ok([])),
    findByAlarmId: overrides.findByAlarmId ?? vi.fn().mockResolvedValue(ok(alarmDoc())),
    create: overrides.create ?? vi.fn().mockResolvedValue(ok(alarmDoc())),
    deleteByAlarmId: overrides.deleteByAlarmId ?? vi.fn().mockResolvedValue(ok(true)),
  },
});

const createdJobMaps: Map<string, Job>[] = [];

interface MakeDepsOpts {
  repos?: unknown;
  channel?: unknown;
  listGuildIds?: readonly string[];
  getChannel?: () => unknown;
}

const makeDeps = (opts: MakeDepsOpts = {}): AlarmDeps => {
  const jobMap = new Map<string, Job>();
  createdJobMaps.push(jobMap);
  return {
    client: { channels: { fetch: vi.fn().mockResolvedValue(opts.channel ?? null) } },
    registry: {
      getRepos: () => opts.repos,
      getChannel: opts.getChannel ?? (() => undefined),
      listGuildIds: () => opts.listGuildIds ?? [],
    },
    jobMap,
    logger: silentLogger(),
    translator: echoTranslator(),
  } as unknown as AlarmDeps;
};

const createArgs = (overrides: Record<string, unknown> = {}) => ({
  guildId: 'g1',
  channelId: 'chan-1',
  creatorId: 'u1',
  message: 'stand-up time',
  fireAt: FUTURE,
  mentionEveryone: false,
  maxActivePerMember: 2,
  ...overrides,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  for (const jm of createdJobMaps) for (const job of jm.values()) job?.cancel();
  createdJobMaps.length = 0;
  vi.clearAllMocks();
});

describe('createAlarm', () => {
  it('reports a guild without a database', async () => {
    await expect(createAlarm(makeDeps(), createArgs())).resolves.toEqual({ status: 'no_db' });
  });

  it('refuses a member at the pending-alarm cap', async () => {
    const repos = makeRepos({
      listByCreator: vi.fn().mockResolvedValue(ok([alarmDoc(), alarmDoc({ alarm_id: 'a2' })])),
    });
    const deps = makeDeps({ repos });
    await expect(createAlarm(deps, createArgs())).resolves.toEqual({ status: 'too_many', max: 2 });
    expect(repos.alarm.create).not.toHaveBeenCalled();
  });

  it('persists the alarm and schedules its job', async () => {
    const repos = makeRepos();
    const deps = makeDeps({ repos });
    const outcome = await createAlarm(deps, createArgs({ mentionEveryone: true }));
    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') return;
    expect(repos.alarm.create).toHaveBeenCalledWith({
      alarm_id: outcome.alarmId,
      channel_id: 'chan-1',
      creator_id: 'u1',
      message: 'stand-up time',
      fire_at: FUTURE,
      mention_everyone: true,
    });
    expect(deps.jobMap.has(alarmJobKey(outcome.alarmId))).toBe(true);
  });

  it('serializes concurrent creations so the cap holds', async () => {
    const stored: unknown[] = [];
    const repos = makeRepos({
      listByCreator: vi.fn().mockImplementation(async () => ok([...stored])),
      create: vi.fn().mockImplementation(async (input: unknown) => {
        stored.push(input);
        return ok(input);
      }),
    });
    const deps = makeDeps({ repos });
    const args = createArgs({ maxActivePerMember: 1 });
    const outcomes = await Promise.all([createAlarm(deps, args), createAlarm(deps, args)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['created', 'too_many']);
  });

  it('rethrows a failed write without scheduling', async () => {
    const deps = makeDeps({ repos: makeRepos({ create: vi.fn().mockResolvedValue(dbErr()) }) });
    await expect(createAlarm(deps, createArgs())).rejects.toBeDefined();
    expect(deps.jobMap.size).toBe(0);
  });
});

describe('fireAlarm', () => {
  it('claims the row before posting the message with user-only mentions', async () => {
    const { channel, send } = buildSendableChannel();
    const repos = makeRepos();
    await fireAlarm(makeDeps({ repos, channel }), 'g1', 'a1');
    expect(repos.alarm.deleteByAlarmId).toHaveBeenCalledWith('a1');
    expect(repos.alarm.deleteByAlarmId.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0]!,
    );
    expect(send).toHaveBeenCalledWith({
      content: 'replies:alarm.fired',
      allowedMentions: { parse: ['users'] },
    });
  });

  it('allows @everyone and role pings when the creator could mention everyone', async () => {
    const { channel, send } = buildSendableChannel();
    const repos = makeRepos({
      findByAlarmId: vi.fn().mockResolvedValue(ok(alarmDoc({ mention_everyone: true }))),
    });
    await fireAlarm(makeDeps({ repos, channel }), 'g1', 'a1');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: ['users', 'roles', 'everyone'] } }),
    );
  });

  it('sends nothing when another path already removed the row', async () => {
    const { channel, send } = buildSendableChannel();
    const repos = makeRepos({ deleteByAlarmId: vi.fn().mockResolvedValue(ok(false)) });
    await fireAlarm(makeDeps({ repos, channel }), 'g1', 'a1');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing for an alarm that no longer exists', async () => {
    const { channel, send } = buildSendableChannel();
    const repos = makeRepos({ findByAlarmId: vi.fn().mockResolvedValue(ok(undefined)) });
    await fireAlarm(makeDeps({ repos, channel }), 'g1', 'a1');
    expect(repos.alarm.deleteByAlarmId).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('drops the alarm without retrying when the channel is gone', async () => {
    const repos = makeRepos();
    await expect(fireAlarm(makeDeps({ repos }), 'g1', 'a1')).resolves.toBeUndefined();
    expect(repos.alarm.deleteByAlarmId).toHaveBeenCalledWith('a1');
  });

  it('keeps the row when the claim fails so a reboot retries it', async () => {
    const { channel, send } = buildSendableChannel();
    const repos = makeRepos({ deleteByAlarmId: vi.fn().mockResolvedValue(dbErr()) });
    await expect(fireAlarm(makeDeps({ repos, channel }), 'g1', 'a1')).rejects.toBeDefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('cancelAlarm', () => {
  it('reports an unknown alarm', async () => {
    const repos = makeRepos({ findByAlarmId: vi.fn().mockResolvedValue(ok(undefined)) });
    await expect(cancelAlarm(makeDeps({ repos }), 'g1', 'a1', () => true)).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('lets the authority check refuse the requester', async () => {
    const repos = makeRepos();
    const canCancel = vi.fn().mockReturnValue(false);
    await expect(cancelAlarm(makeDeps({ repos }), 'g1', 'a1', canCancel)).resolves.toEqual({
      status: 'forbidden',
    });
    expect(canCancel).toHaveBeenCalledWith('u1');
    expect(repos.alarm.deleteByAlarmId).not.toHaveBeenCalled();
  });

  it('removes the row and cancels the job', async () => {
    const repos = makeRepos();
    const deps = makeDeps({ repos });
    const cancel = vi.fn();
    deps.jobMap.set(alarmJobKey('a1'), { cancel } as unknown as Job);
    await expect(cancelAlarm(deps, 'g1', 'a1', () => true)).resolves.toEqual({
      status: 'cancelled',
    });
    expect(cancel).toHaveBeenCalled();
    expect(deps.jobMap.has(alarmJobKey('a1'))).toBe(false);
  });

  it('reports an alarm that fired between lookup and delete as not found', async () => {
    const repos = makeRepos({ deleteByAlarmId: vi.fn().mockResolvedValue(ok(false)) });
    await expect(cancelAlarm(makeDeps({ repos }), 'g1', 'a1', () => true)).resolves.toEqual({
      status: 'not_found',
    });
  });
});

describe('rebootAlarmJobs', () => {
  it('reschedules a pending alarm and fires one that fell due while down', async () => {
    const { channel, send } = buildSendableChannel();
    const repos = makeRepos({
      listAll: vi
        .fn()
        .mockResolvedValue(ok([alarmDoc(), alarmDoc({ alarm_id: 'late', fire_at: 1_000 })])),
      findByAlarmId: vi.fn().mockResolvedValue(ok(alarmDoc({ alarm_id: 'late', fire_at: 1_000 }))),
    });
    const deps = makeDeps({ repos, channel, listGuildIds: ['g1'] });
    await rebootAlarmJobs(deps);
    await flush();
    expect(deps.jobMap.has(alarmJobKey('a1'))).toBe(true);
    expect(deps.jobMap.has(alarmJobKey('late'))).toBe(false);
    expect(repos.alarm.deleteByAlarmId).toHaveBeenCalledWith('late');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rebuilds only the recovered guild', async () => {
    const repos = makeRepos();
    const deps = makeDeps({ repos, listGuildIds: ['g1', 'g2'] });
    await rebootAlarmJobs(deps, 'g2');
    expect(repos.alarm.listAll).toHaveBeenCalledTimes(1);
  });

  it('notifies the debug channel when listAll keeps failing', async () => {
    vi.useFakeTimers();
    try {
      const debug = buildSendableChannel();
      const repos = makeRepos({ listAll: vi.fn().mockResolvedValue(dbErr()) });
      const deps = makeDeps({ repos, listGuildIds: ['g1'], getChannel: () => debug.channel });
      const run = rebootAlarmJobs(deps);
      await vi.runAllTimersAsync();
      await run;
      expect(debug.send).toHaveBeenCalledWith(
        expect.stringContaining('alarm reboot listAll failed'),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createAlarmPlugin', () => {
  it('onReady runs to completion with an empty registry', async () => {
    const container = createContainer();
    container.registerSingleton(TOKENS.GuildRegistry, () => ({
      getRepos: () => undefined,
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [],
    }));
    container.registerSingleton(TOKENS.DiscordClient, () => ({ channels: {} }) as never);
    container.registerSingleton(TOKENS.JobMap, () => new Map());
    const ctx = buildPluginContext({ resolve: container.resolve.bind(container) });
    await expect(createAlarmPlugin().onReady?.(ctx)).resolves.toBeUndefined();
  });

  it('onReady swallows a reboot failure and logs it', async () => {
    const logger = silentLogger();
    const errorSpy = vi.spyOn(logger, 'error');
    const container = createContainer();
    container.registerSingleton(TOKENS.DiscordClient, () => {
      throw new Error('resolve boom');
    });
    const ctx = buildPluginContext({ logger, resolve: container.resolve.bind(container) });
    await expect(createAlarmPlugin().onReady?.(ctx)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});
