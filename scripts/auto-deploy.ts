import { readAutoDeploymentSettings } from './auto-deployment/settings';
import { createDeploymentHost } from './auto-deployment/host';
import { createFileStateStore } from './auto-deployment/file-store';
import { recoverController, runCycle } from './auto-deployment/controller';
import { createRelayClient } from './auto-deployment/relay-client';
import type { DeploymentNotifier } from './auto-deployment/contracts';
import { userInfo } from 'node:os';

async function main(): Promise<void> {
  const [action = 'poll', path = '/etc/pleiades-auto-deploy.json', ...extra] =
    process.argv.slice(2);
  if (
    !['poll', 'retry-build', 'recover', 'inspect'].includes(action) ||
    extra.length ||
    process.getuid?.() === 0
  )
    throw new Error(
      'Usage: run as the deployment operator: auto-deploy.ts poll|retry-build|recover|inspect [config]',
    );
  const config = readAutoDeploymentSettings(path);
  const host = createDeploymentHost(config);
  const store = createFileStateStore(config.stateDirectory);
  const notifier: DeploymentNotifier = config.notification
    ? createRelayClient({ ...config.notification, ownerUid: userInfo().uid })
    : {
        async put(): Promise<void> {
          /* Notifications are explicitly disabled by configuration. */
        },
      };
  const adapters = {
    host,
    store,
    notifier,
    now: Date.now,
    warn: (message: string): void => console.error(message),
  };
  if (action === 'inspect') {
    await store.withLock(async () => {
      const sha = await host.fetchDevSha();
      const snapshot = await host.readCi(sha);
      console.log(
        JSON.stringify(
          {
            sha,
            ci: snapshot.runs.map((run) => ({
              workflow: run.workflowPath,
              status: run.status,
              conclusion: run.conclusion,
            })),
            migrationRequired: snapshot.migrationRequired,
            state: await store.load(),
          },
          null,
          2,
        ),
      );
    });
  } else if (action === 'recover')
    console.log(
      (await recoverController(adapters))
        ? 'Recovered interrupted deployment'
        : 'No interrupted deployment',
    );
  else
    console.log(
      JSON.stringify(
        await runCycle(config, adapters, { retryFailedBuild: action === 'retry-build' }),
      ),
    );
}

void main().catch(() => {
  // last-resort: do not include command output or credentials in operator errors.
  console.error(
    'Automatic deployment operation failed; inspect the protected journal and configuration.',
  );
  process.exitCode = 1;
});
