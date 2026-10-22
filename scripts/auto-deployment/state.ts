import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  NotificationSchema,
  THREAD_KEY_PATTERN,
} from '../../src/plugins/notification-relay/internal/request';
import { AUTO_BOTS, type AutoDeploymentState } from './contracts';
import { MAX_OUTBOX_THREADS } from './notifications';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const bots = z.array(z.enum(AUTO_BOTS)).max(AUTO_BOTS.length);
const targets = z
  .object({
    bots,
    databaseServices: z.array(z.literal('mongodb-pleiades.service')).max(1),
  })
  .strict();
const timestamp = z.number().finite().nonnegative();
const schema = z
  .object({
    version: z.literal(1),
    deployed: z.record(z.enum(AUTO_BOTS), sha),
    lastInspectedSha: sha.optional(),
    attemptedSha: sha.optional(),
    attempt: z.number().int().nonnegative(),
    blockedBuildSha: sha.optional(),
    install: z
      .object({
        sha,
        checkout: z.object({ directory: z.string().startsWith('/'), sha }).strict(),
        targets,
        attempt: z.number().int().positive(),
      })
      .strict()
      .optional(),
    outbox: z
      .array(
        z
          .object({
            key: z.string().regex(THREAD_KEY_PATTERN),
            notification: NotificationSchema,
            attempts: z.number().int().nonnegative(),
            nextAttemptAt: timestamp,
            updatedAt: timestamp,
          })
          .strict(),
      )
      .max(MAX_OUTBOX_THREADS),
  })
  .strict();

export function parseControllerState(input: unknown): AutoDeploymentState {
  return schema.parse(input);
}

export async function readControllerState(
  path: string,
  ownerUid: number,
): Promise<AutoDeploymentState | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw new Error('Cannot open protected auto-deployment state');
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== ownerUid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 262_144
    )
      throw new Error('Invalid auto-deployment state ownership, permissions or size');
    return parseControllerState(JSON.parse(await file.readFile('utf8')) as unknown);
  } finally {
    await file.close();
  }
}

/** Caller must hold the controller's whole-cycle lock; failed writes preserve the old file. */
export async function writeControllerState(
  path: string,
  state: AutoDeploymentState,
): Promise<void> {
  const serialized = JSON.stringify(parseControllerState(state));
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
