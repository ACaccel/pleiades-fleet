import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForMongoStorageSample } from '../../../../src/infra/archive/storage-sample';
import {
  ArchiveStorageSampler,
  measureStorageRoots,
} from '../../../../src/infra/archive/storage-usage';
import { parseArchiveSettings } from '../../../../src/plugins/message-backup/config';
import { ArchiveStorageMonitor } from '../../../../src/plugins/message-backup/runtime/storage-monitor';

let directory: string;
let file: string;
const databaseRoot = '/unreadable-database/data';
const sample = () => ({
  version: 1,
  root: databaseRoot,
  measuredAt: Date.now(),
  usedBytes: 100,
  availableBytes: 10_000_000,
});
const publish = async (value: unknown) => {
  await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o644 });
  await rename(`${file}.tmp`, file);
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pleiades-storage-sample-'));
  file = join(directory, 'usage.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const expireWait = () =>
  vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10_001);

describe('MongoDB capacity sample reader', () => {
  it('reads the standalone producer contract through its real CLI', async () => {
    const root = join(directory, 'data');
    await mkdir(root);
    await writeFile(join(root, 'collection.wt'), Buffer.alloc(8192));
    const after = Date.now();
    execFileSync(process.execPath, [
      join(__dirname, '../../../../tools/mongo-storage/sampler.mjs'),
      '--root',
      root,
      '--output',
      file,
      '--once',
    ]);
    const result = await waitForMongoStorageSample(file, root, after);
    expect(result.usedBytes).toBe((await measureStorageRoots([root])).usedBytes);
    expect(result.availableBytes).toBeGreaterThan(0);
  });

  it('accepts a new complete physical sample without reading the database directory', async () => {
    const value = sample();
    await publish(value);
    expect(await waitForMongoStorageSample(file, databaseRoot, value.measuredAt - 1)).toEqual(
      value,
    );
  });

  it('fails closed on missing, stale and reused measurements', async () => {
    expireWait();
    await expect(waitForMongoStorageSample(file, databaseRoot, Date.now())).rejects.toThrow(
      'missing or stale',
    );
    vi.restoreAllMocks();
    const value = sample();
    await publish(value);
    expireWait();
    await expect(waitForMongoStorageSample(file, databaseRoot, value.measuredAt)).rejects.toThrow(
      'missing or stale',
    );
  });

  it.each([
    { version: 2 },
    { usedBytes: -1 },
    { availableBytes: 1.5 },
    { usedBytes: Number.MAX_SAFE_INTEGER + 1 },
    { root: 'relative/data' },
    { measuredAt: -1 },
    { extra: 'unexpected' },
  ])('rejects invalid sample fields: %j', async (patch) => {
    await publish({ ...sample(), ...patch });
    await expect(waitForMongoStorageSample(file, databaseRoot, 0)).rejects.toThrow('invalid');
  });

  it('rejects future timestamps and samples from another database root', async () => {
    await publish({ ...sample(), measuredAt: Date.now() + 60_000 });
    await expect(waitForMongoStorageSample(file, databaseRoot, 0)).rejects.toThrow('future');
    await publish(sample());
    await expect(waitForMongoStorageSample(file, '/other-database', 0)).rejects.toThrow(
      'storage.dbPath',
    );
  });

  it('rejects symlinks, oversized files, invalid JSON and writable samples', async () => {
    await publish(sample());
    await symlink(file, join(directory, 'link'));
    await expect(
      waitForMongoStorageSample(join(directory, 'link'), databaseRoot, 0),
    ).rejects.toThrow('cannot be read');
    await writeFile(file, ' '.repeat(4097));
    await expect(waitForMongoStorageSample(file, databaseRoot, 0)).rejects.toThrow('bounded');
    await writeFile(file, '{');
    await expect(waitForMongoStorageSample(file, databaseRoot, 0)).rejects.toThrow(
      'cannot be read',
    );
    await publish(sample());
    await chmod(file, 0o666);
    await expect(waitForMongoStorageSample(file, databaseRoot, 0)).rejects.toThrow('read-only');
    await expect(waitForMongoStorageSample(directory, databaseRoot, 0)).rejects.toThrow('bounded');
  });

  it('waits for a newer publication instead of retiring unobserved allocations', async () => {
    await publish({ ...sample(), measuredAt: Date.now() - 1000 });
    const after = Date.now();
    const waiting = waitForMongoStorageSample(file, databaseRoot, after);
    let publication = Promise.resolve();
    const timer = setTimeout(() => {
      publication = publish(sample());
    }, 30);
    try {
      const result = await waiting;
      expect(result.measuredAt).toBeGreaterThan(after);
    } finally {
      clearTimeout(timer);
      await publication;
    }
  });

  it('uses external live bytes while measuring stable roots locally', async () => {
    const stableRoot = join(directory, 'project');
    await mkdir(stableRoot);
    await writeFile(join(stableRoot, 'code'), Buffer.alloc(4096));
    const stable = await measureStorageRoots([stableRoot]);
    const sampler = new ArchiveStorageSampler({
      resolveRoots: async () => ({ stable: [stableRoot], live: [databaseRoot] }),
      mongoUsageFile: file,
    });
    let publication = Promise.resolve();
    const publishTimer = setInterval(() => {
      publication = publication.then(() => publish(sample()));
    }, 30);
    try {
      const result = await sampler.sample();
      expect(result.usedBytes).toBe(stable.usedBytes + 100);
      expect(result.roots).toEqual([stableRoot, databaseRoot]);
      const monitor = new ArchiveStorageMonitor(() => sampler.sample(), {
        budgetBytes: 1_000_000,
        backgroundLimitBytes: 900_000,
        reserveBytes: 1000,
      });
      await expect(monitor.withReservation(1000, false, async () => 'written')).resolves.toBe(
        'written',
      );
    } finally {
      clearInterval(publishTimer);
      await publication;
    }
  });

  it('validates the external sample path and data root without adding JSON fields', () => {
    const settings = {
      backupServers: [],
      mongoUsageFile: file,
      runtime: { storage: { mongo_data_root: databaseRoot } },
    };
    const parsed = parseArchiveSettings(settings).config.storage;
    expect(parsed.mongo_data_root).toBe(databaseRoot);
    expect(parsed).not.toHaveProperty('mongo_usage_file');
    expect(() => parseArchiveSettings({ ...settings, runtime: {} })).toThrow('absolute');
    expect(() => parseArchiveSettings({ ...settings, mongoUsageFile: 'relative.json' })).toThrow(
      'absolute',
    );
  });
});
