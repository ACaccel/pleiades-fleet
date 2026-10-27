import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { parseAlarmConfig } from '../alarm-shared/config';
import { handleAlarmSet } from './set';
import { ALARM_CHANNEL_TYPES } from './target-channel';

/** `/alarm set`: post a message in a channel once, at a chosen time. */
export default class alarm_set extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'alarm_set',
      category: 'community',
      guildOnly: true,
      options: {
        string: [
          { name: 'time', required: true, minLength: 1, maxLength: 32 },
          // Leaves room for the attribution line within Discord's 2000 characters.
          { name: 'message', required: true, minLength: 1, maxLength: 1800 },
        ],
        channel: [{ name: 'channel', required: false, channelTypes: ALARM_CHANNEL_TYPES }],
      },
    });
  }

  public override validateBotConfig(config: unknown): void {
    parseAlarmConfig(config);
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    try {
      await handleAlarmSet(interaction, bot);
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:alarm.failed', interaction.guildId);
    }
  }
}
