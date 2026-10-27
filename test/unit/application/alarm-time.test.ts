import { describe, expect, it } from 'vitest';

import { resolveAlarmTime } from '../../../src/application/alarm/alarm-time';

const TAIPEI = 'Asia/Taipei';
// 2026-10-27 12:00 in Taipei (UTC+8).
const NOW = Date.UTC(2026, 9, 27, 4, 0);

describe('resolveAlarmTime', () => {
  it('adds a duration to now', () => {
    expect(resolveAlarmTime('30m', NOW, TAIPEI)).toEqual({ ok: true, at: NOW + 30 * 60_000 });
    expect(resolveAlarmTime(' 2H ', NOW, TAIPEI)).toEqual({ ok: true, at: NOW + 2 * 3_600_000 });
  });

  it.each([
    ['2026-11-01 20:30', Date.UTC(2026, 10, 1, 12, 30)],
    ['2026/11/01 20:30', Date.UTC(2026, 10, 1, 12, 30)],
    ['  2026-11-01    20:30 ', Date.UTC(2026, 10, 1, 12, 30)],
    ['11-01 20:30', Date.UTC(2026, 10, 1, 12, 30)],
    ['20:30', Date.UTC(2026, 9, 27, 12, 30)],
  ])('reads %s in the guild time zone', (input, at) => {
    expect(resolveAlarmTime(input, NOW, TAIPEI)).toEqual({ ok: true, at });
  });

  it('rolls a passed time of day to tomorrow, across a month end', () => {
    expect(resolveAlarmTime('09:00', NOW, TAIPEI)).toEqual({
      ok: true,
      at: Date.UTC(2026, 9, 28, 1, 0),
    });
    // 2026-10-31 23:30 in Taipei.
    const lateNight = Date.UTC(2026, 9, 31, 15, 30);
    expect(resolveAlarmTime('00:10', lateNight, TAIPEI)).toEqual({
      ok: true,
      at: Date.UTC(2026, 9, 31, 16, 10),
    });
  });

  it('rolls a passed month and day to next year', () => {
    expect(resolveAlarmTime('01-05 08:00', NOW, TAIPEI)).toEqual({
      ok: true,
      at: Date.UTC(2027, 0, 5, 0, 0),
    });
  });

  it('honours a different time zone', () => {
    expect(resolveAlarmTime('20:30', NOW, 'UTC')).toEqual({
      ok: true,
      at: Date.UTC(2026, 9, 27, 20, 30),
    });
  });

  it.each(['tomorrow', '25:00', '12:60', '2026-02-30 10:00', '13-01 10:00', '', '5'])(
    'rejects %j as unrecognised',
    (input) => {
      expect(resolveAlarmTime(input, NOW, TAIPEI)).toEqual({ ok: false, reason: 'format' });
    },
  );

  it('rejects a time in the past', () => {
    expect(resolveAlarmTime('2026-10-27 11:00', NOW, TAIPEI)).toEqual({
      ok: false,
      reason: 'past',
    });
    expect(resolveAlarmTime('0m', NOW, TAIPEI)).toEqual({ ok: false, reason: 'past' });
  });

  it('rejects a time more than a year ahead', () => {
    expect(resolveAlarmTime('2027-11-01 00:00', NOW, TAIPEI)).toEqual({
      ok: false,
      reason: 'too_far',
    });
    expect(resolveAlarmTime('366d', NOW, TAIPEI)).toEqual({ ok: false, reason: 'too_far' });
    expect(resolveAlarmTime('365d', NOW, TAIPEI).ok).toBe(true);
  });
});
