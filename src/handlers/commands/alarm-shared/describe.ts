import type { AlarmDoc } from '../../../persistence/schemas/alarm.schema';

const PREVIEW_LENGTH = 50;

/** The message cut to a one-line preview. */
export const previewAlarmMessage = (message: string): string => {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > PREVIEW_LENGTH ? `${oneLine.slice(0, PREVIEW_LENGTH - 1)}…` : oneLine;
};

/**
 * `YYYY-MM-DD HH:mm · preview` in `timeZone`, for autocomplete choices,
 * which cannot render Discord timestamps.
 */
export const describeAlarmChoice = (
  doc: Pick<AlarmDoc, 'fire_at' | 'message'>,
  timeZone: string,
): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(doc.fire_at)
      .map((part) => [part.type, part.value]),
  );
  const when = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return `${when} · ${previewAlarmMessage(doc.message)}`;
};
