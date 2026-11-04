import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Sample = {
  version: 1;
  root: string;
  measuredAt: number;
  usedBytes: number;
  availableBytes: number;
};
type Options = { root: string; output: string; intervalMs: number; once: boolean };
let sampler: {
  parseArgs(args: string[]): Options;
  safeNumber(value: bigint): number;
  measure(root: string, deps?: { io?: typeof fs; now?: () => number }): Promise<Sample>;
  validateOutput(root: string, output: string): Promise<{ root: string; output: string }>;
  publish(output: string, sample: Sample, deps?: { io?: typeof fs }): Promise<void>;
  run(
    options: Options,
    deps?: {
      signal?: AbortSignal;
      sample?: (root: string) => Promise<Sample>;
      write?: (output: string, sample: Sample) => Promise<void>;
      log?: (error: unknown) => void;
    },
  ): Promise<void>;
};
let temporary: string;
let root: string;
let output: string;
const failure = (code: string) => Object.assign(new Error('Synthetic failure'), { code });
const options = (): Options => ({ root, output, intervalMs: 5, once: true });
beforeAll(async () => {
  sampler = await import(path.join(__dirname, 'sampler.mjs'));
});
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mongo-storage-'));
  root = path.join(temporary, 'data');
  await fs.mkdir(root, { mode: 0o755 });
  await fs.mkdir(path.join(temporary, 'sample'), { mode: 0o755 });
  output = path.join(temporary, 'sample/usage.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

describe('physical capacity measurement', () => {
  it('counts allocated blocks including directory metadata, deduplicates hardlinks, and never follows symlinks', async () => {
    const file = path.join(root, 'large');
    const nested = path.join(root, 'nested');
    const outside = path.join(temporary, 'outside');
    await fs.mkdir(nested);
    await fs.writeFile(file, Buffer.alloc(8192));
    await fs.link(file, path.join(nested, 'hardlink'));
    await fs.writeFile(outside, Buffer.alloc(65536));
    const link = path.join(root, 'outside-link');
    await fs.symlink(outside, link);
    await fs.symlink(temporary, path.join(root, 'directory-link'));
    const sparse = path.join(root, 'sparse');
    const handle = await fs.open(sparse, 'w');
    await handle.truncate(1024 * 1024 * 1024);
    await handle.close();
    const names = [root, nested, file, sparse, link, path.join(root, 'directory-link')];
    const bytes = (await Promise.all(names.map((name) => fs.lstat(name, { bigint: true })))).reduce(
      (sum, info) => sum + info.blocks * 512n,
      0n,
    );
    const before = Date.now();
    const space = await fs.statfs(root, { bigint: true });
    const statfs = vi.fn().mockResolvedValue(space);
    const result = await sampler.measure(root, { now: () => before, io: { ...fs, statfs } });
    expect(result).toEqual({
      version: 1,
      root: await fs.realpath(root),
      measuredAt: before,
      usedBytes: Number(bytes),
      availableBytes: Number(space.bavail * space.bsize),
    });
    expect(statfs).toHaveBeenCalledOnce();
    expect(result.usedBytes).toBeLessThan(1024 * 1024 * 1024);
  });
  it('ignores only ENOENT for vanished children and fails on other traversal errors', async () => {
    await fs.writeFile(path.join(root, 'vanished'), 'test');
    const original = fs.lstat;
    const io = {
      ...fs,
      lstat: vi.fn().mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        if (String(args[0]).endsWith('/vanished')) throw failure('ENOENT');
        return original(...args);
      }),
    };
    expect((await sampler.measure(root, { io })).usedBytes).toBe(
      Number((await fs.lstat(root)).blocks * 512),
    );
    io.lstat.mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]).endsWith('/vanished')) throw failure('EACCES');
      return original(...args);
    });
    await expect(sampler.measure(root, { io })).rejects.toMatchObject({ code: 'EACCES' });
  });
  it('rejects roots that are missing, unreadable, files, or symlinks and rejects special entries', async () => {
    await expect(sampler.measure(path.join(temporary, 'missing'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fs.symlink(root, path.join(temporary, 'alias'));
    await expect(sampler.measure(path.join(temporary, 'alias'))).rejects.toThrow(/not a symlink/);
    await fs.writeFile(path.join(temporary, 'file'), 'x');
    await expect(sampler.measure(path.join(temporary, 'file'))).rejects.toThrow(/directory/);
    await expect(
      sampler.measure(root, {
        io: { ...fs, opendir: vi.fn().mockRejectedValue(failure('EACCES')) },
      }),
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect(spawnSync('/usr/bin/mkfifo', [path.join(root, 'pipe')]).status).toBe(0);
    await expect(sampler.measure(root)).rejects.toThrow(/entry type/);
  });
  it('rejects a directory replaced by a symlink between lstat and open', async () => {
    await fs.mkdir(path.join(root, 'child'));
    const original = fs.lstat;
    const io = {
      ...fs,
      lstat: vi.fn().mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        const info = await original(...args);
        if (String(args[0]).endsWith('/child')) {
          await fs.rename(path.join(root, 'child'), path.join(temporary, 'moved'));
          await fs.symlink(temporary, path.join(root, 'child'));
        }
        return info;
      }),
    };
    await expect(sampler.measure(root, { io })).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
  it('rejects negative, non-bigint, overflowing allocation and free-space measurements', async () => {
    expect(sampler.safeNumber(0n)).toBe(0);
    for (const value of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])
      expect(() => sampler.safeNumber(value)).toThrow(/measurement/);
    expect(() => sampler.safeNumber(1 as unknown as bigint)).toThrow(/measurement/);
    const space = await fs.statfs(root, { bigint: true });
    for (const bavail of [-1n, BigInt(Number.MAX_SAFE_INTEGER)]) {
      await expect(
        sampler.measure(root, {
          io: { ...fs, statfs: vi.fn().mockResolvedValue({ ...space, bavail }) },
        }),
      ).rejects.toThrow(/measurement/);
    }
    await expect(
      sampler.measure(root, {
        io: { ...fs, statfs: vi.fn().mockResolvedValue({ ...space, bsize: 0n }) },
      }),
    ).rejects.toThrow(/block size/);
    const info = await fs.lstat(root, { bigint: true });
    info.blocks = BigInt(Number.MAX_SAFE_INTEGER);
    await expect(
      sampler.measure(root, { io: { ...fs, lstat: vi.fn().mockResolvedValue(info) } }),
    ).rejects.toThrow(/measurement/);
    await expect(sampler.measure(root, { now: () => NaN })).rejects.toThrow(/sample time/);
  });
});

describe('atomic publication and service loop', () => {
  it('publishes complete JSON with mode 0644 through a same-directory rename', async () => {
    const sample = await sampler.measure(root);
    await fs.writeFile(output, 'old');
    const rename = vi.fn().mockImplementation(async (from: string, to: string) => {
      expect(path.dirname(from)).toBe(path.dirname(to));
      expect(await fs.readFile(output, 'utf8')).toBe('old');
      expect(JSON.parse(await fs.readFile(from, 'utf8'))).toEqual(sample);
      await fs.rename(from, to);
    });
    await sampler.publish(output, sample, { io: { ...fs, rename } });
    expect(rename).toHaveBeenCalledOnce();
    expect(JSON.parse(await fs.readFile(output, 'utf8'))).toEqual(sample);
    expect((await fs.stat(output)).mode & 0o777).toBe(0o644);
    expect(await fs.readdir(path.dirname(output))).toEqual(['usage.json']);
  });
  it('removes temporary files and preserves the previous timestamp when publication fails', async () => {
    const sample = await sampler.measure(root, { now: () => 1 });
    await sampler.publish(output, sample);
    await expect(
      sampler.publish(
        output,
        { ...sample, measuredAt: 2 },
        { io: { ...fs, rename: vi.fn().mockRejectedValue(failure('EIO')) } },
      ),
    ).rejects.toMatchObject({ code: 'EIO' });
    expect(JSON.parse(await fs.readFile(output, 'utf8')).measuredAt).toBe(1);
    expect(await fs.readdir(path.dirname(output))).toEqual(['usage.json']);
  });
  it('cleans partial output after a write failure and rechecks the opened output path for overlap', async () => {
    const sample = await sampler.measure(root, { now: () => 1 });
    await sampler.publish(output, sample);
    const open = vi.fn().mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith('.tmp'))
        handle.writeFile = vi.fn().mockRejectedValue(failure('ENOSPC'));
      return handle;
    });
    await expect(
      sampler.publish(output, { ...sample, measuredAt: 2 }, { io: { ...fs, open } }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(JSON.parse(await fs.readFile(output, 'utf8')).measuredAt).toBe(1);
    expect(await fs.readdir(path.dirname(output))).toEqual(['usage.json']);
    await expect(sampler.publish(path.join(root, 'usage.json'), sample)).rejects.toThrow(/overlap/);
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('serializes samples, waits after completion, retains failed samples and stops gracefully', async () => {
    const controller = new AbortController();
    const old = await sampler.measure(root, { now: () => 1 });
    await sampler.publish(output, old);
    let calls = 0;
    let finished = 0;
    let inFlight = false;
    const log = vi.fn();
    await sampler.run(
      { ...options(), once: false },
      {
        signal: controller.signal,
        log,
        sample: async () => {
          expect(inFlight).toBe(false);
          if (calls) expect(Date.now() - finished).toBeGreaterThanOrEqual(4);
          inFlight = true;
          calls++;
          await delay(5);
          inFlight = false;
          finished = Date.now();
          if (calls === 1) throw failure('EACCES');
          expect(JSON.parse(await fs.readFile(output, 'utf8')).measuredAt).toBe(1);
          return { ...old, measuredAt: 2 };
        },
        write: async (target, sample) => {
          await sampler.publish(target, sample);
          controller.abort();
        },
      },
    );
    expect(calls).toBe(2);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(await fs.readFile(output, 'utf8')).measuredAt).toBe(2);
  });
  it('propagates one-shot failures and aborts an idle interval promptly', async () => {
    await expect(
      sampler.run(options(), { sample: vi.fn().mockRejectedValue(failure('EIO')) }),
    ).rejects.toMatchObject({ code: 'EIO' });
    const controller = new AbortController();
    const sample = await sampler.measure(root);
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await sampler.run(
        { ...options(), once: false, intervalMs: 10000 },
        { signal: controller.signal, sample: async () => sample },
      );
    } finally {
      clearTimeout(timer);
    }
  });
  it('rejects overlapping paths through parent aliases, symlink outputs and writable output directories', async () => {
    await expect(sampler.validateOutput(root, path.join(root, 'usage.json'))).rejects.toThrow(
      /overlap/,
    );
    await fs.symlink(root, path.join(temporary, 'alias'));
    await fs.mkdir(path.join(root, 'nested'), { mode: 0o755 });
    await expect(
      sampler.validateOutput(root, path.join(temporary, 'alias/nested/usage.json')),
    ).rejects.toThrow(/overlap/);
    await fs.symlink(path.join(temporary, 'file'), output);
    await expect(sampler.validateOutput(root, output)).rejects.toThrow(/Unsafe existing/);
    await fs.rm(output);
    await fs.chmod(path.dirname(output), 0o777);
    await expect(sampler.validateOutput(root, output)).rejects.toThrow(/not writable by others/);
  });
});

