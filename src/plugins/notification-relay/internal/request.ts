/**
 * The request contract of `PUT /notifications/:route/:key`. Every display
 * string comes from the caller verbatim; only labels are translated.
 */
import { z } from 'zod';

/** Caller-chosen idempotency key naming one notification thread. */
export const THREAD_KEY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const STAGE_STATES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
const NOTIFICATION_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;

export type StageState = (typeof STAGE_STATES)[number];
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

const httpUrl = z
  .string()
  .max(500)
  .url()
  .refine((value) => /^https?:$/.test(new URL(value).protocol), 'must be an http(s) URL');

/** Bounds keep the rendered embed within Discord's limits. */
export const NotificationSchema = z
  .object({
    title: z.string().min(1).max(256),
    description: z.string().max(3000).optional(),
    url: httpUrl.optional(),
    stages: z
      .array(z.object({ label: z.string().min(1).max(100), state: z.enum(STAGE_STATES) }).strict())
      .max(10),
    status: z.enum(NOTIFICATION_STATUSES),
    summary: z.string().max(500).optional(),
    /** When the caller produced this update; a retried update keeps its original time. */
    occurredAt: z.string().datetime().optional(),
  })
  .strict();

export type Notification = z.infer<typeof NotificationSchema>;

/** Clock skew tolerated between a caller and the relay for `occurredAt`. */
export const OCCURRED_AT_MAX_SKEW_MS = 5 * 60_000;

/**
 * Parse a request body against the relay clock. Persisted copies of a
 * notification use {@link NotificationSchema} alone, because only a fresh
 * request can be checked against the current time.
 */
export const parseNotificationRequest = (
  body: unknown,
  now: Date,
): z.SafeParseReturnType<unknown, Notification> =>
  NotificationSchema.superRefine((notification, ctx) => {
    if (
      notification.occurredAt !== undefined &&
      Date.parse(notification.occurredAt) - now.getTime() > OCCURRED_AT_MAX_SKEW_MS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['occurredAt'],
        message: 'must not be in the future',
      });
    }
  }).safeParse(body);
