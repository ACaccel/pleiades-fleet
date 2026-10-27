/**
 * Optional `alarm` block of a bot's `config.json`.
 *
 * `maxActivePerMember` bounds how many alarms one member may have
 * pending at once in a guild.
 */
import { z } from 'zod';

const DEFAULT_MAX_ACTIVE_PER_MEMBER = 5;

const ConfigSchema = z
  .object({
    alarm: z
      .object({ maxActivePerMember: z.number().int().min(1).max(50) })
      .strict()
      .optional(),
  })
  .passthrough();

/** The per-member cap; throws on a malformed block so startup reports it. */
export const parseAlarmConfig = (botConfig: unknown): { maxActivePerMember: number } => ({
  maxActivePerMember:
    ConfigSchema.parse(botConfig ?? {}).alarm?.maxActivePerMember ?? DEFAULT_MAX_ACTIVE_PER_MEMBER,
});
