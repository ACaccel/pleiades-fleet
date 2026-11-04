import {
  OverwriteType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Role,
} from 'discord.js';

import { coversRoleCombinations, type PermissionTarget } from './role-audience';

const canViewAs = (channel: PermissionTarget, subject: GuildMember | Role): boolean =>
  channel.permissionsFor(subject)?.has(PermissionFlagsBits.ViewChannel) ?? false;

export interface PublicAudience {
  readonly channel: PermissionTarget;
  readonly roles: readonly Role[];
  readonly memberViews: ReadonlyMap<string, 'allow' | 'deny'>;
}

const memberViews = (channel: PermissionTarget): ReadonlyMap<string, 'allow' | 'deny'> => {
  const views = new Map<string, 'allow' | 'deny'>();
  for (const [id, overwrite] of channel.permissionOverwrites?.cache ?? []) {
    if (overwrite.type !== OverwriteType.Member) continue;
    if (overwrite.allow.has(PermissionFlagsBits.ViewChannel)) views.set(id, 'allow');
    else if (overwrite.deny.has(PermissionFlagsBits.ViewChannel)) views.set(id, 'deny');
  }
  return views;
};

/** Roles and member exceptions defining the public reply's audience. */
export const commandAudience = (
  guild: Guild,
  commandChannelId: string,
): PublicAudience | undefined => {
  const channel = guild.channels.cache.get(commandChannelId);
  if (channel === undefined || !('permissionsFor' in channel)) return undefined;
  const target = channel.isThread() ? channel.parent : channel;
  if (target === null) return undefined;
  return {
    channel: target,
    roles: [...guild.roles.cache.values()].filter((role) => canViewAs(channel, role)),
    memberViews: memberViews(target),
  };
};

/** Prove audience coverage without fetching or enumerating every guild member. */
export const coversAudience = (
  guild: Guild,
  channel: PermissionTarget,
  audience: PublicAudience,
): boolean => {
  if (!audience.roles.every((role) => canViewAs(channel, role))) return false;
  if (!coversRoleCombinations(guild, audience.channel, channel)) return false;
  const sourceViews = memberViews(channel);
  for (const [id, view] of sourceViews) {
    if (view !== 'deny' || audience.memberViews.get(id) === 'deny') continue;
    const member = guild.members.cache.get(id);
    if (
      member === undefined ||
      (canViewAs(audience.channel, member) && !canViewAs(channel, member))
    )
      return false;
  }
  for (const [id, view] of audience.memberViews) {
    if (view !== 'allow' || sourceViews.get(id) === 'allow') continue;
    const member = guild.members.cache.get(id);
    // An uncached member's roles are unknown; a matching explicit allow is required.
    if (member === undefined || !canViewAs(channel, member)) return false;
  }
  return true;
};
