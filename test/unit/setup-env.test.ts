import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;
let conda: string;
let invoked: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pleiades-env-setup-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(resolve('scripts/setup-env.sh'), join(root, 'scripts/setup-env.sh'));
  invoked = join(root, 'conda-invoked');
  conda = join(root, 'conda');
  writeFileSync(conda, `#!/bin/sh\ntouch '${invoked}'\nexit 1\n`, { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [join(root, 'scripts/setup-env.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONDA_EXE: conda,
      PLEIADES_CONDA_PREFIX: undefined,
      PLEIADES_NODE_PREFIX: undefined,
      ...overrides,
    },
  });
}

describe('runtime setup safety', () => {
  it.each(['current.json', 'transaction.json', 'lock'])(
    'refuses to change a managed or pending runtime: %s',
    (state) => {
      mkdirSync(join(root, '.deploy'));
      writeFileSync(join(root, '.deploy', state), '{}');
      const result = setup();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('undeploy managed bots');
      expect(existsSync(invoked)).toBe(false);
    },
  );

  it('preserves a legacy Conda runtime rather than pruning its Node.js', () => {
    const legacy = join(root, '.conda');
    mkdirSync(join(legacy, 'bin'), { recursive: true });
    writeFileSync(join(legacy, 'bin/node'), 'preserve');
    const result = setup({ PLEIADES_CONDA_PREFIX: legacy });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('new fonts-only PLEIADES_CONDA_PREFIX');
    expect(existsSync(invoked)).toBe(false);
  });

  it('refuses a configured existing Node prefix instead of changing it', () => {
    const result = setup({ PLEIADES_NODE_PREFIX: '/existing/runtime' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unset PLEIADES_NODE_PREFIX');
    expect(existsSync(invoked)).toBe(false);
  });

  it('fails clearly when no Conda executable is available', () => {
    const result = setup({ CONDA_EXE: join(root, 'missing') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Conda is required');
  });
});
