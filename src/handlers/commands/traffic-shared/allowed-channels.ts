/**
 * Adapts a discord.js guild and the invoking member to the pure visibility rules
 * of `visibility-filter.ts`: View Channel and Manage Threads per cached channel,
 * the rank policy, and for a `public` reply the role and member permission
 * coverage of the command channel. {@link loadVisibleScope} also reads the
 * archive's channel records.
 */
import { PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import type { PermissionRankPolicy } from '@core/plugin';

import type { ArchiveChannelInfo } from '../../../core/archive/stats';
import type { DatabaseError } from '../../../core/errors/external-service-error';
import { parentChannelIdOf } from '../../../infra/discord';
import type { Repos } from '../../../persistence/repositories';

import type { Visibility } from './types';
import { commandAudience, coversAudience, type PublicAudience } from './audience-coverage';
import { resolveVisibleChannelIds, type LiveChannelAccess } from './visibility-filter';

/** The invoking member's access to every cached channel of the guild. */
const liveChannelAccessOf = (
  guild: Guild,
  member: GuildMember,
  audience: PublicAudience | undefined,
): ReadonlyMap<string, LiveChannelAccess> => {
  const access = new Map<string, LiveChannelAccess>();
  for (const [channelId, channel] of guild.channels.cache) {
    const permissions = 'permissionsFor' in channel ? channel.permissionsFor(member) : null;
    access.set(channelId, {
      type: channel.type,
      parentId: parentChannelIdOf(channel),
      canView: permissions?.has(PermissionFlagsBits.ViewChannel) ?? false,
      canManageThreads: permissions?.has(PermissionFlagsBits.ManageThreads) ?? false,
      audienceCanView:
        audience !== undefined &&
        'permissionsFor' in channel &&
        coversAudience(guild, channel.isThread() ? (channel.parent ?? channel) : channel, audience),
    });
  }
  return access;
};

interface VisibilityFilterInput {
  readonly guild: Guild;
  /** The invoker; `/traffic user` still filters by the invoker, not the counted member. */
  readonly member: GuildMember;
  readonly policy: PermissionRankPolicy;
  readonly mode: Visibility;
  readonly commandChannelId: string;
  /** `ArchiveStatsRepo.listChannels()`. */
  readonly records: readonly ArchiveChannelInfo[];
}

export const buildAllowedChannelSet = (input: VisibilityFilterInput): ReadonlySet<string> => {
  const { guild, member, policy } = input;
  // Audience coverage is only needed for a public reply.
  const audience =
    input.mode === 'public' ? commandAudience(guild, input.commandChannelId) : undefined;
  return resolveVisibleChannelIds({
    records: input.records,
    live: liveChannelAccessOf(guild, member, audience),
    mode: input.mode,
    userRank: policy.userRank(guild.id, member.roles.cache.keys()),
    commandChannelId: input.commandChannelId,
    channelRank: (channelId, ancestorIds) => policy.channelRank(guild.id, channelId, ancestorIds),
  });
};

/** The archive's channel records and the invoker's visible channels among them. */
export const loadVisibleScope = async (
  repos: Repos,
  input: Omit<Parameters<typeof buildAllowedChannelSet>[0], 'records'>,
): Promise<
  | {
      readonly ok: true;
      readonly records: readonly ArchiveChannelInfo[];
      readonly visible: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly error: DatabaseError }
> => {
  const records = await repos.archiveStats.listChannels();
  if (!records.ok) return records;
  return {
    ok: true,
    records: records.value,
    visible: buildAllowedChannelSet({ ...input, records: records.value }),
  };
};
