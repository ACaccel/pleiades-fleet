import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmVersion = '10.9.2';
const metadataName = '.pleiades-runtime.json';

export async function runtimeVersion(root = projectRoot) {
  const version = (await readFile(join(root, '.nvmrc'), 'utf8')).trim();
  if (!/^22\.\d+\.\d+$/.test(version)) {
    throw new Error('.nvmrc must pin an exact Node.js 22 version.');
  }
  return version;
}

export function runtimeName(version, platform = hostPlatform(), architecture = hostArch()) {
  if (!/^22\.\d+\.\d+$/.test(version)) throw new Error('Invalid pinned Node.js version.');
  if (platform !== 'linux' || !['x64', 'arm64'].includes(architecture)) {
    throw new Error('Official runtime setup supports Linux x64 and arm64 only.');
  }
  return `node-v${version}-${platform}-${architecture}`;
}

export async function runtimeDirectory(root = projectRoot, environment = process.env) {
  const configured = environment.PLEIADES_NODE_PREFIX;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error('PLEIADES_NODE_PREFIX must be absolute.');
    return configured;
  }
  return join(root, '.runtime', runtimeName(await runtimeVersion(root)));
}

async function downloadOfficial(url, destination, maxBytes) {
  if (url.protocol !== 'https:' || url.hostname !== 'nodejs.org') {
    throw new Error('Node.js downloads must use the official HTTPS host.');
  }
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Node.js download failed (${response.status}): ${url.pathname}`);
  }
  let received = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(
        received > maxBytes ? new Error('Node.js download exceeds the size limit.') : null,
        chunk,
      );
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    limit,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  );
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Runtime command failed: ${executable} ${args.join(' ')}\n${result.stderr || ''}`,
    );
  return result.stdout.trim();
}

function environment(prefix) {
  const value = {
    ...process.env,
    PATH: `${join(prefix, 'bin')}:${process.env.PATH || ''}`,
  };
  delete value.NODE_PATH;
  delete value.npm_config_prefix;
  delete value.NPM_CONFIG_PREFIX;
  return value;
}

function validateInstalled(prefix, version) {
  const node = join(prefix, 'bin/node');
  const npm = join(prefix, 'lib/node_modules/npm/bin/npm-cli.js');
  if (
    !existsSync(node) ||
    !existsSync(npm) ||
    run(node, ['--version']) !== `v${version}` ||
    run(node, [npm, '--version'], { env: environment(prefix) }) !== npmVersion
  ) {
    throw new Error(
      `Invalid existing Node.js runtime at ${prefix}; move it aside before retrying.`,
    );
  }
}

/** Publish a complete, checksum-verified runtime without changing an existing runtime. */
export async function installNode({
  root = projectRoot,
  platform = hostPlatform(),
  arch = hostArch(),
  download = downloadOfficial,
} = {}) {
  const version = await runtimeVersion(root);
  const name = runtimeName(version, platform, arch);
  const directory = join(root, '.runtime');
  const destination = join(directory, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, '.setup-node.lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Node.js setup is already running; recover a stale .runtime/.setup-node.lock only after confirming no setup process remains.',
      );
    throw error;
  }
  let temporary;
  try {
    if (existsSync(destination)) {
      const metadata = JSON.parse(await readFile(join(destination, metadataName), 'utf8'));
      if (
        metadata.version !== version ||
        metadata.npmVersion !== npmVersion ||
        metadata.source !== `https://nodejs.org/dist/v${version}/${name}.tar.xz` ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256)
      ) {
        throw new Error(
          `Invalid runtime metadata at ${destination}; move it aside before retrying.`,
        );
      }
      validateInstalled(destination, version);
      return destination;
    }
    temporary = await mkdtemp(join(directory, '.node-install-'));
    const archiveName = `${name}.tar.xz`;
    const archive = join(temporary, archiveName);
    const checksums = join(temporary, 'SHASUMS256.txt');
    const base = `https://nodejs.org/dist/v${version}/`;
    await download(new URL('SHASUMS256.txt', base), checksums, 1_048_576);
    const matches = (await readFile(checksums, 'utf8'))
      .split('\n')
      .map((line) => /^([a-f0-9]{64})\s+\*?([^\s]+)\r?$/.exec(line))
      .filter((entry) => entry?.[2] === archiveName);
    if (matches.length !== 1)
      throw new Error('Official checksum manifest has no unique matching Node.js archive.');
    const expected = matches[0][1];
    await download(new URL(archiveName, base), archive, 134_217_728);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== expected)
      throw new Error('Node.js archive SHA-256 verification failed.');
    const entries = run('tar', ['-tJf', archive]).split('\n');
    if (entries.some((entry) => !entry.startsWith(`${name}/`) || entry.split('/').includes('..'))) {
      throw new Error('Unexpected paths in the official Node.js archive.');
    }
    const stage = join(temporary, 'runtime');
    await mkdir(stage, { mode: 0o700 });
    run('tar', ['-xJf', archive, '--strip-components=1', '--no-same-owner', '-C', stage]);
    const node = join(stage, 'bin/node');
    const npm = join(stage, 'lib/node_modules/npm/bin/npm-cli.js');
    if (run(node, ['--version']) !== `v${version}`)
      throw new Error('Downloaded Node.js version does not match .nvmrc.');
    run(
      node,
      [
        npm,
        'install',
        '--global',
        '--prefix',
        stage,
        `npm@${npmVersion}`,
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
      ],
      { env: environment(stage) },
    );
    validateInstalled(stage, version);
    await writeFile(
      join(stage, metadataName),
      `${JSON.stringify({ version, npmVersion, source: new URL(archiveName, base).href, sha256: expected }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(stage, destination);
    return destination;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installNode()
    .then((prefix) => process.stdout.write(`${prefix}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
