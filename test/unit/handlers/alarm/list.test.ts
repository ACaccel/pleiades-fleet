import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import AlarmList from '../../../../src/handlers/commands/alarm_list/action';
import { ok } from '../../../../src/core/result';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const build = (alarms: readonly Record<string, unknown>[]) => {
  const listByCreator = vi.fn().mockResolvedValue(ok(alarms));
  const { bot } = buildFakeBot({
    getRepos: () => ({ alarm: { listByCreator } }),
    translator: echoTranslatorWithParams(),
  });
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({ userId: 'member-1', guildId: 'g-1', sink });
  return { bot, sink, interaction, listByCreator };
};

describe('/alarm list', () => {
  it('reports no pending alarms', async () => {
    const { bot, sink, interaction } = build([]);
    await new AlarmList().execute(interaction, bot);
    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(sink.editReplies).toEqual([{ content: 'replies:alarm.list_empty' }]);
  });

  it('lists only the member’s alarms, soonest first, with a one-line preview', async () => {
    const { bot, sink, interaction, listByCreator } = build([
      { channel_id: 'c-2', fire_at: 2_000_000, message: 'second' },
      { channel_id: 'c-1', fire_at: 1_000_000, message: `first\n${'x'.repeat(80)}` },
    ]);
    await new AlarmList().execute(interaction, bot);
    expect(listByCreator).toHaveBeenCalledWith('member-1');
    const content = String(sink.editReplies[0]?.content);
    expect(content).toContain('replies:alarm.list_header:{"count":2}');
    expect(content.indexOf('<#c-1>')).toBeLessThan(content.indexOf('<#c-2>'));
    expect(content).toContain('first xxx');
    expect(content).toContain('…');
    expect(content).not.toContain('x'.repeat(60));
  });
});
