import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, 'bootstrap.sh');
let directory: string;
let prefix: string;
let log: string;
let runtime: string;
let nodeArchive: string;
let nodeAsset: string;
let nodeChecksum: string;
let nodeCurl: string;
const runtimeContents = `MONGODB_VERSION=7.0.34
MONGO_TOOLS_VERSION=100.13.0
NODE_VERSION=22.13.0
NPM_VERSION=10.9.2
MONGOSH_VERSION=2.10.0
`;

function run(extra: string[] = [], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    'bash',
    [script, '--prefix', prefix, '--env', 'dc', '--runtime', runtime, ...extra],
    {
      encoding: 'utf8',
      env: {
        PATH: `${path.dirname(nodeCurl)}:/usr/bin:/bin`,
        HOME: directory,
        BOOTSTRAP_TEST_LOG: log,
        BOOTSTRAP_TEST_NODE_ARCHIVE: nodeArchive,
        BOOTSTRAP_TEST_NODE_ASSET: nodeAsset,
        BOOTSTRAP_TEST_NODE_CHECKSUM: nodeChecksum,
        BOOTSTRAP_TEST_NODE_CURL: nodeCurl,
        BOOTSTRAP_TEST_NODE_DOWNLOAD_LOG: path.join(directory, 'node-downloads.log'),
        ...environment,
      },
    },
  );
}

const condaStub = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$BOOTSTRAP_TEST_LOG"
if [[ "$1" == create || "$1" == install ]]; then
  if [[ "$*" == *--dry-run* && "\${BOOTSTRAP_TEST_SOLVER_FAIL:-}" == 1 ]]; then exit 42; fi
  if [[ "$*" != *--dry-run* ]]; then
    mkdir -p "$3/bin" "$3/conda-meta"
    touch "$3/conda-meta/history"
  fi
  exit 0
fi
if [[ "$1" == run ]]; then
  shift 3
  if [[ "$1" == --no-capture-output ]]; then shift; fi
  case "$1" in
    python) exit "\${BOOTSTRAP_TEST_METADATA_EXIT:-0}" ;;
    */node) printf 'v%s\\n' "\${BOOTSTRAP_TEST_NODE_VERSION:-22.13.0}" ;;
    */npm) printf '10.9.2\\n' ;;
    */mongosh) printf '%s\\n' "\${BOOTSTRAP_TEST_MONGOSH_VERSION:-2.10.0}" ;;
  esac
fi
`;

function officialNodeFixture(version = '22.13.0'): void {
  const name = `node-v${version}-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const source = path.join(directory, `archive-${version}`);
  const root = path.join(source, name);
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  mkdirSync(path.join(root, 'lib/node_modules/npm/bin'), { recursive: true });
  writeFileSync(
    path.join(root, 'bin/node'),
    `#!/usr/bin/env bash
set -eu
if [[ "$1" == --version ]]; then printf 'v${version}\\n'
elif [[ "\${*: -1}" == --version ]]; then printf '10.9.2\\n'
else printf 'official-node %s\\n' "$*" >> "$BOOTSTRAP_TEST_LOG"
fi
`,
    { mode: 0o700 },
  );
  for (const [binary, cli] of [
    ['npm', 'npm-cli.js'],
    ['npx', 'npx-cli.js'],
  ]) {
    writeFileSync(
      path.join(root, 'lib/node_modules/npm/bin', cli!),
      '#!/usr/bin/env bash\nprintf "10.9.2\\n"\n',
      { mode: 0o700 },
    );
    symlinkSync(`../lib/node_modules/npm/bin/${cli}`, path.join(root, 'bin', binary!));
  }
  nodeAsset = `${name}.tar.xz`;
  nodeArchive = path.join(directory, nodeAsset);
  const result = spawnSync('tar', ['-cJf', nodeArchive, '-C', source, name], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  nodeChecksum = createHash('sha256').update(readFileSync(nodeArchive)).digest('hex');
}

const nodeDownloadStub = `#!/usr/bin/env bash
set -eu
while [[ "$1" != --output ]]; do shift; done
output=$2
url=$3
printf '%s\\n' "$url" >> "$BOOTSTRAP_TEST_NODE_DOWNLOAD_LOG"
[[ "$url" == https://nodejs.org/dist/v* ]] || exit 98
if [[ "$url" == */SHASUMS256.txt ]]; then
  case "\${BOOTSTRAP_TEST_NODE_CHECKSUM_MODE:-valid}" in
    valid) printf '%s  %s\\n' "$BOOTSTRAP_TEST_NODE_CHECKSUM" "$BOOTSTRAP_TEST_NODE_ASSET" > "$output" ;;
    duplicate) printf '%s  %s\\n%s  %s\\n' "$BOOTSTRAP_TEST_NODE_CHECKSUM" "$BOOTSTRAP_TEST_NODE_ASSET" "$BOOTSTRAP_TEST_NODE_CHECKSUM" "$BOOTSTRAP_TEST_NODE_ASSET" > "$output" ;;
    wrong-name) printf '%s  wrong.tar.xz\\n' "$BOOTSTRAP_TEST_NODE_CHECKSUM" > "$output" ;;
    mismatch) printf '%064d  %s\\n' 0 "$BOOTSTRAP_TEST_NODE_ASSET" > "$output" ;;
  esac
else
  [[ "\${url##*/}" == "$BOOTSTRAP_TEST_NODE_ASSET" ]] || exit 97
  cp "$BOOTSTRAP_TEST_NODE_ARCHIVE" "$output"
fi
`;

