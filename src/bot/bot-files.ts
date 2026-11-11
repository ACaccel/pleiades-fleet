/**
 * Operator-supplied files of one personality: its `.env` and `config.json`.
 *
 * The original deployment symlinks both into `src/bot/<name>/`. A read-only
 * release supplies the environment through the process (for example a systemd
 * `EnvironmentFile`) and points `PLEIADES_CONFIG_FILE` at the config instead.
 * The `src/bot/<name>/` locations remain the fallbacks, so both layouts work.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import dotenv from 'dotenv';

import { readBotConfigFile } from '../core/config';

/**
 * Load the personality's `.env` into `process.env` when the file exists.
 * Variables already set by the process win, and a missing file is not an
 * error: the typed env schema decides whether what is present suffices.
 */
export const loadBotEnvFile = (name: string): void => {
  dotenv.config({ path: `./src/bot/${name}/.env` });
};

/**
 * The `config.json` beside the personality's entry point.
 * @public Used by `bin/start.cjs --check`, which static analysis cannot see.
 */
export const defaultBotConfigFile = (name: string): string =>
  path.resolve(__dirname, name, 'config.json');

/**
 * Parse the personality's `config.json`, from `PLEIADES_CONFIG_FILE` or else
 * the file beside its entry point.
 *
 * @throws {Error} when the file is unreadable, not JSON, or not a JSON object.
 */
export const loadBotConfig = <C>(name: string): C => {
  const file = readBotConfigFile(defaultBotConfigFile(name));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`Cannot load config for ${name} from ${file}: ${(cause as Error).message}`, {
      cause,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config for ${name} at ${file} must be a JSON object.`);
  }
  return parsed as C;
};
