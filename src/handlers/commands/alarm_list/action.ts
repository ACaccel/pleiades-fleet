import { MessageFlags, time, TimestampStyles, type ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';

import { requireGuildRepos } from '../../require-guild-repos';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { paginateLines } from '../../../infra/discord/paginate';
import { sendPagedEphemeralReply } from '../../../infra/discord/send-paged-reply';
import { previewAlarmMessage } from '../alarm-shared/describe';

/** `/alarm list`: the member's own pending alarms, soonest first, privately. */
export default class alarm_list extends Command {
  constructor() {
    super();
    this.setConfig({ name: 'alarm_list', category: 'community', guildOnly: true });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:alarm.${key}`, params) ?? '';
    try {
      const repos = await requireGuildRepos(bot, interaction);
      if (repos === null) return;
      const result = await repos.alarm.listByCreator(interaction.user.id);
      if (!result.ok) throw result.error;
      const alarms = [...result.value].sort((a, b) => a.fire_at - b.fire_at);
      if (alarms.length === 0) {
        await interaction.editReply({ content: t('list_empty') });
        return;
      }
      const lines = alarms.map((doc) =>
        t('list_line', {
          time: time(Math.floor(doc.fire_at / 1000), TimestampStyles.LongDateTime),
          channel: `<#${doc.channel_id}>`,
          message: previewAlarmMessage(doc.message),
        }),
      );
      await sendPagedEphemeralReply(
        interaction,
        paginateLines([t('list_header', { count: alarms.length }), ...lines]),
        {
          logger: bot.logger,
          partialNotice: (failed) =>
            bot.translator?.t('replies:common.pages_failed', { count: failed }) ?? '',
        },
      );
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:alarm.failed', interaction.guildId);
    }
  }
}
