import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const installer = pathToFileURL(resolve('scripts/setup-node.mjs')).href;
let root: string;
const name = 'node-v22.23.4-linux-x64';
let archive: string;

function install(overrides = '', corruptChecksum = false, failDownload = false) {
  const harness = `import { copyFile, writeFile } from 'node:fs/promises';
import { installNode } from ${JSON.stringify(installer)};
const fixture = ${JSON.stringify(archive)};
try {
  const result = await installNode({root:${JSON.stringify(root)},platform:'linux',arch:'x64',
    download:async (url, destination) => {
      if (${failDownload}) throw new Error('fixture download failed');
      if (url.pathname.endsWith('SHASUMS256.txt')) await writeFile(destination, ${JSON.stringify(`${corruptChecksum ? '0'.repeat(64) : createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${name}.tar.xz\n`)});
      else await copyFile(fixture, destination);
    }, ${overrides}});
  console.log(result);
} catch (error) { console.error(error.message); process.exitCode=1; }`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', harness], {
    encoding: 'utf8',
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pleiades-node-setup-'));
  writeFileSync(join(root, '.nvmrc'), '22.23.4\n');
  const fixture = join(root, 'fixture', name);
  mkdirSync(join(fixture, 'bin'), { recursive: true });
  mkdirSync(join(fixture, 'lib/node_modules/npm/bin'), { recursive: true });
  writeFileSync(
    join(fixture, 'bin/node'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo v22.23.4;
elif [ "$2" = "--version" ]; then echo 10.9.2;
else exit 0; fi
`,
    { mode: 0o755 },
  );
  writeFileSync(join(fixture, 'lib/node_modules/npm/bin/npm-cli.js'), 'fixture');
  archive = join(root, 'fixture.tar.xz');
  const tar = spawnSync('tar', ['-cJf', archive, '-C', join(root, 'fixture'), name]);
  if (tar.status !== 0) throw new Error('Unable to create Node archive fixture');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('official Node.js setup', () => {
  it('uses only official HTTPS URLs and rejects HTTP download failures without publishing', () => {
    const harness = `import { installNode } from ${JSON.stringify(installer)};
    globalThis.fetch = async (url, options) => {
      if (url.href !== 'https://nodejs.org/dist/v22.23.4/SHASUMS256.txt' || options.redirect !== 'error' || !options.signal) throw new Error('Unsafe request');
      return { ok:false, status:503 };
    };
    try { await installNode({root:${JSON.stringify(root)},platform:'linux',arch:'x64'}); }
    catch (error) { console.error(error.message); process.exitCode=1; }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Node.js download failed (503)');
    expect(readdirSync(join(root, '.runtime'))).toEqual([]);
  });

  it('verifies the archive and atomically publishes a complete reusable runtime', () => {
    const result = install();
    expect(result.status).toBe(0);
    const destination = join(root, '.runtime', name);
    expect(result.stdout.trim()).toBe(destination);
    expect(existsSync(join(destination, 'bin/node'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(destination, '.pleiades-runtime.json'), 'utf8')),
    ).toMatchObject({
      version: '22.23.4',
      npmVersion: '10.9.2',
      source: `https://nodejs.org/dist/v22.23.4/${name}.tar.xz`,
    });
    expect(readdirSync(join(root, '.runtime'))).toEqual([name]);
    expect(install('', false, true).status).toBe(0);
  });

  it.each([
    ['checksum mismatch', true, false, 'SHA-256 verification failed'],
    ['download failure', false, true, 'fixture download failed'],
  ])('cleans temporary files after %s without publishing', (_label, checksum, fail, message) => {
    const result = install('', checksum, fail);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(readdirSync(join(root, '.runtime'))).toEqual([]);
  });

  it.each(["platform:'darwin'", "arch:'ia32'"])(
    'rejects an unsupported target before downloading: %s',
    (target) => {
      const result = install(target, false, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Linux x64 and arm64 only');
      expect(existsSync(join(root, '.runtime'))).toBe(false);
    },
  );

  it('rejects a floating or malformed pin', () => {
    writeFileSync(join(root, '.nvmrc'), '22\n');
    const result = install('', false, true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exact Node.js 22 version');
  });

  it('refuses to overwrite an existing unverified runtime', () => {
    const destination = join(root, '.runtime', name);
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'preserved'), 'old runtime');
    expect(install().status).toBe(1);
    expect(readFileSync(join(destination, 'preserved'), 'utf8')).toBe('old runtime');
  });

  it('refuses concurrent setup without deleting another installer lock', () => {
    mkdirSync(join(root, '.runtime/.setup-node.lock'), { recursive: true });
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already running');
    expect(existsSync(join(root, '.runtime/.setup-node.lock'))).toBe(true);
  });
});
