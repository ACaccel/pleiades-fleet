import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

import { ArchiveCapacityError } from '../../core/archive/errors';

const SAMPLE_BYTES_LIMIT = 4096;
const SAMPLE_WAIT_MS = 10_000;
const SAMPLE_POLL_MS = 250;

const storageSampleSchema = z
  .object({
    version: z.literal(1),
    root: z.string().refine(isAbsolute),
    measuredAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    usedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    availableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

type MongoStorageSample = z.infer<typeof storageSampleSchema>;

const missing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const readSample = async (file: string): Promise<MongoStorageSample | undefined> => {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > SAMPLE_BYTES_LIMIT || stat.mode & 0o022)
      throw new ArchiveCapacityError('MongoDB storage sample must be a bounded read-only file');
    const bytes = Buffer.alloc(SAMPLE_BYTES_LIMIT + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > SAMPLE_BYTES_LIMIT)
      throw new ArchiveCapacityError('MongoDB storage sample exceeds its size limit');
    const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    const result = storageSampleSchema.safeParse(parsed);
    if (!result.success) throw new ArchiveCapacityError('MongoDB storage sample is invalid');
    return result.data;
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof ArchiveCapacityError) throw error;
    throw new ArchiveCapacityError('MongoDB storage sample cannot be read');
  } finally {
    await handle?.close();
  }
};

/**
 * Wait for a physical sample begun after this request. Reusing an older file would
 * let the monitor retire allocations the database sampler has not observed yet.
 * `expectedRoot` binds admission to the operator-verified MongoDB dbPath.
 */
export const waitForMongoStorageSample = async (
  file: string,
  expectedRoot: string,
  after: number,
): Promise<MongoStorageSample> => {
  if (!isAbsolute(file) || !isAbsolute(expectedRoot) || !Number.isSafeInteger(after) || after < 0)
    throw new TypeError('Invalid MongoDB storage sample request');
  const deadline = performance.now() + SAMPLE_WAIT_MS;
  do {
    const sample = await readSample(file);
    if (sample !== undefined) {
      if (sample.measuredAt > Date.now())
        throw new ArchiveCapacityError('MongoDB storage sample is dated in the future');
      if (resolve(sample.root) !== resolve(expectedRoot))
        throw new ArchiveCapacityError('MongoDB storage sample does not match storage.dbPath');
      if (sample.measuredAt > after) return sample;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(SAMPLE_POLL_MS, remaining)));
  } while (performance.now() < deadline);
  throw new ArchiveCapacityError(
    'MongoDB storage sample is missing or stale; check the sampler service',
  );
};
