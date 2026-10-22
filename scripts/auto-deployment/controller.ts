import type { Notification } from '../../src/plugins/notification-relay/internal/request';
import { evaluateCi } from './ci';
import type {
  AutoBot,
  AutoDeploymentConfig,
  AutoDeploymentState,
  Checkout,
  ControllerAdapters,
  DatabaseService,
  DeploymentTargets,
} from './contracts';
import { deploymentNotice, flushOutbox, notificationKey, queueNotice } from './notifications';
import { selectBotTargets } from './targets';

export interface CycleOptions {
  readonly retryFailedBuild?: boolean;
  /** One-time, explicit cutover only. Ordinary poll cycles never include database services. */
  readonly cutoverDatabaseServices?: readonly DatabaseService[];
}
export type CycleOutcome =
  | {
      readonly kind: 'waiting' | 'halted' | 'unchanged' | 'superseded';
      readonly reason: string;
    }
  | {
      readonly kind: 'deployed' | 'build_failed' | 'install_failed';
      readonly sha: string;
    };

export function initialState(): AutoDeploymentState {
  return { version: 1, deployed: {}, attempt: 0, outbox: [] };
}

function assertSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Expected an exact Git commit SHA');
}

async function publish(
  state: AutoDeploymentState,
  sha: string,
  notice: Notification,
  adapters: ControllerAdapters,
): Promise<void> {
  queueNotice(state, sha, notice, adapters.now());
  await adapters.store.save(state);
  await flushOutbox(state, adapters, notificationKey(sha));
}

function failNotice(notice: Notification, summary: string): void {
  notice.status = 'failed';
  notice.summary = summary;
  for (const stage of notice.stages) if (stage.state === 'running') stage.state = 'failed';
}

export async function runCycle(
  config: AutoDeploymentConfig,
  adapters: ControllerAdapters,
  options: CycleOptions = {},
): Promise<CycleOutcome> {
  if (config.branch !== 'dev') throw new Error('Automatic deployments must track dev');
  return adapters.store.withLock(async () => {
    const state = await adapters.store.load();
    await flushOutbox(state, adapters);
    if (state.install)
      return {
        kind: 'halted',
        reason: 'Install journal requires explicit recover',
      };
    const sha = await adapters.host.fetchDevSha();
    assertSha(sha);
    if (state.blockedBuildSha === sha && !options.retryFailedBuild)
      return {
        kind: 'halted',
        reason: 'Build failed; retry explicitly or push a new dev commit',
      };
    const ci = evaluateCi(sha, await adapters.host.readCi(sha));
    if (!ci.ready) return { kind: 'waiting', reason: ci.reason };

    const changes: Partial<Record<AutoBot, readonly string[] | null>> = {};
    for (const bot of config.enabledBots) {
      const base = state.deployed[bot];
      changes[bot] = base
        ? base === sha
          ? []
          : await adapters.host.changedPaths(base, sha)
        : null;
    }
    const targets: DeploymentTargets = {
      bots: selectBotTargets(config.enabledBots, changes),
      databaseServices: options.cutoverDatabaseServices ?? [],
    };
    if (targets.bots.length === 0 && targets.databaseServices.length === 0) {
      state.lastInspectedSha = sha;
      await adapters.store.save(state);
      return {
        kind: 'unchanged',
        reason: 'No enabled service requires restart',
      };
    }

    state.attempt = state.attemptedSha === sha ? state.attempt + 1 : 1;
    state.attemptedSha = sha;
    delete state.blockedBuildSha;
    const notice = deploymentNotice(sha, state.attempt, targets);
    await publish(state, sha, notice, adapters);

    let checkout: Checkout;
    try {
      checkout = await adapters.host.createCheckout(sha);
      if (checkout.sha !== sha) throw new Error('Release checkout does not match approved SHA');
      await adapters.host.prepare(checkout, sha, config.operationalInputs);
      await adapters.host.build(checkout);
      await adapters.host.stage?.(checkout, targets);
    } catch {
      state.blockedBuildSha = sha;
      failNotice(notice, 'Build or preflight failed; inspect the protected deployment journal');
      await publish(state, sha, notice, adapters);
      return { kind: 'build_failed', sha };
    }

    notice.stages[0]!.state = 'done';
    await publish(state, sha, notice, adapters);

    // Recheck after the pre-stop notification: the next external action is installation.
    const currentSha = await adapters.host.fetchDevSha();
    const finalCi = evaluateCi(sha, await adapters.host.readCi(sha));
    if (currentSha !== sha || !finalCi.ready) {
      notice.status = 'cancelled';
      notice.summary = 'Installation deferred: dev or required CI changed during the build';
      for (const stage of notice.stages) stage.state = 'skipped';
      await publish(state, sha, notice, adapters);
      return { kind: 'superseded', reason: notice.summary };
    }

    state.install = { sha, checkout, targets, attempt: state.attempt };
    await adapters.store.save(state);
    try {
      await adapters.host.deploy(checkout, targets, async (progress) => {
        const stage = notice.stages.find((item) => item.label === progress.component);
        if (!stage) throw new Error('Unexpected installation component');
        stage.state = progress.state;
        await publish(state, sha, notice, adapters);
      });
    } catch {
      failNotice(
        notice,
        'Installation failed; explicit recovery is required before another deployment',
      );
      await publish(state, sha, notice, adapters);
      return { kind: 'install_failed', sha };
    }

    for (const bot of targets.bots) state.deployed[bot] = sha;
    state.lastInspectedSha = sha;
    delete state.install;
    notice.status = 'succeeded';
    notice.summary = `Attempt ${state.attempt} completed; all targeted services passed readiness`;
    for (const stage of notice.stages) stage.state = 'done';
    await publish(state, sha, notice, adapters);
    return { kind: 'deployed', sha };
  });
}

/** Recovery is an explicit operator action, never an automatic clear of a safety marker. */
export async function recoverController(adapters: ControllerAdapters): Promise<boolean> {
  return adapters.store.withLock(async () => {
    const state = await adapters.store.load();
    const marker = state.install;
    if (!marker) return false;
    await adapters.host.recover(marker);
    const notice = deploymentNotice(marker.sha, marker.attempt, marker.targets);
    failNotice(notice, 'Prior installation recovered; service baseline reconciled by the operator');
    delete state.install;
    await publish(state, marker.sha, notice, adapters);
    return true;
  });
}
