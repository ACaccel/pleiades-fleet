#!/usr/bin/node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bots, paths } from './helper.mjs';

export function parseArgs(args) {
  const dryRun = args.includes('--dry-run');
  const rest = args.filter((arg) => arg !== '--dry-run');
  if (
    rest.length !== 4 ||
    rest[0] !== '--deployer' ||
    rest[2] !== '--bots' ||
    !/^[a-z_][a-z0-9_-]*$/.test(rest[1]) ||
    ['root', 'pleiades', 'pleiades-mongo'].includes(rest[1])
  )
    throw new Error(
      'Usage: install.mjs [--dry-run] --deployer <user> --bots <comma-separated enabled bots>',
    );
  const enabled = rest[3].split(',');
  if (
    !enabled.length ||
    new Set(enabled).size !== enabled.length ||
    enabled.some((bot) => !bots.includes(bot))
  )
    throw new Error('Select unique known bots');
  return { dryRun, deployer: rest[1], bots: enabled };
}
export function installationPlan(config) {
  return {
    accounts: ['pleiades', 'pleiades-mongo', 'pleiades-backup'],
    settingsGroup: 'pleiades-settings',
    deployer: config.deployer,
    bots: config.bots,
    directories: paths,
    helper: '/usr/local/libexec/pleiades-local-deploy',
    sudoers: `/etc/sudoers.d/pleiades-local-deploy-${config.deployer}`,
    note: 'Creates host scaffolding only. Existing services, settings, databases, backups and runtime paths are not migrated or restarted.',
  };
}
function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0] ?? ''} failed`);
  return result.stdout.trim();
}
function directory(path, uid, gid, mode) {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()))
    throw new Error(`Refusing unsafe directory: ${path}`);
  mkdirSync(path, { recursive: true, mode });
  chownSync(path, uid, gid);
  chmodSync(path, mode);
}
function account(user) {
  const lookup = spawnSync('/usr/bin/getent', ['passwd', user], { encoding: 'utf8' });
  if (lookup.status === 0) {
    const entry = lookup.stdout.trim().split(':');
    if (
      Number(entry[2]) === 0 ||
      !['/usr/sbin/nologin', '/sbin/nologin', '/bin/false'].includes(entry[6])
    )
      throw new Error(`Existing ${user} must be reviewed before using it as a service account`);
  } else if (lookup.status === 2)
    run('/usr/sbin/useradd', [
      '--system',
      '--user-group',
      '--home-dir',
      '/nonexistent',
      '--no-create-home',
      '--shell',
      '/usr/sbin/nologin',
      user,
    ]);
  else throw new Error(`Cannot look up ${user}`);
  return {
    uid: Number(run('/usr/bin/id', ['-u', user])),
    gid: Number(run('/usr/bin/id', ['-g', user])),
  };
}
export function main(args = process.argv.slice(2)) {
  const config = parseArgs(args);
  if (config.dryRun) {
    process.stdout.write(`${JSON.stringify(installationPlan(config), null, 2)}\n`);
    return;
  }
  if (process.getuid?.() !== 0) throw new Error('Bootstrap requires root; review --dry-run first');
  process.umask(0o077);
  const deployerUid = Number(run('/usr/bin/id', ['-u', config.deployer]));
  const deployerGid = Number(run('/usr/bin/id', ['-g', config.deployer]));
  if (deployerUid <= 0) throw new Error('Deployer must be an ordinary account');
  const service = account('pleiades');
  const mongo = account('pleiades-mongo');
  const backup = account('pleiades-backup');
  run('/usr/sbin/usermod', ['-aG', 'pleiades', 'pleiades-backup']);
  const settingsLookup = spawnSync('/usr/bin/getent', ['group', 'pleiades-settings'], {
    encoding: 'utf8',
  });
  if (settingsLookup.status === 2) run('/usr/sbin/groupadd', ['--system', 'pleiades-settings']);
  else if (settingsLookup.status !== 0) throw new Error('Cannot look up settings group');
  for (const user of ['pleiades', config.deployer])
    run('/usr/sbin/usermod', ['-aG', 'pleiades-settings', user]);
  const settingsGid = Number(run('/usr/bin/getent', ['group', 'pleiades-settings']).split(':')[2]);
  directory(paths.app, 0, service.gid, 0o750);
  directory(`${paths.app}/releases`, 0, service.gid, 0o750);
  directory(paths.settings, 0, settingsGid, 0o750);
  directory(`${paths.settings}/bots`, 0, settingsGid, 0o750);
  for (const bot of config.bots) directory(`${paths.settings}/bots/${bot}`, 0, settingsGid, 0o750);
  directory(paths.state, service.uid, service.gid, 0o750);
  directory(paths.logs, service.uid, service.gid, 0o750);
  directory('/var/lib/pleiades-mongo', mongo.uid, mongo.gid, 0o750);
  directory('/var/log/pleiades-mongo', mongo.uid, mongo.gid, 0o750);
  directory('/etc/pleiades-mongo', 0, mongo.gid, 0o750);
  directory('/opt/pleiades-mongo', 0, 0, 0o755);
  directory('/etc/pleiades-backup', 0, backup.gid, 0o750);
  if (!existsSync('/var/backups/pleiades'))
    directory('/var/backups/pleiades', backup.uid, backup.gid, 0o700);
  else if (
    !lstatSync('/var/backups/pleiades').isDirectory() ||
    lstatSync('/var/backups/pleiades').isSymbolicLink()
  )
    throw new Error('Refusing unsafe existing backup directory');
  // Existing snapshots remain owned by the legacy service until explicit offline cutover.
  directory(paths.control, deployerUid, deployerGid, 0o700);
  directory(paths.stage, deployerUid, deployerGid, 0o700);
  directory(paths.journal, 0, 0, 0o700);
  directory('/usr/local/libexec', 0, 0, 0o755);
  const stableNode = '/opt/pleiades-auto-deploy/current/runtime/bin/node';
  const resolvedNode = realpathSync(stableNode);
  const expectedVersion = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../.nvmrc'),
    'utf8',
  ).trim();
  for (let target = resolvedNode; target !== '/'; target = dirname(target)) {
    const info = lstatSync(target);
    if (info.uid !== 0 || info.isSymbolicLink() || info.mode & 0o022)
      throw new Error('Controller runtime must be owned and writable only by root');
  }
  if (lstatSync('/opt/pleiades-auto-deploy/current').uid !== 0)
    throw new Error('Controller current link must be root-owned');
  const metadata = JSON.parse(
    readFileSync(join(dirname(resolvedNode), '../.pleiades-runtime.json'), 'utf8'),
  );
  if (
    !resolvedNode.startsWith('/opt/pleiades-auto-deploy/releases/') ||
    !/^22\.\d+\.\d+$/.test(expectedVersion) ||
    run(stableNode, ['--version']) !== `v${expectedVersion}` ||
    metadata.version !== expectedVersion
  )
    throw new Error('Prepare the root-owned official controller runtime first');
  const helper = '/usr/local/libexec/pleiades-local-deploy';
  for (const file of [helper, `${helper}.mjs`])
    if (existsSync(file) && lstatSync(file).isSymbolicLink())
      throw new Error('Refusing helper symlink');
  writeFileSync(
    `${helper}.mjs`,
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'helper.mjs')),
    { mode: 0o644 },
  );
  chownSync(`${helper}.mjs`, 0, 0);
  chmodSync(`${helper}.mjs`, 0o644);
  writeFileSync(
    helper,
    `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH\nexec ${stableNode} /usr/local/libexec/pleiades-local-deploy.mjs "$@"\n`,
    { mode: 0o755 },
  );
  chownSync(helper, 0, 0);
  chmodSync(helper, 0o755);
  const host = `${paths.settings}/host.json`;
  writeFileSync(host, `${JSON.stringify({ version: 1, deployerUid, bots: config.bots })}\n`, {
    mode: 0o600,
  });
  chownSync(host, 0, 0);
  chmodSync(host, 0o600);
  const rule = `${config.deployer} ALL=(root) NOPASSWD: ${helper} install *, ${helper} recover, ${helper} status\n`;
  const sudoers = `/etc/sudoers.d/pleiades-local-deploy-${config.deployer}`;
  if (existsSync(sudoers) && lstatSync(sudoers).isSymbolicLink())
    throw new Error('Refusing sudoers symlink');
  const temporary = `${sudoers}.tmp`;
  writeFileSync(temporary, rule, { mode: 0o440, flag: 'wx' });
  try {
    run('/usr/sbin/visudo', ['-cf', temporary]);
    run('/usr/bin/install', ['-o', 'root', '-g', 'root', '-m', '0440', '--', temporary, sudoers]);
  } finally {
    run('/usr/bin/rm', ['-f', '--', temporary]);
  }
  process.stdout.write(`${JSON.stringify(installationPlan(config), null, 2)}\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Bootstrap failed');
    process.exitCode = 1;
  }
}
