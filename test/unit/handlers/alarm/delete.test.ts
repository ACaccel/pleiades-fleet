import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import AlarmDelete from '../../../../src/handlers/commands/alarm_delete/action';
import { ok } from '../../../../src/core/result';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildAutocompleteInteraction,
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const GUILD_ID = 'guild-1';
const CREATOR_ID = 'creator-1';

const doc = (alarm_id: string, creator_id: string, fire_at: number, message: string) => ({
  alarm_id,
  creator_id,
  fire_at,
  message,
  channel_id: 'c-1',
  mention_everyone: false,
});

const ALARMS = [
  doc('later', CREATOR_ID, Date.UTC(2026, 10, 2, 1, 0), 'second'),
  doc('sooner', CREATOR_ID, Date.UTC(2026, 10, 1, 12, 30), 'first'),
  doc('theirs', 'someone-else', Date.UTC(2026, 10, 1, 0, 0), 'not mine'),
];

const build = ({ admin = false }: { admin?: boolean } = {}) => {
  const findByAlarmId = vi.fn().mockResolvedValue(ok(ALARMS[2]));
  const deleteByAlarmId = vi.fn().mockResolvedValue(ok(true));
  const listAll = vi.fn().mockResolvedValue(ok(ALARMS));
  const repos = { alarm: { findByAlarmId, deleteByAlarmId, listAll } };
  const { bot } = buildFakeBot({
    guildRegistry: { getRepos: () => repos },
    getRepos: () => repos,
    jobMap: new Map(),
    timeZone: 'Asia/Taipei',
    isAdmin: () => admin,
  });
  return { bot, findByAlarmId, deleteByAlarmId };
};

describe('/alarm delete autocomplete', () => {
  it('offers only the member’s own alarms, soonest first, in the server time zone', async () => {
    const { bot } = build();
    const interaction = buildAutocompleteInteraction({ userId: CREATOR_ID, guildId: GUILD_ID });
    const choices = await new AlarmDelete().autocomplete(interaction, bot);
    expect(choices).toEqual([
      { name: '2026-11-01 20:30 · first', value: 'sooner' },
      { name: '2026-11-02 09:00 · second', value: 'later' },
    ]);
  });

  it('filters by what was typed and shows a bot admin every alarm', async () => {
    const { bot } = build({ admin: true });
    const interaction = buildAutocompleteInteraction({
      userId: 'admin-1',
      guildId: GUILD_ID,
      focused: 'MINE',
    });
    const choices = await new AlarmDelete().autocomplete(interaction, bot);
    expect(choices.map((choice) => choice.value)).toEqual(['theirs']);
  });
});

describe('/alarm delete', () => {
  const execute = async (memberPermissions: readonly bigint[], userId = 'member-1') => {
    const setup = build();
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({
      userId,
      guildId: GUILD_ID,
      options: { alarm: 'theirs' },
      memberPermissions,
      sink,
    });
    await new AlarmDelete().execute(interaction, setup.bot);
    return { ...setup, sink };
  };

  it('refuses another member’s alarm', async () => {
    const { sink, deleteByAlarmId } = await execute([]);
    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(sink.editReplies).toEqual([{ content: 'replies:alarm.cancel_forbidden' }]);
    expect(deleteByAlarmId).not.toHaveBeenCalled();
  });

  it('lets its creator or a message manager delete it', async () => {
    for (const [perms, userId] of [
      [[], 'someone-else'],
      [[PermissionFlagsBits.ManageMessages], 'member-1'],
    ] as const) {
      const { sink, deleteByAlarmId } = await execute(perms, userId);
      expect(sink.editReplies).toEqual([{ content: 'replies:alarm.cancelled' }]);
      expect(deleteByAlarmId).toHaveBeenCalledWith('theirs');
    }
  });
});
