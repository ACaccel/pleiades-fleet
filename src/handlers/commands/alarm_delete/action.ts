import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { Command, type CommandSuggestions } from '../command';

import { cancelAlarm } from '../../../application/alarm/alarm';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { getRequiredString } from '../../../infra/discord/options';
import { canManageAlarm } from '../alarm-shared/authority';
import { buildAlarmDepsFromBot } from '../alarm-shared/deps-from-bot';
import { describeAlarmChoice } from '../alarm-shared/describe';

/** `/alarm delete`: delete a pending alarm; its creator or a message manager may. */
export default class alarm_delete extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'alarm_delete',
      category: 'community',
      guildOnly: true,
      options: { string: [{ name: 'alarm', required: true, autocomplete: true }] },
    });
  }

  /** Alarms the member may delete, soonest first, matching what they typed. */
  public override autocomplete = async (
    interaction: AutocompleteInteraction,
    bot: BaseBot,
  ): Promise<CommandSuggestions> => {
    const repos = interaction.guildId ? bot.getRepos(interaction.guildId) : undefined;
    if (!repos) return [];
    const result = await repos.alarm.listAll();
    if (!result.ok) return [];
    const typed = interaction.options.getFocused().toLowerCase();
    return [...result.value]
      .filter((doc) => canManageAlarm(interaction, bot, doc.creator_id))
      .sort((a, b) => a.fire_at - b.fire_at)
      .map((doc) => ({ name: describeAlarmChoice(doc, bot.timeZone), value: doc.alarm_id }))
      .filter((choice) => choice.name.toLowerCase().includes(typed));
  };

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string): string => bot.translator?.t(`replies:alarm.${key}`) ?? '';
    try {
      const guildId = interaction.guildId;
      if (guildId === null) return;
      const outcome = await cancelAlarm(
        buildAlarmDepsFromBot(bot),
        guildId,
        getRequiredString(interaction, 'alarm'),
        (creatorId) => canManageAlarm(interaction, bot, creatorId),
      );
      if (outcome.status === 'no_db') {
        await interaction.editReply({ content: bot.translator?.t('errors:db.not_found') ?? '' });
        return;
      }
      const key = { cancelled: 'cancelled', not_found: 'not_found', forbidden: 'cancel_forbidden' };
      await interaction.editReply({ content: t(key[outcome.status]) });
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:alarm.failed', interaction.guildId);
    }
  }
}
