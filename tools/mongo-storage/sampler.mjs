#!/usr/bin/env node
// Managed by Pleiades MongoDB storage sampler v1
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const usage =
  'Usage: sampler.mjs --root <absolute directory> --output <absolute file> [--interval-ms <positive milliseconds>] [--once]';

export function absolutePath(value) {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('Expected an absolute path without control characters');
  return resolve(value);
}
export function overlaps(a, b) {
  return (
    a === b || a.startsWith(`${b === '/' ? '' : b}/`) || b.startsWith(`${a === '/' ? '' : a}/`)
  );
}
export function safeNumber(value) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX)
    throw new Error('Invalid or overflowing storage measurement');
  return Number(value);
}
function product(a, b) {
  safeNumber(a);
  safeNumber(b);
  return safeNumber(a * b);
}
export function parseArgs(args) {
  const result = { intervalMs: 5000, once: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error(usage);
    seen.add(key);
    if (key === '--once') result.once = true;
    else if (['--root', '--output', '--interval-ms'].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(usage);
      if (key === '--interval-ms') {
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) throw new Error(usage);
        result.intervalMs = Number(value);
      } else result[key.slice(2)] = absolutePath(value);
    } else throw new Error(usage);
  }
  if (!result.root || !result.output || overlaps(result.root, result.output))
    throw new Error(usage);
  return result;
}

// Linux fd-relative paths keep directory replacement from redirecting traversal through a symlink.
export async function measure(root, { io = fs, now = Date.now } = {}) {
  root = absolutePath(root);
  const measuredAt = now();
  if (!Number.isSafeInteger(measuredAt) || measuredAt < 0) throw new Error('Invalid sample time');
  const rootInfo = await io.lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('Root must be a directory, not a symlink');
  const canonical = await io.realpath(root);
  const seen = new Set();
  let used = 0n;
  let availableBytes;
  async function walk(path, info, isRoot = false) {
    if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink())
      throw new Error('Unsupported filesystem entry type');
    const key = `${info.dev}:${info.ino}`;
    if (seen.has(key)) return;
    seen.add(key);
    used += BigInt(product(info.blocks, 512n));
    safeNumber(used);
    if (!info.isDirectory()) return;
    const handle = await io.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const actual = await handle.stat({ bigint: true });
      if (actual.dev !== info.dev || actual.ino !== info.ino)
        throw new Error('Directory changed during measurement');
      const anchored = `/proc/self/fd/${handle.fd}`;
      if (isRoot) {
        const space = await io.statfs(anchored, { bigint: true });
        if (typeof space.bsize !== 'bigint' || space.bsize <= 0n)
          throw new Error('Invalid filesystem block size');
        availableBytes = product(space.bavail, space.bsize);
      }
      const directory = await io.opendir(anchored);
      for await (const entry of directory) {
        const child = join(anchored, entry.name);
        try {
          const childInfo = await io.lstat(child, { bigint: true });
          await walk(child, childInfo);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    } finally {
      await handle.close();
    }
  }
  await walk(canonical, rootInfo, true);
  return { version: 1, root: canonical, measuredAt, usedBytes: safeNumber(used), availableBytes };
}

export async function validateOutput(root, output) {
  root = absolutePath(root);
  output = absolutePath(output);
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('Root must be a directory, not a symlink');
  const canonicalRoot = await fs.realpath(root);
  const parent = dirname(output);
  const info = await fs.lstat(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    info.mode & 0o022
  )
    throw new Error('Output directory must be owned by the sampler and not writable by others');
  const canonicalParent = await fs.realpath(parent);
  const canonicalOutput = join(canonicalParent, basename(output));
  if (overlaps(canonicalRoot, canonicalOutput)) throw new Error('Root and output must not overlap');
  try {
    const current = await fs.lstat(canonicalOutput);
    if (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid())
      throw new Error('Unsafe existing output file');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { root: canonicalRoot, output: canonicalOutput };
}

export async function publish(output, sample, { io = fs } = {}) {
  const parent = await io.open(
    dirname(output),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const directory = `/proc/self/fd/${parent.fd}`;
  const target = join(directory, basename(output));
  const temporary = join(directory, `.usage-${randomUUID()}.tmp`);
  let created = false;
  try {
    const info = await parent.stat();
    if (info.uid !== process.getuid() || info.mode & 0o022)
      throw new Error('Unsafe output directory');
    if (overlaps(sample.root, join(await io.realpath(directory), basename(output))))
      throw new Error('Root and output must not overlap');
    const handle = await io.open(temporary, 'wx', 0o644);
    created = true;
    try {
      await handle.chmod(0o644);
      await handle.writeFile(`${JSON.stringify(sample)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.rename(temporary, target);
  } finally {
    try {
      if (created) await io.rm(temporary, { force: true });
    } finally {
      await parent.close();
    }
  }
}
export async function run(
  options,
  { signal, sample = measure, write = publish, log = briefError } = {},
) {
  const paths = await validateOutput(options.root, options.output);
  do {
    if (signal?.aborted) return;
    try {
      await write(paths.output, await sample(paths.root));
    } catch (error) {
      if (options.once) throw error;
      log(error);
    }
    if (options.once || signal?.aborted) return;
    try {
      await delay(options.intervalMs, undefined, { signal });
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
  } while (!signal?.aborted);
}
function briefError(error) {
  // Avoid logging filesystem names, database details, or raw exception text.
  const code =
    typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'INVALID_SAMPLE';
  process.stderr.write(`MongoDB storage sample failed (${code})\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await run(parseArgs(process.argv.slice(2)), { signal: controller.signal });
  } catch (error) {
    briefError(error);
    process.exitCode = 1;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
