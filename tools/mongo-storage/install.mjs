#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlaps } from './sampler.mjs';

export const marker = '# Managed by Pleiades MongoDB storage sampler v1\n';
export const scriptMarker =
  '#!/usr/bin/env node\n// Managed by Pleiades MongoDB storage sampler v1\n';
export const paths = Object.freeze({
  node: '/opt/pleiades-auto-deploy/current/runtime/bin/node',
  script: '/usr/local/libexec/pleiades-mongo-storage.mjs',
  unit: '/etc/systemd/system/pleiades-mongo-storage.service',
  output: '/run/pleiades-mongo-storage/usage.json',
});
const unitName = 'pleiades-mongo-storage.service';
const account = 'pleiades-mongo';
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const usage =
  'Usage: install.mjs --mongo-data-root <actual absolute dbPath> [--node <official Node executable>] [--dry-run]';
export function safePath(value) {
  if (
    typeof value !== 'string' ||
    !/^\/[A-Za-z0-9_./-]+$/.test(value) ||
    resolve(value) !== value ||
    value === '/'
  )
    throw new Error(
      'Unsafe path: use a normalized absolute path without whitespace or systemd expansion',
    );
  return value;
}
function visiblePath(value) {
  safePath(value);
  if (
    ['/home', '/root', '/run/user', '/tmp', '/var/tmp'].some(
      (base) => value === base || value.startsWith(`${base}/`),
    )
  )
    throw new Error(
      'Path is hidden by service hardening; use a root-owned runtime or data path outside home and temporary directories',
    );
  return value;
}
export function parseArgs(args) {
  const options = { node: paths.node, dryRun: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error(usage);
    seen.add(key);
    if (key === '--dry-run') options.dryRun = true;
    else if (key === '--mongo-data-root' || key === '--node') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(usage);
      options[key === '--node' ? 'node' : 'root'] = visiblePath(value);
    } else throw new Error(usage);
  }
  if (
    !options.root ||
    [dirname(paths.output), paths.script, paths.unit, options.node].some((path) =>
      overlaps(options.root, path),
    )
  )
    throw new Error(usage);
  return options;
}
export function renderUnit({ root, node }) {
  visiblePath(root);
  visiblePath(node);
  return `${marker}[Unit]
Description=Pleiades MongoDB physical capacity sampler
After=local-fs.target

[Service]
Type=exec
User=pleiades-mongo
Group=pleiades-mongo
SupplementaryGroups=
ExecStart=${node} ${paths.script} --root ${root} --output ${paths.output} --interval-ms 5000
Environment=NODE_OPTIONS= NODE_PATH=
RuntimeDirectory=pleiades-mongo-storage
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=no
UMask=0022
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
KillSignal=SIGTERM
KillMode=control-group
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${root}
ReadWritePaths=/run/pleiades-mongo-storage
PrivateNetwork=true
IPAddressDeny=any
RestrictAddressFamilies=none
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}
function run(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${program} ${args[0] ?? ''} failed; check prerequisites and service-account access`,
    );
  return result.stdout.trim();
}
function optionalInfo(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}
export function assertTrusted(path, { allowSymlinks = false } = {}) {
  safePath(path);
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (
      info.uid !== 0 ||
      (info.isSymbolicLink() ? !allowSymlinks : !!(info.mode & 0o022)) ||
      (!info.isSymbolicLink() &&
        !(current === path ? info.isFile() || info.isDirectory() : info.isDirectory()))
    )
      throw new Error('Prerequisite and ancestors must be root-owned and writable only by root');
    if (info.isSymbolicLink()) assertTrusted(realpathSync(current));
    if (current === '/') break;
  }
}
export function validateInstallTarget(info, content, expectedMarker) {
  if (
    info &&
    (!info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      info.mode & 0o022 ||
      !content.startsWith(expectedMarker))
  )
    throw new Error('Refusing an unsafe or unmanaged installation target');
}
export function checkTarget(path, expectedMarker) {
  assertTrusted(dirname(path));
  const info = optionalInfo(path);
  // Reject unsafe metadata before reading so special files cannot block the installer.
  validateInstallTarget(info, expectedMarker, expectedMarker);
  validateInstallTarget(
    info,
    info?.isFile() && !info.isSymbolicLink() ? readFileSync(path, 'utf8') : '',
    expectedMarker,
  );
}
export function validateMetadata(metadata, version, architecture) {
  if (
    !/^22\.\d+\.\d+$/.test(version) ||
    !['x64', 'arm64'].includes(architecture) ||
    metadata.version !== version ||
    metadata.source !==
      `https://nodejs.org/dist/v${version}/node-v${version}-linux-${architecture}.tar.xz` ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  )
    throw new Error('Prepare a verified official runtime matching .nvmrc first');
}
function verifyRuntime(node) {
  assertTrusted(node, { allowSymlinks: true });
  const resolved = visiblePath(realpathSync(node));
  assertTrusted(resolved);
  if (!lstatSync(resolved).isFile()) throw new Error('Node executable must be a regular file');
  const metadataPath = join(dirname(resolved), '../.pleiades-runtime.json');
  assertTrusted(resolve(metadataPath));
  const version = readFileSync(join(sourceDirectory, '../../.nvmrc'), 'utf8').trim();
  validateMetadata(JSON.parse(readFileSync(metadataPath, 'utf8')), version, process.arch);
  if (
    run(resolved, ['--version']) !== `v${version}` ||
    run('/usr/sbin/runuser', ['-u', account, '--', resolved, '--version']) !== `v${version}`
  )
    throw new Error(
      'Node runtime version or database-account executable access is invalid; use --node with an accessible root-owned official runtime',
    );
  return resolved;
}
export function validateDataPath(root, uid, gid) {
  for (let current = root; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ![0, uid].includes(info.uid) ||
      info.mode & 0o002 ||
      (info.mode & 0o020 && info.gid !== gid)
    )
      throw new Error(
        'Data path ancestors must be directories controlled only by root or the database account',
      );
    if (current === '/') break;
  }
}
function verifyRuntimeDirectory(uid, gid, managed) {
  const directory = dirname(paths.output);
  const info = optionalInfo(directory);
  if (!info) return;
  if (
    !managed ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    info.gid !== gid ||
    (info.mode & 0o7777) !== 0o755
  )
    throw new Error('Unsafe or unmanaged sample runtime directory');
  for (const name of readdirSync(directory)) {
    const entry = lstatSync(join(directory, name));
    if (
      name !== 'usage.json' ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.uid !== uid ||
      entry.gid !== gid ||
      (entry.mode & 0o7777) !== 0o644
    )
      throw new Error('Unsafe existing sample output');
  }
}
function inspectUnit() {
  for (const base of [
    '/etc/systemd/system',
    '/run/systemd/system',
    '/usr/lib/systemd/system',
    '/usr/local/lib/systemd/system',
    '/lib/systemd/system',
  ]) {
    for (const name of [
      'service.d',
      'pleiades-.service.d',
      'pleiades-mongo-.service.d',
      `${unitName}.d`,
    ]) {
      if (optionalInfo(join(base, name)))
        throw new Error('Review inherited and sampler-specific unit drop-ins before installing');
    }
  }
  const fragment = run('/usr/bin/systemctl', [
    'show',
    unitName,
    '--property=FragmentPath',
    '--value',
  ]);
  const dropIns = run('/usr/bin/systemctl', [
    'show',
    unitName,
    '--property=DropInPaths',
    '--value',
  ]);
  if ((fragment && fragment !== paths.unit) || dropIns)
    throw new Error('Refusing an unmanaged unit or drop-ins');
  const enabled = `/etc/systemd/system/multi-user.target.wants/${unitName}`;
  if (optionalInfo(dirname(enabled))) assertTrusted(dirname(enabled));
  const info = optionalInfo(enabled);
  if (info && (!info.isSymbolicLink() || realpathSync(enabled) !== paths.unit))
    throw new Error('Unsafe sampler enablement target');
}
export function readPreflightSample(file, uid, gid) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== uid ||
      info.gid !== gid ||
      (info.mode & 0o7777) !== 0o644 ||
      info.size > 65536
    )
      throw new Error('Unsafe preflight sample file');
    const buffer = Buffer.alloc(65537);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 65536) throw new Error('Oversized preflight sample');
    try {
      return JSON.parse(buffer.subarray(0, length).toString('utf8'));
    } catch {
      throw new Error('Invalid preflight sample JSON');
    }
  } finally {
    closeSync(fd);
  }
}
function atomicInstall(target, content) {
  const temporary = join(dirname(target), `.mongo-storage-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 });
    chownSync(temporary, 0, 0);
    chmodSync(temporary, 0o644);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function main(
  args = process.argv.slice(2),
  { getuid = process.getuid, log = (message) => process.stdout.write(`${message}\n`) } = {},
) {
  const options = parseArgs(args);
  if (options.dryRun) {
    log(
      JSON.stringify(
        {
          ...options,
          script: paths.script,
          unit: paths.unit,
          output: paths.output,
          unitContent: renderUnit(options),
          note: 'Read-only plan; installation checks runtime, account, data-tree access and publication. Confirm active dbPath and service sandbox separately.',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (getuid() !== 0)
    throw new Error(
      'Reviewed sampler installation requires root; use --dry-run for a non-root plan',
    );
  const originalRoot = options.root;
  const rootInfo = lstatSync(originalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('MongoDB data root must be a directory, not a symlink');
  options.root = visiblePath(realpathSync(originalRoot));
  if (
    [paths.script, paths.unit, dirname(paths.output), options.node].some((path) =>
      overlaps(options.root, path),
    )
  )
    throw new Error('Data root overlaps installer paths');
  const uid = Number(run('/usr/bin/id', ['-u', account]));
  const gid = Number(run('/usr/bin/getent', ['group', account]).split(':')[2]);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0)
    throw new Error('Database service account and group must already exist');
  if (Number(run('/usr/bin/id', ['-g', account])) !== gid)
    throw new Error('Database account must use the matching primary group');
  validateDataPath(options.root, uid, gid);
  options.node = verifyRuntime(options.node);
  if (overlaps(options.root, options.node))
    throw new Error('Data root overlaps the resolved runtime');
  checkTarget(paths.script, scriptMarker);
  checkTarget(paths.unit, marker);
  assertTrusted('/run');
  inspectUnit();
  verifyRuntimeDirectory(uid, gid, !!optionalInfo(paths.unit));
  const source = readFileSync(join(sourceDirectory, 'sampler.mjs'), 'utf8');
  if (!source.startsWith(scriptMarker)) throw new Error('Sampler source marker is invalid');
  const unit = renderUnit(options);
  const staging = mkdtempSync('/run/pleiades-mongo-storage-install-');
  try {
    chmodSync(staging, 0o755);
    const stagedScript = join(staging, 'sampler.mjs');
    const stagedUnit = join(staging, unitName);
    writeFileSync(stagedScript, source, { flag: 'wx', mode: 0o644 });
    writeFileSync(stagedUnit, unit, { flag: 'wx', mode: 0o644 });
    chmodSync(stagedScript, 0o644);
    chmodSync(stagedUnit, 0o644);
    run('/usr/bin/systemd-analyze', ['verify', stagedUnit]);
    const scratch = join(staging, 'sample');
    mkdirSync(scratch, { mode: 0o700 });
    chownSync(scratch, uid, gid);
    const output = join(scratch, 'usage.json');
    const before = Date.now();
    run('/usr/sbin/runuser', [
      '-u',
      account,
      '--',
      options.node,
      stagedScript,
      '--root',
      options.root,
      '--output',
      output,
      '--once',
    ]);
    const sample = readPreflightSample(output, uid, gid);
    if (
      !sample ||
      Object.keys(sample).sort().join(',') !== 'availableBytes,measuredAt,root,usedBytes,version' ||
      sample.version !== 1 ||
      sample.root !== options.root ||
      !Number.isSafeInteger(sample.measuredAt) ||
      sample.measuredAt < before ||
      sample.measuredAt > Date.now() ||
      !Number.isSafeInteger(sample.usedBytes) ||
      sample.usedBytes < 0 ||
      !Number.isSafeInteger(sample.availableBytes) ||
      sample.availableBytes < 0
    )
      throw new Error('Database-account sample preflight failed');
    checkTarget(paths.script, scriptMarker);
    checkTarget(paths.unit, marker);
    atomicInstall(paths.script, source);
    atomicInstall(paths.unit, unit);
    run('/usr/bin/systemctl', ['daemon-reload']);
    run('/usr/bin/systemctl', ['enable', unitName]);
    run('/usr/bin/systemctl', ['restart', unitName]);
    log(`Installed ${unitName}; verify ${paths.output} freshness before enabling the bot reader.`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Sampler installation failed'}\n`,
    );
    process.exitCode = 1;
  }
}
