/**
 * `AlarmRepo` — persistent state for one-shot alarms.
 *
 * Documents are keyed by a generated `alarm_id`. The scheduler reads
 * pending alarms on boot (`listAll`), `/alarm set` creates one, and the
 * firing job or `/alarm delete` removes it. `deleteByAlarmId` reports
 * whether this call removed the row, so whichever path deletes it first
 * owns the alarm and it fires at most once.
 *
 * **Error boundary**: every method returns `Result<T, DatabaseError>`.
 * A mongoose failure is translated by the shared `databaseErrorFrom`
 * translator and returned as `err`; a missing lookup is a success
 * (`ok(undefined)`).
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import type { AlarmDoc } from '../schemas/alarm.schema';

/** Insertion shape — the schema fields without the Mongoose `_id`. */
export interface AlarmInput {
  readonly alarm_id: string;
  readonly channel_id: string;
  readonly creator_id: string;
  readonly message: string;
  readonly fire_at: number;
  readonly mention_everyone: boolean;
}

export interface AlarmRepo {
  /** Every alarm in this guild, used for boot-time job rebuild. */
  listAll(): Promise<Result<readonly AlarmDoc[], DatabaseError>>;
  /** Every alarm one member set in this guild. */
  listByCreator(creator_id: string): Promise<Result<readonly AlarmDoc[], DatabaseError>>;
  /** Look up by alarm id; `ok(undefined)` when absent. */
  findByAlarmId(alarm_id: string): Promise<Result<AlarmDoc | undefined, DatabaseError>>;
  /** Persist a new alarm and return the stored doc. */
  create(input: AlarmInput): Promise<Result<AlarmDoc, DatabaseError>>;
  /** Delete by alarm id; `ok(true)` when this call removed the doc. */
  deleteByAlarmId(alarm_id: string): Promise<Result<boolean, DatabaseError>>;
}

export class MongoAlarmRepo implements AlarmRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async listAll(): Promise<Result<readonly AlarmDoc[], DatabaseError>> {
    try {
      return ok(await this.conn.models.Alarm.find({}).lean<AlarmDoc[]>().exec());
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoAlarmRepo.listAll' }));
    }
  }

  public async listByCreator(
    creator_id: string,
  ): Promise<Result<readonly AlarmDoc[], DatabaseError>> {
    try {
      return ok(await this.conn.models.Alarm.find({ creator_id }).lean<AlarmDoc[]>().exec());
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoAlarmRepo.listByCreator',
          input: { creator_id },
        }),
      );
    }
  }

  public async findByAlarmId(
    alarm_id: string,
  ): Promise<Result<AlarmDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.Alarm.findOne({ alarm_id }).lean<AlarmDoc>().exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoAlarmRepo.findByAlarmId',
          input: { alarm_id },
        }),
      );
    }
  }

  public async create(input: AlarmInput): Promise<Result<AlarmDoc, DatabaseError>> {
    try {
      const created = await this.conn.models.Alarm.create({ ...input });
      return ok(created.toObject<AlarmDoc>());
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoAlarmRepo.create',
          input: { alarm_id: input.alarm_id },
        }),
      );
    }
  }

  public async deleteByAlarmId(alarm_id: string): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.Alarm.deleteOne({ alarm_id }).exec();
      return ok(res.deletedCount > 0);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoAlarmRepo.deleteByAlarmId',
          input: { alarm_id },
        }),
      );
    }
  }
}
