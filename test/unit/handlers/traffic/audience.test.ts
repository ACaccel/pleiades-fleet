import {
  ChannelType,
  Client,
  Guild,
  GuildMember,
  OverwriteType,
  PermissionFlagsBits,
  type APIOverwrite,
} from 'discord.js';
import { describe, expect, it } from 'vitest';

import { createPermissionRankPolicy } from '../../../../src/core/plugin';
import { buildAllowedChannelSet } from '../../../../src/handlers/commands/traffic-shared/allowed-channels';

const GUILD = '100000000000000001';
const INVOKER = '100000000000000002';
const READER = '100000000000000003';
const STAFF = '100000000000000004';
const COMMAND = '100000000000000005';
const SOURCE = '100000000000000006';
const THREAD = '100000000000000007';
const BLOCKED = '100000000000000008';
const ADMIN = '100000000000000009';
const VIEW = PermissionFlagsBits.ViewChannel.toString();

const overwrite = (id: string, allow: boolean, type = OverwriteType.Member): APIOverwrite => ({
  id,
  type,
  allow: allow ? VIEW : '0',
  deny: allow ? '0' : VIEW,
});

interface AudienceOptions {
  readonly command?: readonly APIOverwrite[];
  readonly source?: readonly APIOverwrite[];
  readonly readerCached?: boolean;
  readonly readerStaff?: boolean;
  readonly commandThread?: boolean;
  readonly readerRoles?: readonly string[];
  readonly everyoneCanView?: boolean;
  readonly invokerOwner?: boolean;
  readonly readerOwner?: boolean;
  readonly readerAdmin?: boolean;
}

/** Real SDK permission resolution, with no gateway connection or Discord API calls. */
const fixture = (options: AudienceOptions = {}) => {
  const client = new Client({ intents: [] });
  const member = (id: string, staff: boolean) => ({
    user: { id, username: id },
    roles: staff ? [STAFF] : [],
  });
  const channel = (id: string, overwrites: readonly APIOverwrite[] = []) => ({
    id,
    guild_id: GUILD,
    type: ChannelType.GuildText,
    name: id,
    permission_overwrites: overwrites,
  });
  // Guild's constructor is internal in the type declarations but consumes normal gateway data.
  const guild = Reflect.construct(Guild, [
    client,
    {
      id: GUILD,
      owner_id: options.invokerOwner
        ? INVOKER
        : options.readerOwner
          ? READER
          : '100000000000000099',
      name: 'Synthetic guild',
      roles: [
        {
          id: GUILD,
          name: '@everyone',
          permissions: options.everyoneCanView === false ? '0' : VIEW,
        },
        { id: STAFF, name: 'staff', permissions: VIEW },
        { id: BLOCKED, name: 'blocked', permissions: '0' },
        { id: ADMIN, name: 'admin', permissions: PermissionFlagsBits.Administrator.toString() },
      ],
      members: [
        member(INVOKER, true),
        ...(options.readerCached === false
          ? []
          : [
              {
                ...member(READER, options.readerStaff ?? false),
                ...(options.readerRoles ? { roles: options.readerRoles } : {}),
                ...(options.readerAdmin ? { roles: [ADMIN] } : {}),
              },
            ]),
      ],
      channels: [channel(COMMAND, options.command), channel(SOURCE, options.source)],
      threads: options.commandThread
        ? [{ id: THREAD, guild_id: GUILD, parent_id: COMMAND, type: ChannelType.PublicThread }]
        : [],
    },
  ]) as Guild;
  const invoker = guild.members.cache.get(INVOKER);
  if (invoker === undefined) throw new Error('Missing synthetic invoker');
  const allowed = (mode: 'public' | 'ephemeral' = 'public') =>
    buildAllowedChannelSet({
      guild,
      member: invoker,
      policy: createPermissionRankPolicy({}),
      mode,
      commandChannelId: options.commandThread ? THREAD : COMMAND,
      records: [],
    });
  return { guild, allowed };
};

