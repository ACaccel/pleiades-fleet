/**
 * Resolve the time a member typed for `/alarm set` to an epoch instant.
 *
 * Accepted forms, wall-clock ones read in the guild's time zone:
 * - a duration from now: `30m`, `2h`, `1d` (see `parseDuration`);
 * - `YYYY-MM-DD HH:mm` (or `/` separators);
 * - `MM-DD HH:mm`: this year, or next year when already past;
 * - `HH:mm`: today, or tomorrow when already past.
 *
 * Pure: the caller supplies `now` and the zone.
 */
import { parseDuration } from '@core/scheduling';
import { zoneOffsetMs, zonedTimeToEpoch } from '../../core/time';

/** Furthest ahead an alarm may be set (days). */
export const MAX_ALARM_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type AlarmTimeResult =
  | { readonly ok: true; readonly at: number }
  | { readonly ok: false; readonly reason: 'format' | 'past' | 'too_far' };

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const FULL_DATE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})$/;
const MONTH_DAY = /^(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})$/;

const isValidWall = ({ year, month, day, hour, minute }: WallTime): boolean =>
  month >= 1 &&
  month <= 12 &&
  day >= 1 &&
  day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
  hour <= 23 &&
  minute <= 59;

/** Today's calendar date in `timeZone`. */
const zonedToday = (now: number, timeZone: string): Pick<WallTime, 'year' | 'month' | 'day'> => {
  const local = new Date(now + zoneOffsetMs(timeZone, now));
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
};

/** The epoch for `wall`, or `null` for an impossible date such as 02-30. */
const epochOf = (wall: WallTime, timeZone: string): number | null =>
  isValidWall(wall) ? zonedTimeToEpoch(wall, timeZone) : null;

/** The first matching wall-clock instant after `now`, rolling a day or year forward. */
const nextOccurrence = (
  input: string,
  now: number,
  timeZone: string,
): number | null | undefined => {
  const nums = (match: RegExpExecArray): number[] => match.slice(1).map(Number);
  const today = zonedToday(now, timeZone);

  const full = FULL_DATE.exec(input);
  if (full) {
    const [year, month, day, hour, minute] = nums(full) as [number, number, number, number, number];
    return epochOf({ year, month, day, hour, minute }, timeZone);
  }

  const monthDay = MONTH_DAY.exec(input);
  if (monthDay) {
    const [month, day, hour, minute] = nums(monthDay) as [number, number, number, number];
    const thisYear = epochOf({ year: today.year, month, day, hour, minute }, timeZone);
    if (thisYear !== null && thisYear > now) return thisYear;
    return epochOf({ year: today.year + 1, month, day, hour, minute }, timeZone);
  }

  const timeOnly = TIME_ONLY.exec(input);
  if (timeOnly) {
    const [hour, minute] = nums(timeOnly) as [number, number];
    const at = epochOf({ ...today, hour, minute }, timeZone);
    if (at === null || at > now) return at;
    const tomorrow = zonedToday(now + MS_PER_DAY, timeZone);
    return epochOf({ ...tomorrow, hour, minute }, timeZone);
  }

  return undefined;
};

export const resolveAlarmTime = (raw: string, now: number, timeZone: string): AlarmTimeResult => {
  const input = raw.trim().replace(/\s+/g, ' ');
  const duration = parseDuration(input.toLowerCase());
  const at = duration === null ? nextOccurrence(input, now, timeZone) : now + duration;
  if (at === null || at === undefined) return { ok: false, reason: 'format' };
  if (at <= now) return { ok: false, reason: 'past' };
  if (at - now > MAX_ALARM_DAYS * MS_PER_DAY) return { ok: false, reason: 'too_far' };
  return { ok: true, at };
};
