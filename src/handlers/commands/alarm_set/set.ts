import { MessageFlags, time, TimestampStyles, type ChatInputCommandInteraction } from 'discord.js';

import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import { systemClock } from '../../../core/time';
import { createAlarm } from '../../../application/alarm/alarm';
import { MAX_ALARM_DAYS, resolveAlarmTime } from '../../../application/alarm/alarm-time';
import { getRequiredString } from '../../../infra/discord/options';
import { buildAlarmDepsFromBot } from '../alarm-shared/deps-from-bot';
import { parseAlarmConfig } from '../alarm-shared/config';
import { checkAlarmChannel } from './target-channel';

const INVALID_TIME_KEYS = {
  format: 'replies:alarm.invalid_time',
  past: 'replies:alarm.time_in_past',
  too_far: 'replies:alarm.time_too_far',
} as const;

const CHANNEL_KEYS = {
  not_found: 'errors:command.channel_not_found',
  member_forbidden: 'replies:alarm.member_cannot_send',
  bot_forbidden: 'replies:alarm.bot_cannot_send',
} as const;

/**
 * `/alarm set` — schedule a one-shot message in a channel. Wall-clock
 * times are read in the guild's time zone. Validation failures are
 * answered here; unexpected failures propagate to the action's
 * `replyForError` boundary.
 */
export const handleAlarmSet = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const t = bindTranslator(bot.translator);

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: t('errors:command.guild_not_found') });
    return;
  }

  const resolved = resolveAlarmTime(
    getRequiredString(interaction, 'time'),
    systemClock.now(),
    bot.timeZone,
  );
  if (!resolved.ok) {
    await interaction.editReply({
      content: t(INVALID_TIME_KEYS[resolved.reason], { max: MAX_ALARM_DAYS }),
    });
    return;
  }

  const message = getRequiredString(interaction, 'message').trim();
  if (message.length === 0) {
    await interaction.editReply({ content: t('replies:alarm.missing_message') });
    return;
  }

  const target = await checkAlarmChannel(
    bot.client,
    guild.id,
    interaction.options.getChannel('channel')?.id ?? interaction.channelId,
    interaction.user.id,
  );
  if (!target.ok) {
    await interaction.editReply({ content: t(CHANNEL_KEYS[target.reason]) });
    return;
  }

  const outcome = await createAlarm(buildAlarmDepsFromBot(bot), {
    guildId: guild.id,
    channelId: target.channelId,
    creatorId: interaction.user.id,
    message,
    fireAt: resolved.at,
    mentionEveryone: target.mentionEveryone,
    maxActivePerMember: parseAlarmConfig(bot.config).maxActivePerMember,
  });

  switch (outcome.status) {
    case 'no_db':
      await interaction.editReply({ content: t('errors:db.not_found') });
      return;
    case 'too_many':
      await interaction.editReply({ content: t('replies:alarm.too_many', { max: outcome.max }) });
      return;
    case 'created': {
      const at = new Date(outcome.fireAt);
      await interaction.editReply({
        content: t('replies:alarm.created', {
          time: time(at, TimestampStyles.LongDateTime),
          relative: time(at, TimestampStyles.RelativeTime),
          channel: `<#${target.channelId}>`,
        }),
      });
      return;
    }
    default: {
      // Compile-time exhaustiveness guard: a new CreateAlarmOutcome
      // variant must be handled above.
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
};
