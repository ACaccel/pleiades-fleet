/**
 * Startup failure policy for the personality entry points.
 *
 * `BaseBot.run()` rejects when a startup phase cannot complete — most
 * often a rejected Discord login (bad token, unreachable gateway). A
 * detached `run()`
 * turns that rejection into a live process with no commands registered,
 * no event bridge attached, and no reason for a supervisor (pm2,
 * systemd, Docker) to restart it. Exiting non-zero hands the restart
 * decision back to the supervisor, which is the only component that can
 * make it.
 */
import { flushFileSinks, logError, writeFatalToStderr, type Logger } from '../core/logger';

/**
 * The slice of a personality this module needs. Structural rather than
 * `BaseBot`-typed so the policy carries no dependency on the class.
 */
export interface StartablePersonality {
  readonly run: () => Promise<void>;
  /**
   * Reverse-order teardown. Called best-effort on the failure path: a
   * `run()` that rejected after `startAll()` may already hold a bound
   * HTTP port, scheduled jobs, and open Mongo connections.
   */
  readonly shutdown?: () => Promise<void>;
  /** Bot-scoped logger; `undefined` before `run()` binds it. */
  readonly logger: Logger | undefined;
}

interface RunOrExitOptions {
  /**
   * Termination primitive. Defaults to `process.exit`. Injectable so
   * the failure path can be asserted without killing the caller.
   */
  readonly exit?: (code: number) => void;
}

/**
 * Budget for the failure-path teardown. Short on purpose: the process
 * is going away either way, and a half-started bot's `shutdown` has no
 * claim on the operator's patience.
 */
const FAILURE_SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Bound on draining the file log before exit. Short because the failure
 * is already on stderr; the flush only adds the log-file copy.
 */
const FAILURE_LOG_FLUSH_TIMEOUT_MS = 1_000;

/**
 * Start `bot`, exiting the process with status 1 if startup fails.
 *
 * The returned promise always resolves; the failure is terminal, so
 * callers have nothing to handle.
 */
export const runOrExit = async (
  bot: StartablePersonality,
  options: RunOrExitOptions = {},
): Promise<void> => {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  try {
    await bot.run();
    return;
  } catch (err: unknown) {
    writeFatalToStderr('bot_startup_failed', err, { loggerBound: bot.logger !== undefined });
    // Also record it through the logger (file sink, pretty console).
    logError(bot.logger, null, err);
    // Startup may have got far enough to bind a port or open a
    // connection before it failed; release what it can, bounded, then
    // hand the restart decision to the supervisor.
    await releaseBoundResources(bot);
    // `process.exit` discards file writes still queued in the sink.
    await flushFileSinks(FAILURE_LOG_FLUSH_TIMEOUT_MS);
    exit(1);
  }
};

/** Run `bot.shutdown()` best-effort under a short deadline. */
const releaseBoundResources = async (bot: StartablePersonality): Promise<void> => {
  if (bot.shutdown === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FAILURE_SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => bot.shutdown?.())
        .catch((shutdownErr: unknown) => {
          logError(bot.logger, null, shutdownErr);
        }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
