/* eslint-disable import/first */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const attempts = vi.hoisted(() => ({ failures: 0, calls: 0 }));

vi.mock('mongoose', () => ({
  mongo: {
    MongoClient: class {
      public connect = async (): Promise<void> => {
        attempts.calls += 1;
        if (attempts.calls <= attempts.failures) {
          throw new Error('connect ECONNREFUSED 10.9.8.7:27017 (driver detail)');
        }
      };
      public db = () => ({ command: async () => ({ ok: 1 }) });
      public close = async (): Promise<void> => undefined;
    },
  },
}));

import { waitForMongoReady } from '../../../../src/infra/mongo/ready';

describe('waitForMongoReady', () => {
  beforeEach(() => {
    attempts.calls = 0;
    attempts.failures = 0;
  });

  it('returns at once when MongoDB answers', async () => {
    const onUnavailable = vi.fn();
    await waitForMongoReady('mongodb://db.internal', 5, { onUnavailable });
    expect(attempts.calls).toBe(1);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('retries and reports the first failure once', async () => {
    attempts.failures = 1;
    const onUnavailable = vi.fn();
    await waitForMongoReady('mongodb://db.internal', 5, { onUnavailable });
    expect(attempts.calls).toBe(2);
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it('fails at the deadline without leaking driver details', async () => {
    attempts.failures = Infinity;
    const result = waitForMongoReady('mongodb://db.internal', 1);
    await expect(result).rejects.toThrow('did not become ready');
    await expect(result).rejects.not.toThrow(/ECONNREFUSED|driver detail/);
  });
});
