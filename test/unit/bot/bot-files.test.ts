import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadBotConfig, loadBotEnvFile } from '../../../src/bot/bot-files';
import { loadEnv } from '../../../src/core/config/env';

describe('bot files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bot-files-'));
  });
  afterEach(() => {
    delete process.env.PLEIADES_CONFIG_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the config from PLEIADES_CONFIG_FILE', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ commands: ['help'] }));
    process.env.PLEIADES_CONFIG_FILE = file;
    expect(loadBotConfig('konata')).toEqual({ commands: ['help'] });
  });

  it('falls back to the file beside the bot entry point', () => {
    // CI seeds src/bot/<name>/config.json from the example; the fallback must find it.
    expect(loadBotConfig<{ commands: unknown }>('gopher')).toHaveProperty('commands');
  });

  it('names the file when the config is missing, malformed or not an object', () => {
    process.env.PLEIADES_CONFIG_FILE = join(dir, 'missing.json');
    expect(() => loadBotConfig('konata')).toThrow(/konata from .*missing\.json/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{');
    process.env.PLEIADES_CONFIG_FILE = bad;
    expect(() => loadBotConfig('konata')).toThrow(/bad\.json/);
    writeFileSync(bad, '[]');
    expect(() => loadBotConfig('konata')).toThrow('must be a JSON object');
  });

  it('treats a missing .env file as absent so process env alone can satisfy the schema', () => {
    expect(() => loadBotEnvFile('does-not-exist')).not.toThrow();
    const env = loadEnv({
      exitOnFailure: false,
      source: {
        TOKEN: 'valid-bot-token',
        CLIENT_ID: '123456789012345678',
        MONGO_URI: 'mongodb://db.internal:27017',
      },
    });
    expect(env.TOKEN).toBe('valid-bot-token');
  });
});
