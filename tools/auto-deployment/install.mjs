import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = '/opt/pleiades-auto-deploy';
const marker = '# Managed by Pleiades automatic deployment\n';
const service = 'pleiades-auto-deploy.service';
const timer = 'pleiades-auto-deploy.timer';
const config = '/etc/pleiades-auto-deploy.json';
const unitPath = (name) => `/etc/systemd/system/${name}`;

function run(program, args, cwd) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120000, cwd });
  if (result.error || result.status !== 0) throw new Error(`${program} operation failed`);
  return result.stdout.trim();
}

export function parseInstallArguments(args) {
  const [user, source, ...extra] = args;
  if (
    !/^[a-z_][a-z0-9_-]*$/.test(user || '') ||
    /[\r\n\0]/.test(user || '') ||
    user === 'root' ||
    !source ||
    !isAbsolute(source) ||
    resolve(source) !== source ||
    /[\r\n\0]/.test(source) ||
    (extra.length !== 0 && (extra.length !== 1 || extra[0] !== '--prepare'))
  )
    throw new Error('Usage: install.mjs <operator> <absolute-source> [--prepare]');
  return { user, source, prepareOnly: extra.length === 1 };
}

export function renderControllerUnits(user, home, snapshot = `${base}/current`) {
  if (
    !/^[a-z_][a-z0-9_-]*$/.test(user) ||
    /[\r\n\0]/.test(user) ||
    user === 'root' ||
    !/^\/[A-Za-z0-9._/-]+$/.test(home) ||
    /[\r\n\0]/.test(home) ||
    resolve(home) !== home ||
    !/^\/opt\/pleiades-auto-deploy\/(?:current|releases\/[0-9]+-[0-9]+)$/.test(snapshot) ||
    /[\r\n\0]/.test(snapshot)
  )
    throw new Error('Invalid controller account or snapshot path');
  return {
    [service]: `${marker}[Unit]\nDescription=Pleiades dev automatic deployment\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nUser=${user}\nSupplementaryGroups=pleiades-settings\nEnvironment=HOME=${home}\nEnvironment=PATH=${snapshot}/runtime/bin:/usr/local/bin:/usr/bin:/bin\nEnvironment=TS_NODE_PROJECT=${snapshot}/tsconfig.json\nWorkingDirectory=${snapshot}\nExecStart=${snapshot}/runtime/bin/node -r ts-node/register ${snapshot}/scripts/auto-deploy.ts poll ${config}\nTimeoutStartSec=45min\nTimeoutStopSec=90\nKillMode=control-group\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n`,
    [timer]: `${marker}[Unit]\nDescription=Check Pleiades dev for deployable commits\n\n[Timer]\nOnBootSec=45s\nOnUnitInactiveSec=60s\nAccuracySec=5s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

function safeDirectory(path, mode) {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()))
    throw new Error('Unsafe controller directory');
  mkdirSync(path, { recursive: true, mode });
  chownSync(path, 0, 0);
  chmodSync(path, mode);
}
function ownTree(root, path = root) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    const target = readlinkSync(path);
    const destination = resolve(dirname(path), target);
    if (target.startsWith('/') || !destination.startsWith(`${root}/`))
      throw new Error('Controller symlink escapes the snapshot');
    return;
  }
  if (!info.isDirectory() && !info.isFile())
    throw new Error('Unsupported controller snapshot entry');
  chownSync(path, 0, 0);
  chmodSync(path, info.isDirectory() || info.mode & 0o111 ? 0o755 : 0o644);
  if (info.isDirectory()) for (const name of readdirSync(path)) ownTree(root, join(path, name));
}

/** runuser otherwise makes the first explicit supplementary group the primary group. */
export function operatorIdentityArguments(user, primaryGroup, fullConfiguration) {
  return [
    '-u',
    user,
    '--group',
    primaryGroup,
    ...(fullConfiguration ? ['--supp-group', 'pleiades-settings'] : []),
  ];
}

/** Keep settings/key validation in the controller's own modules; the request stub never sends. */
export function operatorPreflightScript(fullConfiguration) {
  const bootstrap = `require('./scripts/auto-deployment/host');`;
  if (!fullConfiguration) return bootstrap;
  return `${bootstrap}
(async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const settings = require('./scripts/auto-deployment/settings').readAutoDeploymentSettings(${JSON.stringify(config)});
  fs.accessSync(settings.stateDirectory, fs.constants.W_OK | fs.constants.X_OK);
  fs.accessSync(settings.condaExecutable, fs.constants.X_OK);
  fs.accessSync(path.dirname(settings.checkout), fs.constants.W_OK | fs.constants.X_OK);
  for (const input of settings.operationalInputs) {
    if (fs.realpathSync(input.source) !== input.source) throw new Error('Operational inputs cannot contain symlinks');
    const descriptor = fs.openSync(input.source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('Operational input must be regular');
      fs.readFileSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  }
  if (settings.notification) {
    const relay = require('./scripts/auto-deployment/relay-client').createRelayClient(
      { ...settings.notification, ownerUid: process.getuid() },
      async () => ({ ok: true, body: null }),
    );
    await relay.put('controller-install-preflight', { title: 'Controller installation preflight', status: 'running', stages: [] });
  }
})().catch(() => { console.error('Controller configuration or operational input preflight failed.'); process.exitCode = 1; });`;
}

/** Roll back every externally visible change if activation or timer setup fails. */
export function activateController(operations, prepareOnly) {
  const previous = operations.capture();
  let publishing = false;
  try {
    operations.stopTimer();
    operations.assertIdle();
    publishing = true;
    operations.publish();
    operations.installUnits();
    operations.reload();
    operations.configureTimer(prepareOnly);
  } catch (error) {
    const failures = [];
    const recover = (operation) => {
      try {
        operation();
      } catch (failure) {
        failures.push(failure);
      }
    };
    recover(() => operations.quiesceTimer());
    if (publishing) {
      recover(() => operations.restoreCurrent(previous));
      recover(() => operations.restoreUnits(previous));
      recover(() => operations.reload());
    }
    if (!failures.length) recover(() => operations.restoreTimer(previous));
    if (failures.length) {
      recover(() => operations.quiesceTimer());
      throw new AggregateError(
        [error, ...failures],
        'Controller installation and restoration failed; inspect the timer, installed snapshot, and units before enabling deployment.',
      );
    }
    throw error;
  }
}

function inspectExistingUnits() {
  const previous = {};
  for (const name of [service, timer]) {
    const path = unitPath(name);
    if (
      existsSync(path) &&
      (!lstatSync(path).isFile() ||
        lstatSync(path).isSymbolicLink() ||
        !readFileSync(path, 'utf8').startsWith(marker))
    )
      throw new Error('Refusing an unmanaged controller unit');
    if (run('/bin/systemctl', ['show', name, '--property=DropInPaths', '--value']))
      throw new Error('Refusing controller unit drop-ins');
    previous[name] = existsSync(path) ? readFileSync(path, 'utf8') : null;
  }
  return previous;
}
function readCurrent() {
  try {
    if (!lstatSync(`${base}/current`).isSymbolicLink())
      throw new Error('Controller current must be a symlink');
    const target = readlinkSync(`${base}/current`);
    if (!new RegExp(`^${base}/releases/[0-9]+-[0-9]+$`).test(target))
      throw new Error('Unexpected controller snapshot target');
    return target;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function replaceCurrent(target, id) {
  if (target === null) {
    rmSync(`${base}/current`, { force: true });
    return;
  }
  const temporary = `${base}/.current-${id}`;
  try {
    symlinkSync(target, temporary);
    renameSync(temporary, `${base}/current`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function main(args = process.argv.slice(2)) {
  const { user, source, prepareOnly } = parseInstallArguments(args);
  if (process.getuid?.() !== 0) throw new Error('Controller installation requires root');
  if (realpathSync(source) !== source) throw new Error('Controller source cannot contain symlinks');
  const home = run('/usr/bin/getent', ['passwd', user]).split(':')[5];
  const primaryGroup = run('/usr/bin/id', ['-gn', user]);
  renderControllerUnits(user, home);
  if (run('/usr/bin/git', ['-C', source, 'status', '--porcelain', '--untracked-files=normal']))
    throw new Error('Commit and validate source changes before installing the controller');
  const nodePrefix = resolve(dirname(process.execPath), '..');
  if (
    !existsSync(join(nodePrefix, '.pleiades-runtime.json')) ||
    run(process.execPath, ['--version']) !==
      `v${readFileSync(join(source, '.nvmrc'), 'utf8').trim()}`
  )
    throw new Error('Run the installer using the verified project Node runtime');
  if (!prepareOnly) {
    if (!existsSync('/usr/local/libexec/pleiades-local-deploy'))
      throw new Error('Install isolated deployment host scaffolding before enabling the timer');
    const info = lstatSync(config);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022)
      throw new Error(
        'Controller configuration must be a root-owned regular file without group/other write permission',
      );
  }
  inspectExistingUnits();
  safeDirectory(base, 0o755);
  safeDirectory(`${base}/releases`, 0o755);
  const id = `${Date.now()}-${process.pid}`;
  const stage = `${base}/releases/.preparing-${id}`;
  const destination = `${base}/releases/${id}`;
  const units = renderControllerUnits(user, home, destination);
  try {
    mkdirSync(stage, { mode: 0o755 });
    const tracked = run('/usr/bin/git', ['-C', source, 'ls-files', '-z'])
      .split('\0')
      .filter(Boolean);
    for (const file of tracked) {
      if (
        !/^(?:scripts\/|src\/|package(?:-lock)?\.json$|tsconfig(?:\.[^/]+)?\.json$|\.nvmrc$)/.test(
          file,
        )
      )
        continue;
      const input = join(source, file);
      if (!lstatSync(input).isFile() || realpathSync(input) !== input)
        throw new Error('Controller source must contain regular tracked files');
      const output = join(stage, file);
      mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
      cpSync(input, output);
      chmodSync(output, 0o644);
    }
    cpSync(join(source, 'node_modules'), join(stage, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    cpSync(nodePrefix, join(stage, 'runtime'), { recursive: true, verbatimSymlinks: true });
    ownTree(stage);
    // The controller snapshot never contains ignored application settings or tokens.
    renameSync(stage, destination);
    run(
      '/usr/sbin/runuser',
      [
        ...operatorIdentityArguments(user, primaryGroup, !prepareOnly),
        '--',
        '/usr/bin/env',
        '-i',
        `HOME=${home}`,
        `USER=${user}`,
        `LOGNAME=${user}`,
        `PATH=${destination}/runtime/bin:/usr/local/bin:/usr/bin:/bin`,
        `TS_NODE_PROJECT=${destination}/tsconfig.json`,
        `${destination}/runtime/bin/node`,
        '-r',
        'ts-node/register',
        '-e',
        operatorPreflightScript(!prepareOnly),
      ],
      destination,
    );
    const unitStage = join(destination, 'units');
    mkdirSync(unitStage, { mode: 0o755 });
    for (const [name, content] of Object.entries(units))
      writeFileSync(join(unitStage, name), content, { mode: 0o644, flag: 'wx' });
    // Resolve ExecStart in this immutable snapshot, before replacing current or installed units.
    run('/usr/bin/systemd-analyze', [
      'verify',
      ...Object.keys(units).map((name) => join(unitStage, name)),
    ]);
    const stopTimer = () => {
      if (existsSync(unitPath(timer))) run('/bin/systemctl', ['stop', timer]);
    };
    activateController(
      {
        capture() {
          const units = inspectExistingUnits();
          const timerState = run('/bin/systemctl', [
            'show',
            timer,
            '--property=UnitFileState',
            '--value',
          ]);
          if (!['', 'enabled', 'disabled'].includes(timerState))
            throw new Error('Unsupported timer enablement state');
          return {
            units,
            current: readCurrent(),
            enabled: timerState === 'enabled',
            active:
              run('/bin/systemctl', ['show', timer, '--property=ActiveState', '--value']) ===
              'active',
          };
        },
        stopTimer,
        assertIdle() {
          if (
            ['active', 'activating', 'deactivating', 'reloading'].includes(
              run('/bin/systemctl', ['show', service, '--property=ActiveState', '--value']),
            )
          )
            throw new Error(
              'Wait for the current deployment to finish before updating its controller',
            );
        },
        publish() {
          replaceCurrent(destination, id);
        },
        installUnits() {
          for (const name of Object.keys(units))
            run('/usr/bin/install', ['-m', '0644', '--', join(unitStage, name), unitPath(name)]);
        },
        reload() {
          run('/bin/systemctl', ['daemon-reload']);
        },
        configureTimer(prepare) {
          run('/bin/systemctl', prepare ? ['disable', '--now', timer] : ['enable', '--now', timer]);
        },
        quiesceTimer() {
          if (existsSync(unitPath(timer))) run('/bin/systemctl', ['disable', '--now', timer]);
        },
        restoreCurrent(previous) {
          replaceCurrent(previous.current, id);
        },
        restoreUnits(previous) {
          const failures = [];
          for (const [name, content] of Object.entries(previous.units)) {
            try {
              if (content === null) rmSync(unitPath(name), { force: true });
              else {
                const temporary = join(unitStage, `.restore-${name}`);
                writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
                try {
                  run('/usr/bin/install', ['-m', '0644', '--', temporary, unitPath(name)]);
                } finally {
                  rmSync(temporary, { force: true });
                }
              }
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length)
            throw new AggregateError(failures, 'Restoring controller units failed');
        },
        restoreTimer(previous) {
          if (previous.units[timer] === null) return;
          run('/bin/systemctl', [previous.enabled ? 'enable' : 'disable', timer]);
          run('/bin/systemctl', [previous.active ? 'start' : 'stop', timer]);
        },
      },
      prepareOnly,
    );
    process.stdout.write(
      `Installed ${timer}${prepareOnly ? ' (timer disabled)' : ''}; deployments track dev. Controller snapshot: ${destination}\n`,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof AggregateError
        ? 'Controller installation and restoration failed; inspect timer and unit state before enabling deployment.'
        : 'Controller installation failed; inspect host settings and service state.',
    );
    process.exitCode = 1;
  }
}
