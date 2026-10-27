import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { Job } from 'node-schedule';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AlarmSet from '../../../../src/handlers/commands/alarm_set/action';
import { ok } from '../../../../src/core/result';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const GUILD_ID = 'guild-1';
const USER_ID = 'member-1';
const BOT_ID = 'bot-1';
const SEND = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

const jobMaps: Map<string, Job>[] = [];

afterEach(() => {
  for (const jm of jobMaps) for (const job of jm.values()) job?.cancel();
  jobMaps.length = 0;
});

const build = ({
  time = '2h',
  message = 'stand-up time',
  member = SEND,
  self = SEND,
  channelGuildId = GUILD_ID,
  pending = 0,
}: {
  time?: string;
  message?: string;
  member?: readonly bigint[];
  self?: readonly bigint[];
  channelGuildId?: string;
  pending?: number;
} = {}) => {
  const channel = {
    ...buildTextChannel({
      id: 'c-1',
      type: ChannelType.GuildText,
      permissionsBySubject: { [USER_ID]: member, [BOT_ID]: self },
    }),
    guildId: channelGuildId,
    isDMBased: () => false,
  };
  const create = vi.fn().mockImplementation(async (input: unknown) => ok(input));
  const listByCreator = vi
    .fn()
    .mockResolvedValue(ok(Array.from({ length: pending }, (_, i) => ({ alarm_id: `a${i}` }))));
  const jobMap = new Map<string, Job>();
  jobMaps.push(jobMap);
  const { bot } = buildFakeBot({
    client: { user: { id: BOT_ID }, channels: { fetch: vi.fn().mockResolvedValue(channel) } },
    guildRegistry: { getRepos: () => ({ alarm: { create, listByCreator } }) },
    jobMap,
    config: { alarm: { maxActivePerMember: 2 } },
    timeZone: 'Asia/Taipei',
    translator: echoTranslatorWithParams(),
  });
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    userId: USER_ID,
    guildId: GUILD_ID,
    options: { time, message },
    sink,
  });
  return { bot, interaction, sink, create, jobMap };
};

const run = async (setup: ReturnType<typeof build>) => {
  await new AlarmSet().execute(setup.interaction, setup.bot);
  return setup.sink.editReplies.map((reply) => reply.content);
};

describe('/alarm set', () => {
  it('stores and schedules the alarm, answering privately', async () => {
    const setup = build();
    const replies = await run(setup);
    expect(setup.sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^replies:alarm\.created:/);
    expect(replies[0]).toContain('<#c-1>');
    expect(setup.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'c-1',
        creator_id: USER_ID,
        message: 'stand-up time',
        mention_everyone: false,
      }),
    );
    expect(setup.jobMap.size).toBe(1);
  });

  it('records a creator who may mention everyone', async () => {
    const setup = build({ member: [...SEND, PermissionFlagsBits.MentionEveryone] });
    await run(setup);
    expect(setup.create).toHaveBeenCalledWith(expect.objectContaining({ mention_everyone: true }));
  });

  it.each([
    ['soon', 'replies:alarm.invalid_time'],
    ['0m', 'replies:alarm.time_in_past'],
    ['400d', 'replies:alarm.time_too_far'],
  ])('rejects the time %j', async (time, key) => {
    const setup = build({ time });
    const replies = await run(setup);
    expect(replies[0]).toMatch(new RegExp(`^${key.replace('.', '\\.')}`));
    expect(setup.create).not.toHaveBeenCalled();
  });

  it('rejects a blank message', async () => {
    const setup = build({ message: '   ' });
    expect(await run(setup)).toEqual(['replies:alarm.missing_message']);
    expect(setup.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the member',
      { member: [PermissionFlagsBits.ViewChannel] },
      'replies:alarm.member_cannot_send',
    ],
    ['the bot', { self: [PermissionFlagsBits.ViewChannel] }, 'replies:alarm.bot_cannot_send'],
    ['anyone here', { channelGuildId: 'other-guild' }, 'errors:command.channel_not_found'],
  ])('refuses a channel %s may not post in', async (_who, overrides, key) => {
    const setup = build(overrides);
    expect(await run(setup)).toEqual([key]);
    expect(setup.create).not.toHaveBeenCalled();
  });

  it('refuses a member at the configured cap', async () => {
    const setup = build({ pending: 2 });
    expect(await run(setup)).toEqual(['replies:alarm.too_many:{"max":2}']);
    expect(setup.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed alarm config block', () => {
    expect(() => new AlarmSet().validateBotConfig({ alarm: { maxActivePerMember: 0 } })).toThrow();
    expect(() => new AlarmSet().validateBotConfig({})).not.toThrow();
  });
});
