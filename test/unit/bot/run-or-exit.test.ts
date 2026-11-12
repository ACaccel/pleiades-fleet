/**
 * Startup-failure policy for the personality entry points.
 *
 * The contract under test is that a rejected `run()` terminates the
 * process instead of leaving a zombie with nothing registered.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runOrExit } from '../../../src/bot/run-or-exit';
import { createFileSink, createLogger } from '../../../src/core/logger';
import { silentLogger } from '../../fixtures/runtime';

const captureStderr = (): { text: () => string; restore: () => void } => {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stderr.write = original;
    },
  };
};

describe('runOrExit', () => {
  it('does not exit when startup succeeds', async () => {
    const exitCodes: number[] = [];
    let started = 0;

    await runOrExit(
      {
        run: async () => {
          started += 1;
        },
        logger: silentLogger(),
      },
      { exit: (code) => exitCodes.push(code) },
    );

    expect(started).toBe(1);
    expect(exitCodes).toEqual([]);
  });

  it('exits 1 when run() rejects', async () => {
    const exitCodes: number[] = [];
    const stderr = captureStderr();

    try {
      await runOrExit(
        {
          run: async () => {
            throw new Error('login failed: invalid token');
          },
          logger: silentLogger(),
        },
        { exit: (code) => exitCodes.push(code) },
      );
    } finally {
      stderr.restore();
    }

    expect(exitCodes).toEqual([1]);
  });

  it('falls back to stderr when the failure precedes the logger binding', async () => {
    const exitCodes: number[] = [];
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await runOrExit(
        {
          run: async () => {
            throw new Error('env validation failed');
          },
          logger: undefined,
        },
        { exit: (code) => exitCodes.push(code) },
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(exitCodes).toEqual([1]);
    expect(written.join('')).toContain('env validation failed');
  });

  describe('fatal startup error with a file-only logger', () => {
    let logDir: string;
    let stderr: ReturnType<typeof captureStderr>;

    beforeEach(() => {
      logDir = mkdtempSync(join(tmpdir(), 'run-or-exit-'));
      stderr = captureStderr();
    });

    afterEach(() => {
      stderr.restore();
      rmSync(logDir, { recursive: true, force: true });
    });

    /** What production builds when `LOG_DIR` is set: JSON to files, nothing on stdout. */
    const fileOnlyLogger = () =>
      createLogger({
        level: 'info',
        pretty: false,
        base: { bot: 'bot-X' },
        extraStreams: [createFileSink({ rootDir: logDir, level: 'info' })],
      });

    const loginFailure = (): Error =>
      Object.assign(new Error('Login failed: https://u:hunter2@db.example/x?token=abc123'), {
        code: 'BOT_LOGIN_FAILED',
      });

    it('writes one scrubbed NDJSON line with code, message and stack to stderr', async () => {
      const exitCodes: number[] = [];

      await runOrExit(
        {
          run: async () => {
            throw loginFailure();
          },
          logger: fileOnlyLogger(),
        },
        { exit: (code) => exitCodes.push(code) },
      );

      const lines = stderr.text().trimEnd().split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(record).toMatchObject({
        levelLabel: 'fatal',
        event: 'bot_startup_failed',
        loggerBound: true,
        code: 'BOT_LOGIN_FAILED',
      });
      expect(record['message']).toContain('Login failed');
      expect(record['stack']).toEqual(expect.stringContaining('Login failed'));
      expect(stderr.text()).not.toContain('hunter2');
      expect(stderr.text()).not.toContain('abc123');
      expect(exitCodes).toEqual([1]);
    });

    it('has flushed the error to the log file by the time it exits', async () => {
      let logged = '';

      await runOrExit(
        {
          run: async () => {
            throw loginFailure();
          },
          logger: fileOnlyLogger(),
        },
        {
          exit: () => {
            const [file] = readdirSync(join(logDir, 'bot-X'));
            logged = file === undefined ? '' : readFileSync(join(logDir, 'bot-X', file), 'utf8');
          },
        },
      );

      expect(logged).toContain('BOT_LOGIN_FAILED');
      expect(logged).not.toContain('hunter2');
    });
  });
});
