/**
 * Fatal-exit report on stderr, independent of the logger.
 *
 * With `LOG_DIR` set the logger writes to files only, and an async file
 * sink may not have flushed by the time the process exits, so stderr
 * (the supervisor's journal) is the one sink certain to carry the cause.
 * The error goes through {@link scrubForLog}, the scrub every logger call
 * applies, so URL credentials in a message or stack are masked.
 */
import { scrubForLog } from './scrub-for-log';

/**
 * Write one NDJSON line (`levelLabel: "fatal"`) to stderr, shaped like
 * the env loader's `env_load_failed` line. `extra` fields are scrubbed
 * too; an `Error` contributes `name`, `message`, `stack`, `code` and
 * `cause`, any other thrown value is carried as `raw`.
 */
export const writeFatalToStderr = (
  event: string,
  err?: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): void => {
  const detail = scrubForLog(err);
  const fields =
    err === undefined
      ? {}
      : err instanceof Error && typeof detail === 'object' && detail !== null
        ? (detail as Record<string, unknown>)
        : { raw: detail };
  process.stderr.write(
    `${JSON.stringify({
      level: 60,
      levelLabel: 'fatal',
      event,
      pid: process.pid,
      time: Date.now(),
      ...(scrubForLog(extra) as Record<string, unknown>),
      ...fields,
    })}\n`,
  );
};