describe('public traffic member overwrite coverage', () => {
  it.each([true, false])('excludes a source denying one reader (cached: %s)', (readerCached) => {
    const { guild, allowed } = fixture({ source: [overwrite(READER, false)], readerCached });
    if (readerCached) {
      const reader = guild.members.cache.get(READER)!;
      expect(guild.channels.cache.get(COMMAND)?.permissionsFor(reader)?.has('ViewChannel')).toBe(
        true,
      );
      expect(guild.channels.cache.get(SOURCE)?.permissionsFor(reader)?.has('ViewChannel')).toBe(
        false,
      );
    }
    expect(allowed().has(SOURCE)).toBe(false);
    expect(allowed('ephemeral').has(SOURCE)).toBe(true);
  });

  it('keeps a source when the same member is denied in both channels', () => {
    const { allowed } = fixture({
      command: [overwrite(READER, false)],
      source: [overwrite(READER, false)],
    });
    expect(allowed().has(SOURCE)).toBe(true);
    expect(allowed().has(COMMAND)).toBe(true);
  });

  it.each([true, false])('checks a member-only command reader (cached: %s)', (readerCached) => {
    const { allowed } = fixture({
      command: [
        overwrite(GUILD, false, OverwriteType.Role),
        overwrite(STAFF, true, OverwriteType.Role),
        overwrite(READER, true),
      ],
      source: [
        overwrite(GUILD, false, OverwriteType.Role),
        overwrite(STAFF, true, OverwriteType.Role),
      ],
      readerCached,
    });
    expect(allowed().has(SOURCE)).toBe(false);
    expect(allowed().has(COMMAND)).toBe(true);
  });

  it('accepts matching member grants even when the member is uncached', () => {
    const { allowed } = fixture({
      command: [overwrite(READER, true)],
      source: [overwrite(READER, true)],
      readerCached: false,
    });
    expect(allowed().has(SOURCE)).toBe(true);
  });

  it('resolves a cached command reader through their roles', () => {
    const { allowed } = fixture({
      command: [
        overwrite(GUILD, false, OverwriteType.Role),
        overwrite(STAFF, true, OverwriteType.Role),
        overwrite(READER, true),
      ],
      source: [
        overwrite(GUILD, false, OverwriteType.Role),
        overwrite(STAFF, true, OverwriteType.Role),
      ],
      readerStaff: true,
    });
    expect(allowed().has(SOURCE)).toBe(true);
  });

  it('inherits member exceptions from a command thread parent', () => {
    const { allowed } = fixture({ source: [overwrite(READER, false)], commandThread: true });
    expect(allowed().has(SOURCE)).toBe(false);
    expect(allowed().has(COMMAND)).toBe(true);
  });

  it('rejects a combination where a command allow overrides another role denial', () => {
    const { guild, allowed } = fixture({
      command: [
        overwrite(STAFF, true, OverwriteType.Role),
        overwrite(BLOCKED, false, OverwriteType.Role),
      ],
      source: [overwrite(BLOCKED, false, OverwriteType.Role)],
      readerRoles: [STAFF, BLOCKED],
    });
    const reader = guild.members.cache.get(READER)!;
    expect(guild.channels.cache.get(COMMAND)?.permissionsFor(reader)?.has('ViewChannel')).toBe(
      true,
    );
    expect(guild.channels.cache.get(SOURCE)?.permissionsFor(reader)?.has('ViewChannel')).toBe(
      false,
    );
    expect(allowed().has(SOURCE)).toBe(false);
  });

  it('keeps a source denying a cached member who cannot read the command channel', () => {
    const staffOnly = [
      overwrite(GUILD, false, OverwriteType.Role),
      overwrite(STAFF, true, OverwriteType.Role),
    ];
    const { allowed } = fixture({
      command: staffOnly,
      source: [...staffOnly, overwrite(READER, false)],
    });
    expect(allowed().has(SOURCE)).toBe(true);
  });

  it('matches SDK audience coverage across every two-role overwrite combination', () => {
    const states = [undefined, false, true] as const;
    const entries = (a: boolean | undefined, b: boolean | undefined) => [
      ...(a === undefined ? [] : [overwrite(STAFF, a, OverwriteType.Role)]),
      ...(b === undefined ? [] : [overwrite(BLOCKED, b, OverwriteType.Role)]),
    ];
    for (const everyoneCanView of [false, true])
      for (const commandA of states)
        for (const commandB of states)
          for (const sourceA of states)
            for (const sourceB of states) {
              const { guild, allowed } = fixture({
                everyoneCanView,
                invokerOwner: true,
                command: entries(commandA, commandB),
                source: entries(sourceA, sourceB),
              });
              const hiddenFromReader = [[], [STAFF], [BLOCKED], [STAFF, BLOCKED]].some((roles) => {
                const reader = Reflect.construct(GuildMember, [
                  guild.client,
                  { user: { id: READER, username: 'reader' }, roles },
                  guild,
                ]) as GuildMember;
                const canRead = (id: string) =>
                  guild.channels.cache.get(id)?.permissionsFor(reader)?.has('ViewChannel') ?? false;
                return canRead(COMMAND) && !canRead(SOURCE);
              });
              expect(
                allowed().has(SOURCE),
                JSON.stringify({ everyoneCanView, commandA, commandB, sourceA, sourceB }),
              ).toBe(!hiddenFromReader);
            }
  });

  it.each(['owner', 'administrator'])('uses effective source access for a denied %s', (kind) => {
    const { guild, allowed } = fixture({
      source: [overwrite(READER, false)],
      readerOwner: kind === 'owner',
      readerAdmin: kind === 'administrator',
    });
    const reader = guild.members.cache.get(READER)!;
    expect(guild.channels.cache.get(COMMAND)?.permissionsFor(reader)?.has('ViewChannel')).toBe(
      true,
    );
    expect(guild.channels.cache.get(SOURCE)?.permissionsFor(reader)?.has('ViewChannel')).toBe(true);
    expect(allowed().has(SOURCE)).toBe(true);
  });
});
