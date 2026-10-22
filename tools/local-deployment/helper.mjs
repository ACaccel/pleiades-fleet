#!/usr/bin/node
import { spawnSync } from 'node:child_process';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  chownSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const paths = Object.freeze({
  app: '/opt/pleiades-fleet',
  settings: '/etc/pleiades-fleet',
  state: '/var/lib/pleiades-fleet',
  logs: '/var/log/pleiades-fleet',
  control: '/var/lib/pleiades-deployer',
  stage: '/var/lib/pleiades-deployer/stage',
  journal: '/var/lib/pleiades-deployment',
});
export const bots = Object.freeze(['tomori', 'nijika', 'msg-archive', 'konata', 'gopher']);
const marker = '# Managed by Pleiades isolated deployment\n';
export function validateId(id) {
  if (typeof id !== 'string' || !/^\d{13}-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id))
    throw new Error('Invalid release id');
  return id;
}
export function validateManifest(value, id, enabled = bots) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['version', 'id', 'bots', 'readinessTimeoutSeconds', 'commit'].includes(key),
    ) ||
    value.version !== 1 ||
    value.id !== validateId(id) ||
    !Array.isArray(value.bots) ||
    value.bots.length < 1 ||
    new Set(value.bots).size !== value.bots.length ||
    value.bots.some((bot) => !bots.includes(bot) || !enabled.includes(bot)) ||
    !Number.isInteger(value.readinessTimeoutSeconds) ||
    value.readinessTimeoutSeconds < 15 ||
    value.readinessTimeoutSeconds > 600 ||
    !/^[a-f\d]{40}$/.test(value.commit)
  )
    throw new Error('Invalid isolated release manifest');
  return value;
}
function q(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid systemd argument');
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$$$')}"`;
}
export function renderUnit(id, bot, timeout) {
  validateId(id);
  if (!bots.includes(bot) || !Number.isInteger(timeout) || timeout < 15 || timeout > 600)
    throw new Error('Invalid unit request');
  const directory = `${paths.app}/releases/${id}`;
  const args = [
    `${directory}/runtime/bin/node`,
    '-r',
    'ts-node/register',
    '-r',
    'tsconfig-paths/register',
  ];
  const pre =
    bot === 'gopher'
      ? ''
      : `ExecStartPre=${[...args, `${directory}/scripts/mongo-ready.ts`, `${paths.settings}/bots/${bot}/.env`, String(timeout)].map(q).join(' ')}\n`;
  return `${marker}[Unit]\nDescription=Pleiades ${bot}\nAfter=network-online.target mongodb-pleiades.service\nWants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=exec\nUser=pleiades\nGroup=pleiades\nSupplementaryGroups=pleiades-settings\nWorkingDirectory=${directory}\nEnvironment=${q(`PATH=${directory}/runtime/bin:${directory}/node_modules/.bin:/usr/bin:/bin`)}\nEnvironment=NODE_ENV=production\nEnvironment=${q(`PLEIADES_FONT_DIR=${directory}/fonts`)}\nEnvironment=${q(`TS_NODE_PROJECT=${directory}/tsconfig.json`)}\nEnvironment=${q(`PLEIADES_READY_FILE=/run/pleiades-${bot}/ready.json`)}\nEnvironment=${q(`LOG_DIR=${paths.logs}`)}\nRuntimeDirectory=pleiades-${bot}\nRuntimeDirectoryMode=0750\nTimeoutStartSec=${timeout + 15}\nTimeoutStopSec=60\nRestart=on-failure\nRestartSec=5\nKillSignal=SIGTERM\nKillMode=control-group\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\nPrivateDevices=true\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nRestrictSUIDSGID=true\nRestrictRealtime=true\nLockPersonality=true\nCapabilityBoundingSet=\nReadWritePaths=${paths.state} ${paths.logs}\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n${pre}ExecStart=${[...args, `${directory}/src/bot/${bot}/index.ts`].map(q).join(' ')}\n\n[Install]\nWantedBy=multi-user.target\n`;
}
export function safeLinkTarget(root, linkPath, target) {
  const destination = resolve(dirname(linkPath), target);
  if (isAbsolute(target) || (destination !== root && !destination.startsWith(`${root}/`)))
    throw new Error('Release symlink escapes its immutable directory');
  return target;
}
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 180000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0] ?? ''} failed`);
  return result.stdout?.trim() ?? '';
}
function system(action, unit) {
  return command('/usr/bin/systemctl', [action, ...(unit ? [unit] : [])]);
}
function field(unit, name) {
  return command('/usr/bin/systemctl', ['show', unit, `--property=${name}`, '--value']);
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function atom(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, value);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    syncDirectory(dirname(file));
  } finally {
    rmSync(temporary, { force: true });
  }
}
function removeJournal(file) {
  rmSync(file, { force: true });
  syncDirectory(dirname(file));
}
function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function event(unit, state) {
  process.stdout.write(`${JSON.stringify({ event: 'component', service: unit, state })}\n`);
}
function inspect(unit, transitional = false) {
  const file = `/etc/systemd/system/${unit}`;
  const fragment = field(unit, 'FragmentPath');
  if ((fragment && fragment !== file) || field(unit, 'DropInPaths'))
    throw new Error(`Unmanaged service or drop-ins: ${unit}`);
  let content = null;
  if (existsSync(file)) {
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
      throw new Error(`Unsafe unit file: ${unit}`);
    content = readFileSync(file, 'utf8');
    if (!content.startsWith(marker))
      throw new Error(`Legacy service requires explicit offline cutover: ${unit}`);
  }
  const enabled = field(unit, 'UnitFileState');
  if (enabled && !['enabled', 'disabled', 'not-found'].includes(enabled))
    throw new Error(`Unsupported unit state: ${unit}`);
  const state = field(unit, 'ActiveState');
  if (!transitional && ['activating', 'deactivating', 'reloading'].includes(state))
    throw new Error(`Service is changing state: ${unit}`);
  return {
    content,
    enabled: enabled === 'enabled',
    active: ['active', 'activating', 'deactivating', 'reloading'].includes(state),
  };
}
function writeUnit(unit, content) {
  inspect(unit, true);
  const file = `/etc/systemd/system/${unit}`;
  if (content === null) rmSync(file, { force: true });
  else {
    if (!content.startsWith(marker)) throw new Error('Unsafe unit content');
    atom(file, content);
    chmodSync(file, 0o644);
  }
}
async function ready(unit, since, timeout) {
  const bot = /^pleiades@([a-z-]+)\.service$/.exec(unit)?.[1];
  if (!bots.includes(bot)) throw new Error('Invalid readiness target');
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const state = field(unit, 'ActiveState');
    if (state === 'failed') throw new Error(`${unit} failed readiness`);
    const pid = Number(field(unit, 'MainPID'));
    try {
      const value = json(`/run/pleiades-${bot}/ready.json`);
      if (
        state === 'active' &&
        pid > 0 &&
        value.pid === pid &&
        Number.isFinite(value.startedAt) &&
        Number.isFinite(value.readyAt) &&
        value.readyAt >= value.startedAt &&
        value.readyAt >= since &&
        field(unit, 'ActiveState') === 'active' &&
        Number(field(unit, 'MainPID')) === pid
      )
        return;
    } catch {
      /* Markers appear after startup and disappear on shutdown. */
    }
    await delay(500);
  }
  throw new Error(`${unit} did not become ready`);
}
function openDirectory(path) {
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of path.split('/').filter(Boolean)) {
      const next = openSync(
        `/proc/self/fd/${fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
/** Descriptor-relative reads prevent a writable staging tree from redirecting privileged reads. */
export function copyStage(source, destination, uid, gid, setOwner = chownSync) {
  const sourceFd = openDirectory(source);
  const budget = { files: 0, bytes: 0 };
  const copy = (fd, target) => {
    mkdirSync(target, { mode: 0o750 });
    setOwner(target, 0, gid);
    for (const name of readdirSync(`/proc/self/fd/${fd}`)) {
      if (name === '.' || name === '..' || name.includes('/'))
        throw new Error('Unsafe release entry');
      const entry = `/proc/self/fd/${fd}/${name}`;
      const output = join(target, name);
      const info = lstatSync(entry);
      if (++budget.files > 150000 || info.uid !== uid)
        throw new Error('Invalid staging ownership or file count');
      if (info.isSymbolicLink()) {
        symlinkSync(safeLinkTarget(destination, output, readlinkSync(entry)), output);
        setOwner(target, 0, gid);
      } else if (info.isDirectory()) {
        const nested = openSync(
          entry,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          if (fstatSync(nested).uid !== uid) throw new Error('Invalid stage owner');
          copy(nested, output);
        } finally {
          closeSync(nested);
        }
      } else if (info.isFile()) {
        const file = openSync(
          entry,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const actual = fstatSync(file);
          if (
            !actual.isFile() ||
            actual.uid !== uid ||
            (budget.bytes += actual.size) > 3 * 1024 ** 3
          )
            throw new Error('Unsafe staging file');
          writeFileSync(output, readFileSync(file), {
            mode: actual.mode & 0o111 ? 0o750 : 0o640,
            flag: 'wx',
          });
          setOwner(output, 0, gid);
        } finally {
          closeSync(file);
        }
      } else throw new Error('Unsupported staging entry');
    }
  };
  try {
    if (fstatSync(sourceFd).uid !== uid) throw new Error('Invalid stage owner');
    copy(sourceFd, destination);
  } finally {
    closeSync(sourceFd);
  }
}
/** Keep the newest three releases and every release still named by an installed service. */
export function retainedReleaseIds(names, references, keep = 3) {
  const ordered = names
    .filter((name) => /^\d{13}-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(name))
    .sort()
    .reverse();
  return new Set([
    ...ordered.slice(0, keep),
    ...ordered.filter((name) => references.includes(name)),
  ]);
}
function pruneReleases() {
  if (existsSync(`${paths.journal}/transaction.json`)) return;
  const base = `${paths.app}/releases`;
  const names = readdirSync(base).filter((name) => {
    const info = lstatSync(join(base, name));
    return info.isDirectory() && !info.isSymbolicLink();
  });
  const references = [
    ...bots.map((bot) => `pleiades@${bot}.service`),
    'pleiades-mongo-backup.service',
  ]
    .map((unit) => {
      const file = `/etc/systemd/system/${unit}`;
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    })
    .join('\n');
  const retained = retainedReleaseIds(names, references);
  for (const name of names) {
    if (!/^\d{13}-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(name) || retained.has(name))
      continue;
    rmSync(join(base, name), { recursive: true, force: true });
  }
}
function validateJournal(value) {
  if (!value || !value.before || !value.after || !value.manifest)
    throw new Error('Invalid deployment journal');
  validateManifest(value.manifest, value.manifest.id);
  const names = Object.keys(value.before);
  if (
    names.length !== value.manifest.bots.length ||
    names.some((unit) => !value.manifest.bots.some((bot) => unit === `pleiades@${bot}.service`)) ||
    Object.keys(value.after).length !== names.length
  )
    throw new Error('Invalid journal targets');
  for (const unit of names) {
    const state = value.before[unit];
    if (
      !state ||
      typeof state.enabled !== 'boolean' ||
      typeof state.active !== 'boolean' ||
      (state.content !== null &&
        (typeof state.content !== 'string' || !state.content.startsWith(marker))) ||
      value.after[unit] !==
        renderUnit(value.manifest.id, unit.slice(9, -8), value.manifest.readinessTimeoutSeconds)
    )
      throw new Error('Invalid journal state');
  }
  return value;
}
async function rollback(transaction) {
  const failures = [];
  for (const [unit, before] of Object.entries(transaction.before)) {
    try {
      const now = inspect(unit, true);
      if (now.active) system('stop', unit);
      if (now.enabled) system('disable', unit);
      writeUnit(unit, before.content);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    system('daemon-reload');
  } catch (error) {
    failures.push(error);
  }
  for (const [unit, before] of Object.entries(transaction.before)) {
    try {
      if (before.enabled) system('enable', unit);
      if (before.active) {
        const since = Date.now();
        system('start', unit);
        await ready(unit, since, transaction.manifest.readinessTimeoutSeconds);
      }
      event(unit, 'rolled-back');
    } catch (error) {
      failures.push(error);
      event(unit, 'failed');
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Rollback incomplete; run the installed helper recover after inspecting the journal',
    );
}
export function validateReleaseDirectories(directory, selected) {
  for (const sub of [
    'src',
    'src/bot',
    'scripts',
    'scripts/deployment',
    'node_modules',
    'runtime',
    'runtime/bin',
    'fonts',
    ...selected.map((bot) => `src/bot/${bot}`),
  ]) {
    const fd = openDirectory(join(directory, sub));
    closeSync(fd);
  }
}
function attachSettings(directory, selected) {
  validateReleaseDirectories(directory, selected);
  for (const bot of selected) {
    for (const name of ['.env', 'config.json']) {
      const source = `${paths.settings}/bots/${bot}/${name}`;
      const info = lstatSync(source);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o027)
        throw new Error(`Missing or insecure settings for ${bot}`);
      const target = join(directory, 'src/bot', bot, name);
      rmSync(target, { force: true });
      symlinkSync(source, target);
    }
  }
  const profile = `${paths.settings}/guild_profile.json`;
  if (existsSync(profile)) {
    const info = lstatSync(profile);
    if (!info.isFile() || info.uid !== 0 || info.mode & 0o027)
      throw new Error('Insecure guild profile');
    const target = join(directory, 'src/guild_profile.json');
    rmSync(target, { force: true });
    symlinkSync(profile, target);
  }
  for (const [name, source] of [
    ['data', paths.state],
    ['logs', paths.logs],
  ]) {
    const target = join(directory, name);
    rmSync(target, { recursive: true, force: true });
    symlinkSync(source, target);
  }
}
/** The kernel releases the same open-description lock after exits or interruption. */
export function acquireInstallLock(file, ownerUid = 0) {
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== ownerUid || (info.mode & 0o077) !== 0)
      throw new Error('Unsafe deployment lock');
    const result = spawnSync('/usr/bin/flock', ['-n', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
    });
    if (result.error || result.status !== 0)
      throw new Error('Another isolated deployment is running');
    return () => closeSync(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
export async function main(args = process.argv.slice(2)) {
  const [action, id, ...extra] = args;
  if (
    !['install', 'recover', 'status'].includes(action) ||
    extra.length ||
    (action === 'install' ? !id : id !== undefined)
  )
    throw new Error('Usage: pleiades-local-deploy install <release-id>|recover|status');
  if (action === 'install') validateId(id);
  if (process.getuid?.() !== 0) throw new Error('The installed helper requires root');
  process.umask(0o077);
  const host = json(`${paths.settings}/host.json`);
  if (
    !Number.isInteger(host.deployerUid) ||
    host.deployerUid <= 0 ||
    !Array.isArray(host.bots) ||
    host.bots.some((bot) => !bots.includes(bot))
  )
    throw new Error('Invalid root-managed host configuration');
  const journal = `${paths.journal}/transaction.json`;
  const stateFile = `${paths.journal}/current.json`;
  if (action === 'status') {
    process.stdout.write(
      `${JSON.stringify({ current: existsSync(stateFile) ? json(stateFile) : null, interrupted: existsSync(journal) })}\n`,
    );
    return;
  }
  const unlock = acquireInstallLock(`${paths.journal}/install.lock`);
  try {
    if (action === 'recover') {
      if (!existsSync(journal)) return;
      const transaction = validateJournal(json(journal));
      if (existsSync(stateFile) && json(stateFile).deploymentId === transaction.manifest.id) {
        removeJournal(journal);
        return;
      }
      await rollback(transaction);
      removeJournal(journal);
      return;
    }
    if (existsSync(journal)) throw new Error('Recover the interrupted isolated deployment first');
    const directory = `${paths.app}/releases/${id}`;
    const temporary = `${paths.app}/releases/.preparing-${id}`;
    if (existsSync(directory) || existsSync(temporary))
      throw new Error('Release already exists; use a new prepared release id');
    const gid = Number(command('/usr/bin/id', ['-g', 'pleiades']));
    try {
      copyStage(`${paths.stage}/${id}`, temporary, host.deployerUid, gid);
      const manifest = validateManifest(json(join(temporary, 'manifest.json')), id, host.bots);
      if (
        !lstatSync(join(temporary, 'runtime/bin/node')).isFile() ||
        !lstatSync(join(temporary, 'fonts/NotoSansCJKtc-VF.ttf')).isFile()
      )
        throw new Error('Release runtime or fonts missing');
      attachSettings(temporary, manifest.bots);
      renameSync(temporary, directory);
      const after = Object.fromEntries(
        manifest.bots.map((bot) => [
          `pleiades@${bot}.service`,
          renderUnit(id, bot, manifest.readinessTimeoutSeconds),
        ]),
      );
      const before = Object.fromEntries(Object.keys(after).map((unit) => [unit, inspect(unit)]));
      const transaction = { before, after, manifest };
      atom(journal, `${JSON.stringify(transaction)}\n`);
      try {
        for (const unit of Object.keys(after)) {
          event(unit, 'running');
          if (before[unit].active) system('stop', unit);
        }
        for (const [unit, content] of Object.entries(after)) {
          if (before[unit].enabled) system('disable', unit);
          writeUnit(unit, content);
        }
        system('daemon-reload');
        for (const unit of Object.keys(after)) {
          const since = Date.now();
          system('enable', unit);
          system('start', unit);
          await ready(unit, since, manifest.readinessTimeoutSeconds);
          event(unit, 'done');
        }
        const previous = existsSync(stateFile) ? json(stateFile) : { units: {} };
        atom(
          stateFile,
          `${JSON.stringify({ deploymentId: id, commit: manifest.commit, units: { ...previous.units, ...after } })}\n`,
        );
      } catch (error) {
        for (const unit of Object.keys(after)) event(unit, 'failed');
        try {
          await rollback(transaction);
          removeJournal(journal);
        } catch (recovery) {
          throw new AggregateError(
            [error, recovery],
            'Deployment and rollback failed; journal retained',
          );
        }
        throw error;
      }
      removeJournal(journal);
      try {
        pruneReleases();
      } catch {
        console.error('Release retention cleanup failed; deployment remains committed');
      }
      process.stdout.write(
        `${JSON.stringify({ event: 'deployment', state: 'done', id, services: Object.keys(after), commit: manifest.commit })}\n`,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } finally {
    unlock();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Isolated deployment failed');
    process.exitCode = 1;
  });
}
