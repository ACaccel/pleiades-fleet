/**
 * One-shot alarm service.
 *
 * Shared by the alarm plugin (boot-time job rebuild) and the `/alarm`
 * handlers, which may not import each other. Mirrors the temp-role
 * service's shape: the surface takes a typed {@link AlarmDeps} bundle
 * the plugin resolves through `ctx` and the handlers build from their
 * `BaseBot` via `buildAlarmDepsFromBot`.
 *
 * An alarm posts its creator's message in a chosen channel once, at
 * `fire_at`. State lives in MongoDB; the one-shot jobs are ephemeral and
 * rebuilt on every boot (`rebootAlarmJobs`). An alarm whose time passed
 * while the process was down fires as soon as the guild is back.
 */
import { randomUUID } from 'node:crypto';
import type { Client, MessageMentionTypes } from 'discord.js';
import type { Job } from 'node-schedule';

import type { GuildLookup } from '../guild-lookup';
import { bindTranslator, withGuildContext, type Translator } from '../../core/i18n';
import { logError, type Logger } from '../../core/logger';
import { JobManager, retryWithBackoff } from '@core/scheduling';

export interface AlarmDeps {
  readonly client: Client;
  readonly registry: GuildLookup<'alarm'>;
  readonly jobMap: Map<string, Job>;
  readonly logger: Logger;
  readonly translator: Translator | undefined;
}

export const alarmJobKey = (alarmId: string): string => `alarm:${alarmId}`;

/** Outcome of {@link createAlarm}; the handler maps it to i18n copy. */
type CreateAlarmOutcome =
  | { readonly status: 'created'; readonly alarmId: string; readonly fireAt: number }
  | { readonly status: 'no_db' }
  | { readonly status: 'too_many'; readonly max: number };

interface CreateAlarmArgs {
  readonly guildId: string;
  readonly channelId: string;
  readonly creatorId: string;
  readonly message: string;
  readonly fireAt: number;
  /** Whether the creator may mention `@everyone` and roles in the channel. */
  readonly mentionEveryone: boolean;
  /** Most alarms one member may have pending at once. */
  readonly maxActivePerMember: number;
}

/**
 * Fire an alarm: claim it by deleting its row, then post the message.
 *
 * The row is removed before sending, so a send that fails, or a restart
 * mid-send, loses the alarm rather than repeating it: an alarm fires at
 * most once. A row already gone (cancelled, or fired by another path)
 * sends nothing.
 */
export const fireAlarm = async (
  deps: AlarmDeps,
  guildId: string,
  alarmId: string,
): Promise<void> => {
  const repos = deps.registry.getRepos(guildId);
  if (!repos) return;
  const found = await repos.alarm.findByAlarmId(alarmId);
  if (!found.ok) throw found.error;
  const doc = found.value;
  new JobManager(deps.jobMap).cancel(alarmJobKey(alarmId));
  if (!doc) return;

  const claimed = await repos.alarm.deleteByAlarmId(alarmId);
  if (!claimed.ok) throw claimed.error;
  if (!claimed.value) return;

  const channel = await deps.client.channels.fetch(doc.channel_id).catch(() => null);
  if (!channel?.isSendable()) {
    logError(
      deps.logger,
      guildId,
      new Error(`Alarm ${alarmId}: channel ${doc.channel_id} is not sendable`),
    );
    return;
  }
  const t = bindTranslator(deps.translator);
  const parse: MessageMentionTypes[] = doc.mention_everyone
    ? ['users', 'roles', 'everyone']
    : ['users'];
  await channel.send({
    content: t('replies:alarm.fired', { creator: `<@${doc.creator_id}>`, message: doc.message }),
    allowedMentions: { parse },
  });
};

/** Run a firing detached, routing any rejection to the logger. */
const runFireDetached = (deps: AlarmDeps, guildId: string, alarmId: string): void => {
  void fireAlarm(deps, guildId, alarmId).catch((error) => logError(deps.logger, guildId, error));
};

/** Schedule (or replace) the one-shot job for `alarmId`. */
const scheduleAlarmJob = (deps: AlarmDeps, guildId: string, alarmId: string, when: Date): void => {
  // node-schedule fires on the real wall clock and returns null for a
  // past `Date`, which would silently drop the alarm. A deadline already
  // due fires immediately instead.
  if (when.getTime() <= Date.now()) {
    runFireDetached(deps, guildId, alarmId);
    return;
  }
  new JobManager(deps.jobMap, deps.logger).schedule(alarmJobKey(alarmId), when, () =>
    runFireDetached(deps, guildId, alarmId),
  );
};

