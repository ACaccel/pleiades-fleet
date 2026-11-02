import type { Attachment, ChatInputCommandInteraction, GuildBasedChannel } from 'discord.js';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { replyForError } from '../../../infra/discord/reply-for-error';
import { getOptionalString } from '../../../infra/discord/options';
import { ancestorChannelIdsOf } from '../../../infra/discord';

/** Leaves room for the `displayName(username): ` signature under Discord's 2000 limit. */
const MAX_CONTENT_LENGTH = 1900;
const FILE_OPTIONS = ['file1', 'file2', 'file3', 'file4', 'file5'] as const;
/** Discord's per-file upload limit in a server without boosts. */
const MAX_FILE_MIB = 20;
const MAX_FILE_BYTES = MAX_FILE_MIB * 1024 * 1024;

export default class talk extends Command {
  constructor() {
    super();
    this.setConfig({
      name: 'talk',
      category: 'fun',
      guildOnly: true,
      options: {
        string: [{ name: 'content', required: false, maxLength: MAX_CONTENT_LENGTH }],
        channel: [{ name: 'channel', required: false }],
        boolean: [{ name: 'anonymous', required: false }],
        attachment: FILE_OPTIONS.map((name) => ({ name, required: false })),
      },
    });
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const t = (key: string, params?: Record<string, string>): string =>
      bot.translator?.t(key, params) ?? '';
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const content = getOptionalString(interaction, 'content') ?? '';
      const files = FILE_OPTIONS.map((name) => interaction.options.getAttachment(name)).filter(
        (file): file is Attachment => file !== null,
      );
      if (content === '' && files.length === 0) {
        await interaction.editReply({ content: t('replies:talk.empty') });
        return;
      }
      if (files.some((file) => file.size > MAX_FILE_BYTES)) {
        await interaction.editReply({
          content: t('replies:talk.file_too_large', { limit: String(MAX_FILE_MIB) }),
        });
        return;
      }
      const anonymous = interaction.options.getBoolean('anonymous') === true;
      // Unsigned speech is untraceable to members, so only bot admins may use it.
      if (anonymous && !bot.isAdmin(interaction.user.id)) {
        await interaction.editReply({ content: t('errors:permission.admin_only_short') });
        return;
      }
      const chosen = interaction.options.getChannel('channel')?.id;
      const channel = chosen
        ? interaction.guild?.channels.cache.get(chosen)
        : (interaction.channel ?? undefined);
      if (!channel?.isSendable() || !mayPost(channel as GuildBasedChannel, interaction)) {
        await interaction.editReply({ content: t('replies:talk.channel_not_allowed') });
        return;
      }
      if (
        bot.guildSettings &&
        interaction.guildId &&
        !bot.guildSettings.isEnabled(
          interaction.guildId,
          'talk',
          channel.id,
          ancestorChannelIdsOf(channel, interaction.guild?.channels.cache),
        )
      ) {
        await interaction.editReply({
          content: t('replies:settings.feature_disabled', {
            feature: t('replies:settings.feature.talk'),
          }),
        });
        return;
      }

      const displayName =
        interaction.member && 'displayName' in interaction.member
          ? interaction.member.displayName
          : interaction.user.displayName;
      const username = interaction.user.username;
      if (content.includes('@everyone') || content.includes('@here')) {
        await channel.send({
          content: t('replies:talk.tag_warning', { displayName, username }),
          allowedMentions: { parse: [] },
        });
      } else {
        const signed = `${displayName}(${username}):${content === '' ? '' : ` ${content}`}`;
        const text = anonymous ? content : signed;
        await channel.send({
          ...(text === '' ? {} : { content: text }),
          ...(files.length === 0
            ? {}
            : { files: files.map((file) => ({ attachment: file.url, name: file.name })) }),
          allowedMentions: { parse: ['users', 'roles'] },
        });
        if (anonymous) {
          bot.logger?.info(
            {
              guildId: interaction.guildId,
              channelId: channel.id,
              userId: interaction.user.id,
              content,
            },
            'anonymous /talk message sent',
          );
        }
      }
      await interaction.deleteReply();
    } catch (error) {
      await replyForError(interaction, bot, error, 'replies:talk.failed', interaction.guildId);
    }
  }
}

/** The member must be able to post there themselves; the bot is not a way around channel rules. */
const mayPost = (channel: GuildBasedChannel, interaction: ChatInputCommandInteraction): boolean => {
  const permissions = channel.permissionsFor(interaction.user);
  const send = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  return permissions?.has([PermissionFlagsBits.ViewChannel, send]) === true;
};
