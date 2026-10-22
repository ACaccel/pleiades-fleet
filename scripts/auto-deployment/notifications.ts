import type { Notification } from '../../src/plugins/notification-relay/internal/request';
import type {
  AutoDeploymentState,
  ControllerAdapters,
  DeploymentTargets,
  OutboxEntry,
} from './contracts';

export const MAX_OUTBOX_THREADS = 100;
export const MAX_NOTIFICATION_ATTEMPTS = 40;
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_DELIVERIES_PER_FLUSH = 8;
const RETRY_INTERVALS_MS = [5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000];

export function notificationKey(sha: string): string {
  return `pleiades-dev-${sha}`;
}

export function deploymentNotice(
  sha: string,
  attempt: number,
  targets: DeploymentTargets,
): Notification {
  const components = [...targets.bots, ...targets.databaseServices];
  return {
    title: `Pleiades dev deployment ${sha.slice(0, 12)}`,
    description: `Attempt ${attempt}\nBots: ${targets.bots.join(', ') || 'none'}\nDatabase services: ${targets.databaseServices.join(', ') || 'none'}`,
    status: 'running',
    stages: [
      { label: 'Build and preflight', state: 'running' },
      ...components.map((label) => ({ label, state: 'pending' as const })),
    ],
  };
}

/** Keep one latest payload per commit; a newer progress update replaces an older failure. */
export function queueNotice(
  state: AutoDeploymentState,
  sha: string,
  notification: Notification,
  now: number,
): void {
  const key = notificationKey(sha);
  state.outbox = state.outbox.filter((entry) => entry.key !== key);
  state.outbox.push({
    key,
    notification: structuredClone(notification),
    attempts: 0,
    nextAttemptAt: now,
    updatedAt: now,
  });
  state.outbox = state.outbox.slice(-MAX_OUTBOX_THREADS);
}

/** Network failures never change deployment success, and no remote error body is logged. */
export async function flushOutbox(
  state: AutoDeploymentState,
  adapters: ControllerAdapters,
  forceKey?: string,
): Promise<void> {
  const retained = state.outbox.filter(
    (entry) => adapters.now() - entry.updatedAt <= OUTBOX_RETENTION_MS,
  );
  if (retained.length !== state.outbox.length) {
    state.outbox = retained;
    await adapters.store.save(state);
  }
  const due = state.outbox
    .filter(
      (entry) =>
        entry.attempts < MAX_NOTIFICATION_ATTEMPTS &&
        (entry.nextAttemptAt <= adapters.now() || entry.key === forceKey),
    )
    .sort((left, right) => Number(right.key === forceKey) - Number(left.key === forceKey))
    .slice(0, MAX_DELIVERIES_PER_FLUSH);
  for (const entry of due) {
    try {
      await adapters.notifier.put(entry.key, entry.notification);
      state.outbox = state.outbox.filter((queued) => queued.key !== entry.key);
    } catch {
      deferNotification(entry, adapters.now());
      try {
        adapters.warn('Deployment notification unavailable; latest progress is saved for retry');
      } catch {
        // A logging failure must not turn a notification outage into an installation failure.
      }
    }
    await adapters.store.save(state);
  }
}

function deferNotification(entry: OutboxEntry, now: number): void {
  const interval = RETRY_INTERVALS_MS[entry.attempts] ?? 6 * 3_600_000;
  entry.attempts += 1;
  entry.nextAttemptAt = now + interval;
}