function existingConda(withEnvironment = false): void {
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  mkdirSync(path.join(prefix, 'conda-meta'), { recursive: true });
  writeFileSync(path.join(prefix, 'conda-meta/history'), '');
  writeFileSync(path.join(prefix, 'bin/conda'), condaStub, { mode: 0o700 });
  if (withEnvironment) {
    mkdirSync(path.join(prefix, 'envs/dc/conda-meta'), { recursive: true });
    writeFileSync(path.join(prefix, 'envs/dc/conda-meta/history'), '');
  }
}

describe('migration bootstrap', () => {
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'pleiades-bootstrap-'));
    prefix = path.join(directory, 'conda runtime');
    log = path.join(directory, 'commands.log');
    runtime = path.join(directory, 'runtime.conf');
    writeFileSync(runtime, runtimeContents);
    officialNodeFixture();
    const downloads = path.join(directory, 'node-download-bin');
    mkdirSync(downloads);
    nodeCurl = path.join(downloads, 'curl');
    writeFileSync(nodeCurl, nodeDownloadStub, { mode: 0o700 });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('prints a plan without creating a prefix or executing conda', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Plan only');
    expect(existsSync(prefix)).toBe(false);
    expect(existsSync(log)).toBe(false);
    existingConda(true);
    expect(run().status).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  it.each([
    ['--prefix', '/'],
    ['--env', 'base'],
    ['--env', '../other'],
    ['--node-version', 'latest'],
    ['--npm-version', 'latest'],
    ['--miniforge-version', 'latest'],
    ['--installer-sha256', 'invalid'],
  ])('rejects invalid %s before mutations', (flag, value) => {
    const result = run([flag, value, '--apply']);
    expect(result.status).not.toBe(0);
    expect(existsSync(prefix)).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  it.each([
    runtimeContents.replace('22.13.0', 'latest'),
    runtimeContents.replace('10.9.2', 'latest'),
    runtimeContents + 'NODE_VERSION=22.13.0\n',
    runtimeContents.replace('MONGOSH_VERSION=2.10.0\n', ''),
    runtimeContents + 'UNKNOWN=1.2.3\n',
    runtimeContents + 'NODE_VERSION=$(touch marker)\n',
  ])('rejects malformed runtime data without executing it', (contents) => {
    writeFileSync(runtime, contents);
    expect(run(['--apply']).status).not.toBe(0);
    expect(existsSync(prefix)).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  it('defaults the installation prefix to the home directory', () => {
    const result = spawnSync('bash', [script, '--env', 'dc', '--runtime', runtime], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: directory },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(path.join(directory, 'miniforge3'));
    expect(result.stdout).toContain(' rsync git python');
  });

  it('shows help without a runtime file and rejects a missing runtime otherwise', () => {
    expect(run(['--help']).status).toBe(0);
    rmSync(runtime);
    expect(run().stderr).toContain('Runtime file is missing');
  });

  it('refuses unrelated prefix and environment directories', () => {
    mkdirSync(prefix);
    expect(run(['--apply']).stderr).toContain('not a conda installation');
    existingConda();
    mkdirSync(path.join(prefix, 'envs/dc'), { recursive: true });
    expect(run(['--apply']).stderr).toContain('not a conda environment');
    expect(existsSync(log)).toBe(false);
  });

  it('rejects a corrupt installer before executing it', () => {
    const installer = path.join(directory, 'installer.sh');
    writeFileSync(installer, 'exit 99\n');
    const result = run(['--installer', installer, '--installer-sha256', 'a'.repeat(64), '--apply']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum mismatch');
    expect(existsSync(prefix)).toBe(false);
  });

  it('bootstraps from a checksum-verified local installer without conda on PATH', () => {
    const stub = path.join(directory, 'conda-stub');
    writeFileSync(stub, condaStub, { mode: 0o700 });
    const contents = `set -eu
[[ "$1" == -b && "$2" == -p ]]
mkdir -p "$3/bin" "$3/conda-meta"
cp "$BOOTSTRAP_TEST_CONDA" "$3/bin/conda"
touch "$3/conda-meta/history"
`;
    const installer = path.join(directory, 'installer.sh');
    writeFileSync(installer, contents);
    const checksum = createHash('sha256').update(contents).digest('hex');
    const result = run(['--installer', installer, '--installer-sha256', checksum, '--apply'], {
      BOOTSTRAP_TEST_CONDA: stub,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Runtime verified');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('create --prefix');
    expect(calls).toContain('--dry-run');
    expect(calls).toContain('mongodb=7.0.34 mongo-tools=100.13.0');
    expect(calls).not.toContain('nodejs=');
    expect(calls).toContain('npm@10.9.2');
    expect(calls).toContain('mongosh@2.10.0');
    expect(calls).toContain('cairo pango libjpeg-turbo giflib librsvg');
    expect(calls).not.toMatch(/\bffmpeg\b/);
  });

  it.each(['valid', 'valid-relative', 'wrong-name', 'wrong-directory', 'malformed', 'mismatch'])(
    'validates automatically downloaded checksum: %s',
    (mode) => {
      const bin = path.join(directory, 'download-bin');
      mkdirSync(bin);
      const installer = path.join(directory, 'installer.sh');
      const stub = path.join(directory, 'conda-stub');
      writeFileSync(stub, condaStub, { mode: 0o700 });
      const contents = `set -eu
mkdir -p "$3/bin" "$3/conda-meta"
cp "$BOOTSTRAP_TEST_CONDA" "$3/bin/conda"
touch "$3/conda-meta/history"
`;
      writeFileSync(installer, contents);
      const checksum = createHash('sha256').update(contents).digest('hex');
      writeFileSync(
        path.join(bin, 'curl'),
        `#!/usr/bin/env bash
set -eu
if [[ "\${*: -1}" == https://nodejs.org/* ]]; then exec "$BOOTSTRAP_TEST_NODE_CURL" "$@"; fi
while [[ "$1" != --output ]]; do shift; done
output=$2
url=$3
printf '%s\\n' "$url" >> "$BOOTSTRAP_TEST_DOWNLOAD_LOG"
if [[ "$url" == *.sha256 ]]; then
  asset=\${url##*/}
  asset=\${asset%.sha256}
  case "$BOOTSTRAP_TEST_CHECKSUM_MODE" in
    valid) printf '%s  %s\\n' "$BOOTSTRAP_TEST_CHECKSUM" "$asset" > "$output" ;;
    valid-relative) printf '%s  ./%s\\n' "$BOOTSTRAP_TEST_CHECKSUM" "$asset" > "$output" ;;
    wrong-name) printf '%s  wrong.sh\\n' "$BOOTSTRAP_TEST_CHECKSUM" > "$output" ;;
    wrong-directory) printf '%s  ../%s\\n' "$BOOTSTRAP_TEST_CHECKSUM" "$asset" > "$output" ;;
    malformed) printf 'malformed\\n' > "$output" ;;
    mismatch) printf '%064d  %s\\n' 0 "$asset" > "$output" ;;
  esac
else
  cp "$BOOTSTRAP_TEST_INSTALLER" "$output"
fi
`,
        { mode: 0o700 },
      );
      const downloadLog = path.join(directory, 'downloads.log');
      const result = run(['--apply'], {
        PATH: `${bin}:/usr/bin:/bin`,
        BOOTSTRAP_TEST_INSTALLER: installer,
        BOOTSTRAP_TEST_CONDA: stub,
        BOOTSTRAP_TEST_CHECKSUM: checksum,
        BOOTSTRAP_TEST_CHECKSUM_MODE: mode,
        BOOTSTRAP_TEST_DOWNLOAD_LOG: downloadLog,
      });
      const valid = mode === 'valid' || mode === 'valid-relative';
      expect(result.status, result.stderr).toBe(valid ? 0 : 1);
      expect(existsSync(prefix)).toBe(valid);
      expect(readFileSync(downloadLog, 'utf8')).toMatch(
        /https:\/\/github.com\/conda-forge\/miniforge\/releases\/download\/26\.5\.3-0\/Miniforge3-26\.5\.3-0-Linux-(x86_64|aarch64)\.sh\.sha256/,
      );
    },
  );

  it('updates existing environments only after a successful solver dry-run', () => {
    existingConda(true);
    const result = run(['--apply'], { BOOTSTRAP_TEST_SOLVER_FAIL: '1' });
    expect(result.status).toBe(42);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('install --prefix');
    expect(calls).toContain('--dry-run');
    expect(calls).not.toContain('--yes');
    expect(calls).not.toContain('npm install');
  });

  it.each(['conda-metadata', 'regular-node', 'external-node-link'])(
    'preserves a legacy environment before any Conda mutation: %s',
    (mode) => {
      existingConda(true);
      const environment = path.join(prefix, 'envs/dc');
      mkdirSync(path.join(environment, 'bin'));
      if (mode === 'conda-metadata')
        writeFileSync(path.join(environment, 'conda-meta/nodejs-22.13.0-0.json'), '{}');
      else if (mode === 'regular-node')
        writeFileSync(path.join(environment, 'bin/node'), 'synthetic legacy Node.js', {
          mode: 0o700,
        });
      else symlinkSync('/usr/bin/node', path.join(environment, 'bin/node'));
      const result = run(['--apply']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fresh recovery environment');
      expect(existsSync(log)).toBe(false);
      expect(existsSync(path.join(directory, 'node-downloads.log'))).toBe(false);
      if (mode === 'regular-node')
        expect(readFileSync(path.join(environment, 'bin/node'), 'utf8')).toBe(
          'synthetic legacy Node.js',
        );
    },
  );

  it('uses the exact official security runtime even before Conda publishes it', () => {
    officialNodeFixture('22.23.4');
    writeFileSync(runtime, runtimeContents.replace('22.13.0', '22.23.4'));
    existingConda();
    const result = run(['--apply'], { BOOTSTRAP_TEST_NODE_VERSION: '22.23.4' });
    expect(result.status, result.stderr).toBe(0);
    const environment = path.join(prefix, 'envs/dc');
    const installed = path.join(environment, '.node-runtime', nodeAsset.replace(/\.tar\.xz$/, ''));
    expect(readlinkSync(path.join(environment, 'bin/node'))).toBe(path.join(installed, 'bin/node'));
    expect(readlinkSync(path.join(environment, 'bin/npm'))).toBe(path.join(installed, 'bin/npm'));
    expect(readlinkSync(path.join(environment, 'bin/npx'))).toBe(path.join(installed, 'bin/npx'));
    expect(
      JSON.parse(readFileSync(path.join(installed, '.pleiades-runtime.json'), 'utf8')),
    ).toMatchObject({
      version: '22.23.4',
      npmVersion: '10.9.2',
      sha256: nodeChecksum,
    });
    expect(readFileSync(log, 'utf8')).not.toContain('nodejs=');
    expect(readFileSync(path.join(directory, 'node-downloads.log'), 'utf8')).toContain(
      'https://nodejs.org/dist/v22.23.4/',
    );
  });

  it.each(['duplicate', 'wrong-name', 'mismatch'])(
    'rejects an untrusted official Node.js checksum: %s',
    (mode) => {
      existingConda();
      const result = run(['--apply'], { BOOTSTRAP_TEST_NODE_CHECKSUM_MODE: mode });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        mode === 'mismatch' ? 'archive checksum mismatch' : 'no unique matching archive',
      );
      expect(existsSync(path.join(prefix, 'envs/dc/bin/node'))).toBe(false);
      expect(readFileSync(log, 'utf8')).not.toContain('mongosh@');
    },
  );

  it('reuses its verified versioned runtime without another Node.js download', () => {
    existingConda();
    expect(run(['--apply']).status).toBe(0);
    const downloadLog = path.join(directory, 'node-downloads.log');
    const previous = readFileSync(downloadLog, 'utf8');
    expect(run(['--apply']).status).toBe(0);
    expect(readFileSync(downloadLog, 'utf8')).toBe(previous);
  });

  it('rejects unexpected archive paths even when the official manifest checksum matches', () => {
    existingConda();
    const source = path.join(directory, 'unexpected-archive');
    mkdirSync(source);
    writeFileSync(path.join(source, 'outside-node-prefix'), 'synthetic content');
    expect(
      spawnSync('tar', ['-cJf', nodeArchive, '-C', source, 'outside-node-prefix']).status,
    ).toBe(0);
    nodeChecksum = createHash('sha256').update(readFileSync(nodeArchive)).digest('hex');
    const result = run(['--apply']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unexpected path in Node.js archive');
    expect(existsSync(path.join(prefix, 'envs/dc/bin/node'))).toBe(false);
  });

  it('rejects mismatched installed conda metadata', () => {
    existingConda(true);
    const result = run(['--apply'], { BOOTSTRAP_TEST_METADATA_EXIT: '6' });
    expect(result.status).toBe(6);
    expect(result.stdout).not.toContain('Runtime verified');
  });

  it('rejects an executable version mismatch even when installation succeeds', () => {
    existingConda(true);
    const result = run(['--apply'], { BOOTSTRAP_TEST_MONGOSH_VERSION: '2.9.0' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Version verification failed: mongosh');
    expect(result.stdout).not.toContain('Runtime verified');
  });
});