const createAlarmUnlocked = async (
  deps: AlarmDeps,
  args: CreateAlarmArgs,
): Promise<CreateAlarmOutcome> => {
  const repos = deps.registry.getRepos(args.guildId);
  if (!repos) return { status: 'no_db' };

  const existing = await repos.alarm.listByCreator(args.creatorId);
  if (!existing.ok) throw existing.error;
  if (existing.value.length >= args.maxActivePerMember) {
    return { status: 'too_many', max: args.maxActivePerMember };
  }

  const alarmId = randomUUID();
  const created = await repos.alarm.create({
    alarm_id: alarmId,
    channel_id: args.channelId,
    creator_id: args.creatorId,
    message: args.message,
    fire_at: args.fireAt,
    mention_everyone: args.mentionEveryone,
  });
  if (!created.ok) throw created.error;

  scheduleAlarmJob(deps, args.guildId, alarmId, new Date(args.fireAt));
  return { status: 'created', alarmId, fireAt: args.fireAt };
};

const creationQueues = new Map<string, Promise<unknown>>();

/**
 * Persist an alarm and schedule its job. Creations per guild run one at
 * a time, so two concurrent requests cannot both pass the per-member cap.
 */
export const createAlarm = async (
  deps: AlarmDeps,
  args: CreateAlarmArgs,
): Promise<CreateAlarmOutcome> => {
  const previous = creationQueues.get(args.guildId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => createAlarmUnlocked(deps, args));
  creationQueues.set(args.guildId, run);
  try {
    return await run;
  } finally {
    if (creationQueues.get(args.guildId) === run) creationQueues.delete(args.guildId);
  }
};

/** Outcome of {@link cancelAlarm}. */
type CancelAlarmOutcome =
  | { readonly status: 'cancelled' }
  | { readonly status: 'not_found' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'no_db' };

/** Delete a pending alarm. `canCancel` decides from its creator whether the requester may. */
export const cancelAlarm = async (
  deps: AlarmDeps,
  guildId: string,
  alarmId: string,
  canCancel: (creatorId: string) => boolean,
): Promise<CancelAlarmOutcome> => {
  const repos = deps.registry.getRepos(guildId);
  if (!repos) return { status: 'no_db' };
  const found = await repos.alarm.findByAlarmId(alarmId);
  if (!found.ok) throw found.error;
  if (!found.value) return { status: 'not_found' };
  if (!canCancel(found.value.creator_id)) return { status: 'forbidden' };
  const deleted = await repos.alarm.deleteByAlarmId(alarmId);
  if (!deleted.ok) throw deleted.error;
  new JobManager(deps.jobMap).cancel(alarmJobKey(alarmId));
  // A firing that claimed the row first has already sent the alarm.
  return { status: deleted.value ? 'cancelled' : 'not_found' };
};

const REBOOT_MAX_ATTEMPTS = 3;

/**
 * Rebuild every guild's alarm jobs on boot: re-schedule pending alarms
 * and fire any whose time passed while the process was down.
 */
export const rebootAlarmJobs = async (
  deps: AlarmDeps,
  recoveredGuildId?: string,
): Promise<void> => {
  const guildIds =
    recoveredGuildId === undefined ? deps.registry.listGuildIds() : [recoveredGuildId];
  await Promise.all(
    guildIds.map((guildId) =>
      withGuildContext(deps.translator, guildId, async () => {
        try {
          const repos = deps.registry.getRepos(guildId);
          if (!repos) return;
          const alarms = await retryWithBackoff(async () => {
            const result = await repos.alarm.listAll();
            if (!result.ok) throw result.error;
            return result.value;
          }, REBOOT_MAX_ATTEMPTS);
          for (const alarm of alarms) {
            scheduleAlarmJob(deps, guildId, alarm.alarm_id, new Date(alarm.fire_at));
          }
        } catch (err) {
          logError(deps.logger, guildId, err);
          const debugCh = deps.registry.getChannel(guildId, 'debug');
          if (debugCh?.isSendable()) {
            await debugCh
              .send(
                `[ ops ] alarm reboot listAll failed for guild ${guildId} after ${REBOOT_MAX_ATTEMPTS} attempts; alarms may not fire until next restart.`,
              )
              .catch((sendErr) => logError(deps.logger, guildId, sendErr));
          }
        }
      }),
    ),
  );
};
