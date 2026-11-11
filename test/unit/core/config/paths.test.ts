import { describe, expect, it } from 'vitest';

import {
  readBotConfigFile,
  readDataDirectory,
  readLogDirectory,
} from '../../../../src/core/config/paths';
import { loadEnv } from '../../../../src/core/config/env';

describe('deployment paths', () => {
  it('keeps the working-directory defaults when nothing is configured', () => {
    expect(readDataDirectory({})).toBe('data');
    expect(readLogDirectory({})).toBe('logs');
    expect(readBotConfigFile('/release/src/bot/x/config.json', {})).toBe(
      '/release/src/bot/x/config.json',
    );
  });

  it('uses the configured absolute locations', () => {
    expect(readDataDirectory({ PLEIADES_DATA_DIR: '/var/lib/pleiades' })).toBe('/var/lib/pleiades');
    expect(readLogDirectory({ LOG_DIR: '/var/log/pleiades' })).toBe('/var/log/pleiades');
    expect(readBotConfigFile('/fallback', { PLEIADES_CONFIG_FILE: '/etc/p/konata.json' })).toBe(
      '/etc/p/konata.json',
    );
  });

  it('falls back to the default log directory when LOG_DIR is blank', () => {
    expect(readLogDirectory({ LOG_DIR: '  ' })).toBe('logs');
  });

  it.each(['', 'relative/dir'])('rejects a non-absolute data directory: %j', (value) => {
    expect(() => readDataDirectory({ PLEIADES_DATA_DIR: value })).toThrow('must be absolute');
  });

  it.each(['', 'config.json'])('rejects a non-absolute config file: %j', (value) => {
    expect(() => readBotConfigFile('/fallback', { PLEIADES_CONFIG_FILE: value })).toThrow(
      'must be absolute',
    );
  });

  it('validates the same variables in the typed env', () => {
    const base = { TOKEN: 'valid-token', CLIENT_ID: '123456789', MONGO_URI: 'mongodb://db:27017' };
    for (const key of ['PLEIADES_DATA_DIR', 'PLEIADES_CONFIG_FILE']) {
      expect(() =>
        loadEnv({ exitOnFailure: false, source: { ...base, [key]: 'relative' } }),
      ).toThrow(key);
      expect(
        loadEnv({ exitOnFailure: false, source: { ...base, [key]: '/abs/path' } }),
      ).toMatchObject({ [key]: '/abs/path' });
    }
  });
});
