/* eslint-disable import/first */
/**
 * Entry-point sequencing: the MongoDB wait precedes the personality's
 * construction and Discord login, and its failure exits for the supervisor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/infra/mongo/ready', () => ({ waitForMongoReady: vi.fn() }));
vi.mock('../../../src/bot/bot-files', () => ({
  loadBotEnvFile: vi.fn(),
  loadBotConfig: vi.fn(() => ({})),
}));

import { bootstrapPersonality } from '../../../src/bot/bootstrap';
import { waitForMongoReady } from '../../../src/infra/mongo/ready';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const baseEnv = {
  TOKEN: 'valid-bot-token',
  CLIENT_ID: '123456789012345678',
  MONGO_URI: 'mongodb://db.internal:27017',
};

const setup = (env: Record<string, string>) => {
  for (const [key, value] of Object.entries({ ...baseEnv, ...env })) vi.stubEnv(key, value);
  const order: string[] = [];
  const run = vi.fn(async () => {
    order.push('run');
  });
  const build = vi.fn(() => {
    order.push('build');
    return { run, logger: undefined };
  });
  return { order, run, build };
};

describe('bootstrapPersonality', () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  beforeEach(() => {
    vi.mocked(waitForMongoReady).mockReset().mockResolvedValue(undefined);
    exit.mockClear();
    stderr.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('waits for MongoDB before building and running the personality', async () => {
    const { order, build } = setup({ MONGO_READY_TIMEOUT_SECONDS: '45' });
    vi.mocked(waitForMongoReady).mockImplementation(async () => {
      order.push('wait');
    });

    bootstrapPersonality({ name: 'tomori', intents: [], build });
    await settle();

    expect(waitForMongoReady).toHaveBeenCalledWith(baseEnv.MONGO_URI, 45, expect.any(Object));
    expect(order).toEqual(['wait', 'build', 'run']);
    expect(exit).not.toHaveBeenCalled();
  });

  it('defaults the wait to 120 seconds', async () => {
    const { build } = setup({});
    bootstrapPersonality({ name: 'tomori', intents: [], build });
    await settle();
    expect(waitForMongoReady).toHaveBeenCalledWith(baseEnv.MONGO_URI, 120, expect.any(Object));
  });

  it('skips the wait when it is set to 0', async () => {
    const { build, run } = setup({ MONGO_READY_TIMEOUT_SECONDS: '0' });
    bootstrapPersonality({ name: 'tomori', intents: [], build });
    await settle();
    expect(waitForMongoReady).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it('skips the wait for a personality without a required database', async () => {
    const { build, run } = setup({});
    bootstrapPersonality({ name: 'gopher', intents: [], env: { requireDb: false }, build });
    await settle();
    expect(waitForMongoReady).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it('exits 1 without building the personality when MongoDB never becomes ready', async () => {
    const { build } = setup({});
    vi.mocked(waitForMongoReady).mockRejectedValue(new Error('MongoDB did not become ready'));

    bootstrapPersonality({ name: 'tomori', intents: [], build });
    await settle();

    expect(build).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('MongoDB did not become ready'));
  });
});
