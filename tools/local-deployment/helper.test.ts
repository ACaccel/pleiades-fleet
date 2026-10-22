import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

let helper: {
  acquireInstallLock(file: string, ownerUid?: number): () => void;
  validateId(value: unknown): string;
  validateManifest(value: unknown, id: string, enabled?: string[]): unknown;
  renderUnit(id: string, bot: string, timeout: number): string;
  safeLinkTarget(root: string, path: string, target: string): string;
  copyStage(source: string, target: string, uid: number, gid: number, setOwner?: () => void): void;
  validateReleaseDirectories(directory: string, selected: string[]): void;
  retainedReleaseIds(names: string[], references: string): Set<string>;
};
let installer: {
  parseArgs(args: string[]): { dryRun: boolean; deployer: string; bots: string[] };
  installationPlan(config: { deployer: string; bots: string[] }): { note: string };
};
const id = '1792670000000-11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
beforeAll(async () => {
  helper = await import(join(__dirname, 'helper.mjs'));
  installer = await import(join(__dirname, 'install.mjs'));
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'pleiades-isolated-'));
  roots.push(root);
  return root;
}

describe('isolated deployment privilege boundary', () => {
  it('holds the privileged installation lock until its descriptor closes', () => {
    const file = join(temporary(), 'install.lock');
    const unlock = helper.acquireInstallLock(file, process.getuid!());
    try {
      expect(() => helper.acquireInstallLock(file, process.getuid!())).toThrow(
        'Another isolated deployment',
      );
    } finally {
      unlock();
    }
    helper.acquireInstallLock(file, process.getuid!())();
  });
  it('rejects a linked privileged installation lock', () => {
    const root = temporary();
    writeFileSync(join(root, 'target'), '');
    symlinkSync('target', join(root, 'install.lock'));
    expect(() =>
      helper.acquireInstallLock(join(root, 'install.lock'), process.getuid!()),
    ).toThrow();
  });
  it('accepts only release ids and enabled unique bot targets', () => {
    const manifest = {
      version: 1,
      id,
      bots: ['tomori'],
      readinessTimeoutSeconds: 120,
      commit: 'a'.repeat(40),
    };
    expect(helper.validateManifest(manifest, id, ['tomori'])).toEqual(manifest);
    for (const value of ['../escape', `${id}/../../etc`, 'latest', `${id}\n`])
      expect(() => helper.validateId(value)).toThrow();
    for (const patch of [
      { bots: ['konata'] },
      { bots: ['tomori', 'tomori'] },
      { bots: [] },
      { readinessTimeoutSeconds: 601 },
      { user: 'root' },
      { commit: 'main' },
    ])
      expect(() => helper.validateManifest({ ...manifest, ...patch }, id, ['tomori'])).toThrow();
  });
  it('renders fixed unprivileged units with no home-directory or GitHub credential access', () => {
    const unit = helper.renderUnit(id, 'konata', 120);
    for (const expected of [
      'User=pleiades',
      'ProtectHome=true',
      'ProtectSystem=strict',
      'NoNewPrivileges=true',
      'CapabilityBoundingSet=',
      `/opt/pleiades-fleet/releases/${id}/runtime/bin/node`,
      'PLEIADES_FONT_DIR=',
      'ReadWritePaths=/var/lib/pleiades-fleet /var/log/pleiades-fleet',
    ])
      expect(unit).toContain(expected);
    expect(unit).not.toContain('/home/');
    expect(unit).not.toContain('Wants=network-online.target mongodb');
    expect(() => helper.renderUnit(id, 'konata\nUser=root', 120)).toThrow();
    expect(helper.renderUnit(id, 'gopher', 120)).not.toContain('ExecStartPre=');
  });
  it('copies only safe staging contents and never follows source symlinks', () => {
    const root = temporary();
    const source = join(root, 'stage');
    mkdirSync(join(source, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(source, 'node_modules/tool'), 'safe');
    symlinkSync('../tool', join(source, 'node_modules/.bin/tool'));
    const target = join(root, 'release');
    helper.copyStage(source, target, process.getuid!(), process.getgid!(), () => undefined);
    expect(readFileSync(join(target, 'node_modules/.bin/tool'), 'utf8')).toBe('safe');
    symlinkSync('/etc/shadow', join(source, 'secret'));
    expect(() =>
      helper.copyStage(
        source,
        join(root, 'unsafe'),
        process.getuid!(),
        process.getgid!(),
        () => undefined,
      ),
    ).toThrow('escapes');
    symlinkSync(source, join(root, 'source-link'));
    expect(() =>
      helper.copyStage(
        join(root, 'source-link'),
        join(root, 'via-link'),
        process.getuid!(),
        process.getgid!(),
        () => undefined,
      ),
    ).toThrow();
  });
  it('rejects symlink ancestors before attaching privileged settings', () => {
    const root = temporary();
    for (const dir of [
      'src/bot/tomori',
      'scripts/deployment',
      'node_modules',
      'runtime/bin',
      'fonts',
    ])
      mkdirSync(join(root, dir), { recursive: true });
    helper.validateReleaseDirectories(root, ['tomori']);
    rmSync(join(root, 'src/bot/tomori'), { recursive: true });
    symlinkSync('../../other', join(root, 'src/bot/tomori'));
    mkdirSync(join(root, 'other'));
    expect(() => helper.validateReleaseDirectories(root, ['tomori'])).toThrow();
  });
  it('rejects links outside the release while allowing npm relative bin links', () => {
    expect(helper.safeLinkTarget('/release', '/release/node_modules/.bin/tool', '../tool')).toBe(
      '../tool',
    );
    for (const target of ['/etc/shadow', '../../../home/acaccel/.config/gh/hosts.yml'])
      expect(() => helper.safeLinkTarget('/release', '/release/src/link', target)).toThrow();
  });
  it('retains the newest three releases and every still-active targeted release', () => {
    const ids = [1, 2, 3, 4, 5].map(
      (n) => `${1792670000000 + n}-11111111-1111-4111-8111-111111111111`,
    );
    const retained = helper.retainedReleaseIds(
      [...ids, '../unsafe'],
      `ExecStart=/opt/pleiades-fleet/releases/${ids[0]}/runtime/bin/node`,
    );
    expect([...retained].sort()).toEqual([ids[0], ids[2], ids[3], ids[4]].sort());
  });
  it('renders an inert bootstrap plan and rejects privileged deployer identities', () => {
    const config = installer.parseArgs([
      '--dry-run',
      '--deployer',
      'acaccel',
      '--bots',
      'tomori,konata',
    ]);
    expect(config).toEqual({ dryRun: true, deployer: 'acaccel', bots: ['tomori', 'konata'] });
    expect(installer.installationPlan(config).note).toContain('not migrated or restarted');
    for (const deployer of ['root', 'pleiades', 'pleiades-mongo', 'acaccel ALL=(ALL)'])
      expect(() => installer.parseArgs(['--deployer', deployer, '--bots', 'tomori'])).toThrow();
    expect(() =>
      installer.parseArgs(['--deployer', 'acaccel', '--bots', 'tomori,tomori']),
    ).toThrow();
  });
});
