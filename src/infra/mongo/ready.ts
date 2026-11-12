import { setTimeout as delay } from 'node:timers/promises';

import { mongo } from 'mongoose';

/** Upper bound of one connection attempt, so a hung server cannot consume the whole budget. */
const ATTEMPT_BUDGET_MS = 2_000;
const RETRY_DELAY_MS = 500;

interface WaitForMongoOptions {
  /** Called once, after the first failed attempt, so the caller can say it is waiting. */
  readonly onUnavailable?: () => void;
}

/**
 * Wait until MongoDB at `uri` answers a ping, for at most `timeoutSeconds`.
 *
 * A supervisor starts a bot before its database may accept connections; waiting
 * here, before the bot logs in to Discord, keeps startup all-or-nothing instead
 * of leaving guilds disabled until the recovery loop reconnects them.
 *
 * @throws {Error} when the deadline passes. The message carries no driver
 *   detail because driver errors can include credentials or topology addresses.
 */
export const waitForMongoReady = async (
  uri: string,
  timeoutSeconds: number,
  options: WaitForMongoOptions = {},
): Promise<void> => {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let reported = false;
  do {
    const budget = Math.max(1, Math.min(ATTEMPT_BUDGET_MS, deadline - Date.now()));
    const client = new mongo.MongoClient(uri, {
      serverSelectionTimeoutMS: budget,
      connectTimeoutMS: budget,
      socketTimeoutMS: budget,
      timeoutMS: budget,
    });
    try {
      await client.connect();
      await client.db().command({ ping: 1 });
      return;
    } catch {
      // Intentionally dropped: see the @throws note.
    } finally {
      await client.close().catch(() => undefined);
    }
    if (!reported) {
      reported = true;
      options.onUnavailable?.();
    }
    await delay(Math.min(RETRY_DELAY_MS, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(
    'MongoDB did not become ready before the deadline; inspect the service journal and credentials',
  );
};
