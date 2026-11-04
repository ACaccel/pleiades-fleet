import { spawnSync } from 'node:child_process';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Settings = { root: string; node: string; dryRun: boolean };
let installer: {
  marker: string;
  scriptMarker: string;
  paths: { node: string; script: string; unit: string; output: string };
  parseArgs(args: string[]): Settings;
  renderUnit(settings: Pick<Settings, 'root' | 'node'>): string;
  validateMetadata(metadata: object, version: string, architecture: string): void;
  validateInstallTarget(info: Partial<Stats> | null, content: string, expectedMarker: string): void;
  assertTrusted(path: string): void;
  checkTarget(path: string, expectedMarker: string): void;
  readPreflightSample(path: string, uid: number, gid: number): unknown;
  main(args: string[], deps?: { getuid?: () => number; log?: (message: string) => void }): void;
};
let temporary: string;
beforeAll(async () => {
  installer = await import(path.join(__dirname, 'install.mjs'));
});
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mongo-storage-install-'));
});
afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

describe('reviewed installer', () => {
  const args = ['--mongo-data-root', '/var/lib/pleiades-mongo/data'];
  it('requires an explicit data root and supports the verified default or explicit runtime', () => {
    expect(installer.parseArgs(args)).toEqual({
      root: args[1],
      node: installer.paths.node,
      dryRun: false,
    });
    expect(installer.parseArgs([...args, '--node', '/opt/node/bin/node', '--dry-run'])).toEqual({
      root: args[1],
      node: '/opt/node/bin/node',
      dryRun: true,
    });
    for (const input of [
      [],
      ['--dry-run'],
      [...args, '--node'],
      [...args, '--unknown'],
      [...args, '--dry-run', '--dry-run'],
      ['--mongo-data-root', '/run'],
      ['--mongo-data-root', '/run/pleiades-mongo-storage/data'],
      ['--mongo-data-root', '/usr/local'],
      ['--mongo-data-root', '/opt/pleiades-auto-deploy'],
      ['--mongo-data-root', '/home/database'],
      [...args, '--node', '/tmp/node'],
    ])
      expect(() => installer.parseArgs(input)).toThrow();
  });
  it('rejects systemd and path injection, including direct render calls', () => {
    for (const root of [
      'relative',
      '/data/../escape',
      '/data//file',
      '/data/',
      '/data\nExecStart=/evil',
      '/data%h',
      '/data$USER',
      '/data"x',
      '/data space',
      '/data\\x',
      '/data\0x',
      '/data;touch',
    ]) {
      expect(() => installer.parseArgs(['--mongo-data-root', root])).toThrow();
      expect(() => installer.renderUnit({ root, node: '/opt/node/bin/node' })).toThrow();
    }
  });
  it('renders a dedicated unprivileged service with data read-only and only the sample directory writable', () => {
    const unit = installer.renderUnit(installer.parseArgs(args));
    expect(unit.startsWith(installer.marker)).toBe(true);
    for (const line of [
      'User=pleiades-mongo',
      'Group=pleiades-mongo',
      'ProtectSystem=strict',
      'ProtectHome=true',
      'ReadOnlyPaths=/var/lib/pleiades-mongo/data',
      'ReadWritePaths=/run/pleiades-mongo-storage',
      'RuntimeDirectoryMode=0755',
      'UMask=0022',
      'PrivateNetwork=true',
      'IPAddressDeny=any',
      'RestrictAddressFamilies=none',
      'CapabilityBoundingSet=',
      'AmbientCapabilities=',
      'NoNewPrivileges=true',
    ])
      expect(unit.split('\n')).toContain(line);
    expect(unit).toContain(
      `ExecStart=${installer.paths.node} ${installer.paths.script} --root ${args[1]} --output ${installer.paths.output} --interval-ms 5000`,
    );
    expect(unit).not.toMatch(/ReadWritePaths=.*\/data/);
    expect(unit).not.toContain('SupplementaryGroups=pleiades\n');
    expect(unit).not.toMatch(/mongodump|mongosh|sudo|\.env/);
  });
  it('provides a mutation-free, non-root dry-run and rejects actual installation without root', async () => {
    const before = await fs.readdir(temporary);
    const getuid = vi.fn(() => {
      throw new Error('Dry-run must not require root');
    });
    const log = vi.fn();
    installer.main([...args, '--dry-run'], { getuid, log });
    expect(getuid).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]![0]!).output).toBe(installer.paths.output);
    expect(await fs.readdir(temporary)).toEqual(before);
    expect(() => installer.main(args, { getuid: () => 1000 })).toThrow(/requires root/);
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'install.mjs'), ...args, '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).unitContent).toContain('ProtectSystem=strict');
  });
  it('allows replacement only of root-owned managed regular files with safe permissions', () => {
    const info = { uid: 0, mode: 0o100644, isFile: () => true, isSymbolicLink: () => false };
    expect(() => installer.validateInstallTarget(null, '', installer.marker)).not.toThrow();
    expect(() =>
      installer.validateInstallTarget(info, installer.marker, installer.marker),
    ).not.toThrow();
    for (const unsafe of [
      { ...info, uid: 1000 },
      { ...info, mode: 0o100664 },
      { ...info, mode: 0o100646 },
      { ...info, isFile: () => false },
      { ...info, isSymbolicLink: () => true },
    ])
      expect(() =>
        installer.validateInstallTarget(unsafe, installer.marker, installer.marker),
      ).toThrow(/unsafe or unmanaged/);
    expect(() =>
      installer.validateInstallTarget(info, '# unrelated unit\n', installer.marker),
    ).toThrow(/unmanaged/);
  });
  it('rejects writable or symlink installation ancestors without changing them', async () => {
    await fs.writeFile(path.join(temporary, 'unrelated'), 'keep');
    await fs.symlink(path.join(temporary, 'unrelated'), path.join(temporary, 'target'));
    expect(() => installer.checkTarget(path.join(temporary, 'target'), installer.marker)).toThrow();
    expect(() => installer.assertTrusted(temporary)).toThrow();
    expect(await fs.readFile(path.join(temporary, 'unrelated'), 'utf8')).toBe('keep');
    expect((await fs.lstat(path.join(temporary, 'target'))).isSymbolicLink()).toBe(true);
  });
  it('reads preflight output without following symlinks, bounds input and hides invalid JSON content', async () => {
    const file = path.join(temporary, 'sample.json');
    await fs.writeFile(file, JSON.stringify({ version: 1 }), { mode: 0o644 });
    expect(installer.readPreflightSample(file, process.getuid!(), process.getgid!())).toEqual({
      version: 1,
    });
    await fs.symlink(file, path.join(temporary, 'alias'));
    expect(() =>
      installer.readPreflightSample(
        path.join(temporary, 'alias'),
        process.getuid!(),
        process.getgid!(),
      ),
    ).toThrow();
    await fs.writeFile(file, 'private fixture content');
    expect(() => installer.readPreflightSample(file, process.getuid!(), process.getgid!())).toThrow(
      'Invalid preflight sample JSON',
    );
    await fs.writeFile(file, 'x'.repeat(65537));
    expect(() => installer.readPreflightSample(file, process.getuid!(), process.getgid!())).toThrow(
      /Unsafe preflight/,
    );
  });
  it('requires official checksum metadata, exact project pin, and supported architecture', () => {
    const metadata = {
      version: '22.23.4',
      source: 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz',
      sha256: 'a'.repeat(64),
    };
    expect(() => installer.validateMetadata(metadata, '22.23.4', 'x64')).not.toThrow();
    for (const altered of [
      { ...metadata, version: '22.0.0' },
      { ...metadata, source: 'https://untrusted.invalid/node.tar.xz' },
      { ...metadata, sha256: 'invalid' },
    ])
      expect(() => installer.validateMetadata(altered, '22.23.4', 'x64')).toThrow(
        /verified official/,
      );
    expect(() => installer.validateMetadata(metadata, '22', 'x64')).toThrow();
    expect(() => installer.validateMetadata(metadata, '22.23.4', 'arm')).toThrow();
  });
});
