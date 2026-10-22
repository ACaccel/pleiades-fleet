import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ROUTE_NAME_PATTERN } from '../../src/plugins/notification-relay/internal/config';
import {
  NotificationSchema,
  THREAD_KEY_PATTERN,
} from '../../src/plugins/notification-relay/internal/request';
import type { DeploymentNotifier } from './contracts';

export interface RelayClientConfig {
  readonly endpoint: string;
  readonly route: string;
  readonly keyFile: string;
  readonly ownerUid: number;
  readonly timeoutMs?: number;
}

export function validateRelayConfig(config: RelayClientConfig): URL {
  const url = new URL(config.endpoint);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !ROUTE_NAME_PATTERN.test(config.route) ||
    !isAbsolute(config.keyFile) ||
    !Number.isSafeInteger(config.ownerUid) ||
    config.ownerUid < 0 ||
    (config.timeoutMs !== undefined &&
      (!Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 100 ||
        config.timeoutMs > 30_000))
  )
    throw new Error('Invalid deployment notification relay configuration');
  return url;
}

async function readRelayKey(config: RelayClientConfig): Promise<string> {
  const file = await open(config.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== config.ownerUid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 32 ||
      stat.size > 4096
    )
      throw new Error('Invalid relay key file permissions or format');
    const token = (await file.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9._~+/-]{32,512}={0,2}$/.test(token))
      throw new Error('Invalid relay key file permissions or format');
    return token;
  } finally {
    await file.close();
  }
}

/** Only numeric loopback destinations are accepted; redirects cannot exfiltrate the key. */
export function createRelayClient(
  config: RelayClientConfig,
  request: typeof fetch = fetch,
): DeploymentNotifier {
  const base = validateRelayConfig(config);
  return {
    async put(key, notification): Promise<void> {
      try {
        if (!THREAD_KEY_PATTERN.test(key)) throw new Error('Invalid notification key');
        const payload = NotificationSchema.parse(notification);
        const token = await readRelayKey(config);
        const url = new URL(`/notifications/${config.route}/${key}`, base);
        const response = await request(url, {
          method: 'PUT',
          redirect: 'error',
          signal: AbortSignal.timeout(config.timeoutMs ?? 5_000),
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error('Notification relay did not accept the update');
      } catch {
        throw new Error('Deployment notification delivery failed');
      }
    },
  };
}
