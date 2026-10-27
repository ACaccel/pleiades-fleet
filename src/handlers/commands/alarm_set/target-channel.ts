import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';

/** Channels an alarm may post in: anywhere members chat. */
export const ALARM_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
] as const;

type TargetChannelCheck =
  | { readonly ok: true; readonly channelId: string; readonly mentionEveryone: boolean }
  | { readonly ok: false; readonly reason: 'not_found' | 'member_forbidden' | 'bot_forbidden' };

/**
 * Whether an alarm set by `userId` may post in `channelId`: the channel
 * belongs to this guild and both the member and the bot can see it and
 * send there. An alarm cannot reach a channel its creator cannot post in.
 * `mentionEveryone` carries the member's own `@everyone` permission so the
 * alarm pings no more than they could.
 */
export const checkAlarmChannel = async (
  client: Client,
  guildId: string,
  channelId: string,
  userId: string,
): Promise<TargetChannelCheck> => {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.isDMBased() || channel.guildId !== guildId || !channel.isTextBased()) {
    return { ok: false, reason: 'not_found' };
  }
  const send = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  const needed = [PermissionFlagsBits.ViewChannel, send];
  const member = channel.permissionsFor(userId);
  if (!member || !needed.every((flag) => member.has(flag))) {
    return { ok: false, reason: 'member_forbidden' };
  }
  const self = client.user ? channel.permissionsFor(client.user.id) : null;
  if (!self || !needed.every((flag) => self.has(flag))) {
    return { ok: false, reason: 'bot_forbidden' };
  }
  return {
    ok: true,
    channelId: channel.id,
    mentionEveryone: member.has(PermissionFlagsBits.MentionEveryone),
  };
};
