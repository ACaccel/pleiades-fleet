import { describe, expect, it } from 'vitest';
import { loadEnv, readCanvasFontDirectory } from '../../../../src/core/config/env';

describe('runtime-independent Canvas fonts', () => {
  it('uses explicitly configured font assets before Conda and Node locations', () => {
    expect(
      readCanvasFontDirectory(
        {
          PLEIADES_FONT_DIR: '/release/fonts',
          PLEIADES_CONDA_PREFIX: '/conda',
        },
        '/node/bin/node',
      ),
    ).toBe('/release/fonts');
    expect(readCanvasFontDirectory({ PLEIADES_CONDA_PREFIX: '/conda' }, '/node/bin/node')).toBe(
      '/conda/fonts',
    );
  });

  it('retains the legacy deployed Conda Node layout when no font override exists', () => {
    expect(readCanvasFontDirectory({}, '/legacy/.conda/bin/node')).toBe('/legacy/.conda/fonts');
  });

  it.each(['', 'relative/fonts'])('rejects an invalid explicit font directory: %s', (value) => {
    expect(() => readCanvasFontDirectory({ PLEIADES_FONT_DIR: value })).toThrow('must be absolute');
    expect(() =>
      loadEnv({
        source: {
          TOKEN: 'valid-token',
          CLIENT_ID: '123456789',
          PLEIADES_FONT_DIR: value,
        },
        requireDb: false,
        exitOnFailure: false,
      }),
    ).toThrow('PLEIADES_FONT_DIR must be absolute');
  });

  it('includes the font directory in the validated bot environment', () => {
    expect(
      loadEnv({
        source: {
          TOKEN: 'valid-token',
          CLIENT_ID: '123456789',
          PLEIADES_FONT_DIR: '/release/fonts',
        },
        requireDb: false,
        exitOnFailure: false,
      }).PLEIADES_FONT_DIR,
    ).toBe('/release/fonts');
  });
});
