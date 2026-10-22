import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import type { StateStore } from './contracts';
import { initialState } from './controller';
import { readControllerState, writeControllerState } from './state';

export function createFileStateStore(directory: string): StateStore {
  const statePath = join(directory, 'state.json');
  return {
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const dir = await lstat(directory);
      if (!dir.isDirectory() || dir.uid !== userInfo().uid || (dir.mode & 0o077) !== 0)
        throw new Error('Deployment state directory must be private to its operator');
      const lockPath = join(directory, 'cycle.lock');
      const file = await open(
        lockPath,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== userInfo().uid || (stat.mode & 0o077) !== 0)
          throw new Error('Unsafe deployment lock ownership or permissions');
        // flock inherits this open description; the parent keeps its lock until close.
        await new Promise<void>((resolve, reject) => {
          const child = spawn('/usr/bin/flock', ['-n', '3'], {
            stdio: ['ignore', 'ignore', 'ignore', file.fd],
          });
          child.once('error', () => reject(new Error('Cannot acquire deployment lock')));
          child.once('close', (code) =>
            code === 0 ? resolve() : reject(new Error('Another deployment cycle is running')),
          );
        });
        return await operation();
      } finally {
        await file.close();
      }
    },
    async load() {
      return (await readControllerState(statePath, userInfo().uid)) ?? initialState();
    },
    async save(state) {
      await writeControllerState(statePath, state);
    },
  };
}
