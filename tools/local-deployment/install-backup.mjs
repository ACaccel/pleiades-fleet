#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderUnits, ownerMarker } from '../mongo-backup/install.mjs';
import { paths, validateId } from './helper.mjs';

function run(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0] ?? ''} failed`);
  return result.stdout.trim();
}
export function backupSettings(id, keep) {
  validateId(id);
  if (!/^[1-9]\d*$/.test(keep)) throw new Error('Backup retention must be a positive integer');
  const root = `${paths.app}/releases/${id}`;
  return {
    root,
    ownerRoot: paths.app,
    user: 'pleiades-backup',
    node: `${root}/runtime/bin/node`,
    mongoPrefix: '/opt/pleiades-mongo/runtime',
    envFile: '/etc/pleiades-backup/backup.env',
    backupDir: '/var/backups/pleiades',
    keep: Number(keep),
    isolated: true,
  };
}
export function main(args = process.argv.slice(2)) {
  if (args.length !== 2)
    throw new Error('Usage: install-backup.mjs <installed-release-id> <retained-snapshots>');
  const settings = backupSettings(args[0], args[1]);
  if (process.getuid?.() !== 0)
    throw new Error('Reviewed isolated backup installation requires root');
  const uid = Number(run('/usr/bin/id', ['-u', 'pleiades-backup']));
  const gid = Number(run('/usr/bin/id', ['-g', 'pleiades-backup']));
  for (const file of [
    settings.node,
    `${settings.root}/tools/mongo-backup/backup.mjs`,
    `${settings.mongoPrefix}/bin/mongodump`,
    settings.envFile,
  ]) {
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (file === settings.envFile
        ? info.uid !== uid || (info.mode & 0o077) !== 0
        : info.uid !== 0 || (info.mode & 0o022) !== 0)
    )
      throw new Error(`Unsafe or missing backup prerequisite: ${file}`);
    if (file !== settings.envFile) {
      for (let parent = dirname(file); parent !== '/'; parent = dirname(parent)) {
        const parentInfo = lstatSync(parent);
        if (
          !parentInfo.isDirectory() ||
          parentInfo.isSymbolicLink() ||
          parentInfo.uid !== 0 ||
          parentInfo.mode & 0o022
        )
          throw new Error(`Unsafe backup parent: ${parent}`);
      }
    }
  }
  run('/usr/sbin/runuser', ['-u', 'pleiades-backup', '--', settings.node, '--version']);
  run('/usr/sbin/runuser', [
    '-u',
    'pleiades-backup',
    '--',
    `${settings.mongoPrefix}/bin/mongodump`,
    '--version',
  ]);
  const units = renderUnits(settings);
  const staging = '/var/lib/pleiades-deployment/backup-units';
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(units)) {
    const target = `/etc/systemd/system/${name}`;
    if (
      existsSync(target) &&
      (!lstatSync(target).isFile() ||
        !readFileSync(target, 'utf8').startsWith(ownerMarker(paths.app)))
    )
      throw new Error('Preserve and remove legacy backup units during offline cutover first');
    writeFileSync(join(staging, name), content, { mode: 0o600 });
  }
  run('/usr/bin/systemd-analyze', [
    'verify',
    ...Object.keys(units).map((name) => join(staging, name)),
  ]);
  const verifySnapshotOwnership = (directory) => {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid)
      throw new Error(
        'Migrate existing backup snapshots and ownership explicitly before installing the isolated timer',
      );
    for (const name of readdirSync(directory)) {
      const target = join(directory, name);
      const entry = lstatSync(target);
      if (entry.isSymbolicLink() || entry.uid !== uid || (!entry.isDirectory() && !entry.isFile()))
        throw new Error('Unsafe or unmigrated backup snapshot entry');
      if (entry.isDirectory()) verifySnapshotOwnership(target);
    }
  };
  verifySnapshotOwnership(settings.backupDir);
  chownSync(settings.backupDir, uid, gid);
  chmodSync(settings.backupDir, 0o700);
  for (const name of Object.keys(units))
    run('/usr/bin/install', [
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '0644',
      '--',
      join(staging, name),
      `/etc/systemd/system/${name}`,
    ]);
  run('/usr/bin/systemctl', ['daemon-reload']);
  run('/usr/bin/systemctl', ['enable', '--now', 'pleiades-mongo-backup.timer']);
  process.stdout.write(
    'Installed isolated backup timer; run the service and verify a restore before accepting cutover.\n',
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Backup installation failed');
    process.exitCode = 1;
  }
}
