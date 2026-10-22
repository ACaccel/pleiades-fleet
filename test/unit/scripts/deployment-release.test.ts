import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Host from '../../../scripts/deployment/host';
import { makeRelease, validatePrefix } from '../../../scripts/deployment/release';
import type { DeploymentConfig } from '../../../scripts/deployment/config';

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../scripts/deployment/host', async (original) => ({
  ...(await original<typeof Host>()),
  run: commands.run,
}));

let root: string;
let config: DeploymentConfig;
function file(relative: string, content = ''): string {
  const filename = join(root, relative);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, content);
  return filename;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pleiades-release-'));
  vi.stubEnv('PLEIADES_CONDA_PREFIX', join(root, '.conda-fonts'));
  file('.nvmrc', '22.23.4');
  file(
    '.conda/.pleiades-runtime.json',
    JSON.stringify({
      version: '22.23.4',
      npmVersion: '10.9.2',
      source: `https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-${process.arch}.tar.xz`,
      sha256: 'a'.repeat(64),
    }),
  );
  file('.conda/lib/node_modules/npm/bin/npm-cli.js');
  file('.conda/conda-meta/history');
  file('.conda/bin/node');
  file('.conda-fonts/fonts/NotoSansCJKtc-VF.ttf', 'font fixture');
  file('src/bot/tomori/index.ts', 'export const revision = 1;');
  file(
    'src/bot/tomori/.env',
    'TOKEN=valid-token\nCLIENT_ID=123456\nMONGO_URI=mongodb://localhost/test\n',
  );
  file('src/bot/tomori/config.json', '{}');
  for (const name of ['package.json', 'tsconfig.json']) file(name, '{}');
  file('package-lock.json');
  file('scripts/mongo-ready.ts', 'export {};');
  file('scripts/deployment/mongo-probe.ts', 'export {};');
  file('node_modules/test-package/index.js', 'module.exports = 1;');
  config = {
    user: 'operator',
    bots: ['tomori'],
    runtimePrefix: join(root, '.conda'),
    readinessTimeoutSeconds: 120,
  };
  commands.run.mockReset();
  commands.run.mockImplementation((program: string, args: string[]) => {
    if (program.endsWith('/node') && args[0] === '--version') return 'v22.23.4';
    if (program.endsWith('/node') && args[0]?.endsWith('npm-cli.js')) return '10.9.2';
    if (program.endsWith('/mongod')) return 'db version v7.0.34';
    if (program === 'git') return 'src/bot/tomori/.env\0src/bot/tomori/config.json\0';
    if (program === 'cp') cpSync(args[3]!, args[4]!, { recursive: true });
    return '';
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('release preparation', () => {
  it('prepares gopher with only Discord credentials and no database or HTTP port', () => {
    config.bots = ['gopher'];
    file('src/bot/gopher/index.ts', 'export {};');
    file('src/bot/gopher/.env', 'TOKEN=valid-token\nCLIENT_ID=123456\n');
    file('src/bot/gopher/config.json', '{}');

    const release = makeRelease(root, config, false);

    expect(release.units['pleiades@gopher.service']).toContain('src/bot/gopher/index.ts');
    expect(release.units['pleiades@gopher.service']).not.toContain('mongo-ready');
  });

  it('validates and generates only the targeted bot', () => {
    // nijika's invalid settings must not block a tomori-only release.
    config.bots = ['tomori', 'nijika'];
    file('src/bot/nijika/config.json', 'not json');

    const release = makeRelease(root, config, false, 'tomori');

    expect(Object.keys(release.units)).toEqual(['pleiades@tomori.service']);
    expect(() => makeRelease(root, config, false)).toThrow('Missing local env for nijika');
  });

  it('rejects nijika with an earthquake alert port but no key', () => {
    config.bots = ['nijika'];
    file(
      'src/bot/nijika/.env',
      'TOKEN=valid-token\nCLIENT_ID=123456\nMONGO_URI=mongodb://localhost/test\nEARTHQUAKE_ALERT_PORT=4000\n',
    );
    file('src/bot/nijika/config.json', '{}');

    expect(() => makeRelease(root, config, false)).toThrow('EARTHQUAKE_ALERT_KEY');
    expect(readdirSync(join(root, '.deploy/releases'))).toEqual([]);
  });

  it('freezes application code and dependencies while retaining shared local settings', () => {
    const release = makeRelease(root, config, false);
    file('src/bot/tomori/index.ts', 'export const revision = 2;');
    file('node_modules/test-package/index.js', 'module.exports = 2;');
    file('src/bot/tomori/config.json', '{"language":"en"}');
    expect(readFileSync(join(release.directory, 'src/bot/tomori/index.ts'), 'utf8')).toContain(
      'revision = 1',
    );
    expect(
      readFileSync(join(release.directory, 'node_modules/test-package/index.js'), 'utf8'),
    ).toContain('exports = 1');
    expect(lstatSync(join(release.directory, 'src/bot/tomori/.env')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(release.directory, 'data')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(release.directory, 'logs')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(release.directory, 'errors'))).toBe(false);
    expect(readFileSync(join(release.directory, 'src/bot/tomori/config.json'), 'utf8')).toBe(
      '{"language":"en"}',
    );
    expect(release.units['pleiades@tomori.service']).toContain(
      join(release.directory, 'runtime/bin/node'),
    );
    expect(readFileSync(join(release.directory, 'fonts/NotoSansCJKtc-VF.ttf'), 'utf8')).toBe(
      'font fixture',
    );
    expect(
      commands.run.mock.calls.some(([, args]) =>
        args.includes(
          "require('ts-node/register'); require('./src/infra/graphics/canvas-font').ensureCanvasFont(); require('tsconfig-paths'); require('./src/i18n/locales/en/commands.json')",
        ),
      ),
    ).toBe(true);
  });
  it('pins official runtime metadata and preserves relative npm links in snapshots', () => {
    symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(root, '.conda/bin/npm'));
    const release = makeRelease(root, config, false);
    expect(readlinkSync(join(release.prefix, 'bin/npm'))).toBe(
      '../lib/node_modules/npm/bin/npm-cli.js',
    );
    file(
      '.conda/.pleiades-runtime.json',
      JSON.stringify({
        version: '22.13.0',
        npmVersion: '10.9.2',
        source: 'https://nodejs.org/dist/v22.13.0/node-v22.13.0-linux-x64.tar.xz',
        sha256: 'a'.repeat(64),
      }),
    );
    expect(() => makeRelease(root, config, false)).toThrow('runtime metadata');
  });
  it('rejects missing settings and removes the incomplete release', () => {
    rmSync(join(root, 'src/bot/tomori/config.json'));
    expect(() => makeRelease(root, config, false)).toThrow('Missing config.json');
    expect(readdirSync(join(root, '.deploy/releases'))).toEqual([]);
  });
  it('rejects missing runtime and unsupported activation hooks', () => {
    expect(() => validatePrefix(join(root, 'missing'), 'node')).toThrow('Missing Conda runtime');
    file('.conda/etc/conda/activate.d/custom.sh', 'export REQUIRED_VALUE=1');
    expect(() => validatePrefix(join(root, '.conda'), 'node')).toThrow('activation hooks');
    expect(existsSync(join(root, '.deploy/releases'))).toBe(false);
  });
  it('rejects invalid local archive configuration before copying dependencies or stopping services', () => {
    config.bots = ['msg-archive'];
    file(
      'src/bot/msg-archive/.env',
      'TOKEN=valid-token\nCLIENT_ID=123456\nMONGO_URI=mongodb://localhost/test\n',
    );
    file(
      'src/bot/msg-archive/config.json',
      JSON.stringify({
        backup_server: ['1'],
        archive_runtime: { concurrency: 0 },
      }),
    );
    expect(() => makeRelease(root, config, false)).toThrow('Invalid config.json for msg-archive');
    expect(readdirSync(join(root, '.deploy/releases'))).toEqual([]);
    expect(
      commands.run.mock.calls.some(([program]) => ['cp', 'sudo', 'systemctl'].includes(program)),
    ).toBe(false);
  });
  it('removes the incomplete release when systemd validation fails', () => {
    commands.run.mockImplementation((program: string, args: string[]) => {
      if (program.endsWith('/node') && args[0] === '--version') return 'v22.23.4';
      if (program.endsWith('/node') && args[0]?.endsWith('npm-cli.js')) return '10.9.2';
      if (program === 'systemd-analyze') throw new Error('Invalid unit');
      return '';
    });
    expect(() => makeRelease(root, config, false)).toThrow('Invalid unit');
    expect(readdirSync(join(root, '.deploy/releases'))).toEqual([]);
  });
});

describe('MongoDB service preparation', () => {
  it('preserves original configuration and database contents while generating foreground configuration', () => {
    const prefix = join(root, 'mongo-runtime');
    file('mongo-runtime/conda-meta/history');
    file('mongo-runtime/bin/mongod');
    const marker = file('database/data/sentinel', 'existing data');
    const original = {
      storage: { dbPath: dirname(marker) },
      security: { authorization: 'enabled' },
      net: { bindIp: '127.0.0.1', port: 27017 },
      processManagement: { fork: true, pidFilePath: join(root, 'database/mongod.pid') },
    };
    const originalText = JSON.stringify(original);
    const configFile = file('database/mongod.conf', originalText);
    config.mongodb = { prefix, configFile, probeEnvFile: join(root, 'src/bot/tomori/.env') };
    const release = makeRelease(root, config, true);
    expect(readFileSync(configFile, 'utf8')).toBe(originalText);
    expect(readFileSync(join(release.directory, 'mongod.original.conf'), 'utf8')).toBe(
      originalText,
    );
    expect(readFileSync(marker, 'utf8')).toBe('existing data');
    expect(JSON.parse(readFileSync(join(release.directory, 'mongod.conf'), 'utf8'))).toEqual({
      ...original,
      processManagement: { fork: false },
    });
    expect(release.units['mongodb-pleiades.service']).toContain(join(prefix, 'bin/mongod'));
    expect(
      commands.run.mock.calls.some(([program]) => program === 'sudo' || program === 'systemctl'),
    ).toBe(false);
  });
});
