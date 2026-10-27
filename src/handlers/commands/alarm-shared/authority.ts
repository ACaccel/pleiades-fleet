import { PermissionFlagsBits, type RepliableInteraction } from 'discord.js';
import type { BaseBot } from '@bot';

/**
 * Whether the requester may delete an alarm set by `creatorId`: its
 * creator, a member who manages messages, or a bot admin.
 */
export const canManageAlarm = (
  interaction: Pick<RepliableInteraction, 'user' | 'memberPermissions'>,
  bot: Pick<BaseBot, 'isAdmin'>,
  creatorId: string,
): boolean =>
  creatorId === interaction.user.id ||
  bot.isAdmin(interaction.user.id) ||
  interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true;
