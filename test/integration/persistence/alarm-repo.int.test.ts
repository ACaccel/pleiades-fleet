import { describe, expect, it } from 'vitest';
import { asGuildId } from '../../../src/core/ids';
import { DatabaseError } from '../../../src/core/errors';
import { isErr, unwrap } from '../../../src/core/result';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoAlarmRepo, type AlarmInput } from '../../../src/persistence/repositories/alarm.repo';
import { withClosedConnection, withFreshConnection } from '../helpers/mongo';

const guildId = asGuildId('999999999999999999');
const buildRepo = async (m: StaticConnectionManager): Promise<MongoAlarmRepo> =>
  new MongoAlarmRepo(await m.getConnection(guildId));

const input = (overrides: Partial<AlarmInput> & { alarm_id: string }): AlarmInput => ({
  channel_id: 'c1',
  creator_id: 'u1',
  message: 'stand-up time',
  fire_at: Date.now() + 60_000,
  mention_everyone: false,
  ...overrides,
});

describe('MongoAlarmRepo (integration)', () => {
  it('create persists and findByAlarmId returns the same doc', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create(input({ alarm_id: 'a1' })));
      const found = unwrap(await repo.findByAlarmId('a1'));
      expect(found?.message).toBe('stand-up time');
      expect(found?.mention_everyone).toBe(false);
    });
  });

  it('findByAlarmId returns ok(undefined) for an unknown alarm', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      expect(unwrap(await repo.findByAlarmId('missing'))).toBeUndefined();
    });
  });

  it('listAll returns every alarm and listByCreator only one member’s', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create(input({ alarm_id: 'a1' })));
      unwrap(await repo.create(input({ alarm_id: 'a2', creator_id: 'u2' })));
      expect(
        unwrap(await repo.listAll())
          .map((d) => d.alarm_id)
          .sort(),
      ).toEqual(['a1', 'a2']);
      expect(unwrap(await repo.listByCreator('u2')).map((d) => d.alarm_id)).toEqual(['a2']);
    });
  });

  it('deleteByAlarmId reports true only for the call that removed the row', async () => {
    await withFreshConnection(async (connection) => {
      const repo = await buildRepo(new StaticConnectionManager(connection));
      unwrap(await repo.create(input({ alarm_id: 'a1' })));
      expect(unwrap(await repo.deleteByAlarmId('a1'))).toBe(true);
      expect(unwrap(await repo.deleteByAlarmId('a1'))).toBe(false);
    });
  });

  it('listAll resolves to err(DatabaseError) when the connection is closed', async () => {
    const repo = await withClosedConnection(
      async (connection) =>
        new MongoAlarmRepo(await new StaticConnectionManager(connection).getConnection(guildId)),
    );

    const result = await repo.listAll();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(DatabaseError);
      expect(result.error.context.operation).toBe('MongoAlarmRepo.listAll');
    }
  });
});
