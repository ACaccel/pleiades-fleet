/**
 * Deployment-owned filesystem locations.
 *
 * Each location defaults to the path relative to the working directory that
 * the original deployment used, so a launch from the project root behaves as
 * before. A read-only release (working directory `/opt/<svc>/current`) points
 * the writable ones and the operator-supplied files elsewhere through the
 * environment instead. Like {@link readCanvasFontDirectory}, this module reads
 * the environment directly because it lives in `core/config`.
 */
import * as path from 'node:path';

/** Writable data root used when `PLEIADES_DATA_DIR` is unset. */
const DEFAULT_DATA_DIRECTORY = 'data';

/** Log root used when `LOG_DIR` is unset or blank. */
const DEFAULT_LOG_DIRECTORY = 'logs';

const requireAbsolute = (name: string, value: string): string => {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute.`);
  return value;
};

/**
 * Root of the writable data tree (attachment archive and cache, persona
 * images). Relative to the working directory unless `PLEIADES_DATA_DIR` names
 * an absolute directory.
 */
export const readDataDirectory = (source: NodeJS.ProcessEnv = process.env): string => {
  const configured = source.PLEIADES_DATA_DIR;
  return configured === undefined
    ? DEFAULT_DATA_DIRECTORY
    : requireAbsolute('PLEIADES_DATA_DIR', configured);
};

/**
 * Root of the file logs. Mirrors the bootstrap logger's `LOG_DIR`, except that
 * a blank value (which disables the logger's file output) still needs a
 * location because transcripts written by a plugin must go somewhere: `logs`
 * below the data root when `PLEIADES_DATA_DIR` is set, so a deployment that
 * logs to the journal stays inside its writable state, else `logs` relative
 * to the working directory.
 */
export const readLogDirectory = (source: NodeJS.ProcessEnv = process.env): string => {
  const configured = source.LOG_DIR?.trim();
  if (configured) return configured;
  return source.PLEIADES_DATA_DIR === undefined
    ? DEFAULT_LOG_DIRECTORY
    : path.join(readDataDirectory(source), DEFAULT_LOG_DIRECTORY);
};

/**
 * Location of a bot's `config.json`: `PLEIADES_CONFIG_FILE` when set, otherwise
 * the caller's default beside the bot's entry point.
 */
export const readBotConfigFile = (
  fallback: string,
  source: NodeJS.ProcessEnv = process.env,
): string => {
  const configured = source.PLEIADES_CONFIG_FILE;
  return configured === undefined ? fallback : requireAbsolute('PLEIADES_CONFIG_FILE', configured);
};