describe('sampler CLI', () => {
  it('requires explicit non-overlapping absolute paths and validates every option', () => {
    expect(sampler.parseArgs(['--root', '/data', '--output', '/run/sample.json'])).toEqual({
      root: '/data',
      output: '/run/sample.json',
      intervalMs: 5000,
      once: false,
    });
    for (const args of [
      [],
      ['--root', 'relative'],
      ['--root', '/data', '--output', '/data/file'],
      ['--root', '/', '--output', '/run/file'],
      ['--root', '/data', '--output', '/out', '--wat'],
      ['--root', '/data', '--output', '/out', '--root', '/other'],
      ['--root', '/data', '--output', '/out', '--interval-ms', '0'],
      ['--root', '/data', '--output', '/out', '--interval-ms', '2147483648'],
    ])
      expect(() => sampler.parseArgs(args)).toThrow();
  });
  it('runs once without dependencies and returns a nonzero status for invalid arguments', async () => {
    const script = path.join(__dirname, 'sampler.mjs');
    const good = spawnSync(
      process.execPath,
      [script, '--root', root, '--output', output, '--once'],
      { encoding: 'utf8' },
    );
    expect(good.status, good.stderr).toBe(0);
    expect(Object.keys(JSON.parse(await fs.readFile(output, 'utf8')))).toEqual([
      'version',
      'root',
      'measuredAt',
      'usedBytes',
      'availableBytes',
    ]);
    const bad = spawnSync(process.execPath, [script, '--root', 'relative'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('failed');
  });
});
