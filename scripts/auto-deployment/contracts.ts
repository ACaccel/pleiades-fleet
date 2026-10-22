import type {
  Notification,
  StageState,
} from '../../src/plugins/notification-relay/internal/request';

export const AUTO_BOTS = ['tomori', 'nijika', 'msg-archive', 'konata', 'gopher'] as const;
export type AutoBot = (typeof AUTO_BOTS)[number];
export type DatabaseService = 'mongodb-pleiades.service';
export interface DeploymentTargets {
  readonly bots: readonly AutoBot[];
  readonly databaseServices: readonly DatabaseService[];
}

interface CiJob {
  readonly name: string;
  readonly runAttempt: number;
  readonly status: string;
  readonly conclusion: string | null;
}
export interface CiRun {
  readonly id: number;
  readonly runNumber: number;
  readonly runAttempt: number;
  readonly workflowPath: string;
  readonly headSha: string;
  readonly headBranch: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly jobs: readonly CiJob[];
}
export interface CiSnapshot {
  readonly runs: readonly CiRun[];
  /** Derive from the push's complete changed-path range; uncertainty must mean true. */
  readonly migrationRequired: boolean;
}

interface OperationalInput {
  readonly source: string;
  readonly destination: string;
}
export interface AutoDeploymentConfig {
  readonly branch: 'dev';
  readonly enabledBots: readonly AutoBot[];
  /** Explicit files only: never copy the developer checkout or discover private inputs. */
  readonly operationalInputs: readonly OperationalInput[];
}
export interface Checkout {
  readonly directory: string;
  readonly sha: string;
}
interface ComponentProgress {
  readonly component: AutoBot | DatabaseService;
  readonly state: StageState;
}

export interface DeploymentHost {
  /** Fetch only origin/dev and return its exact full SHA. Never use the working tree. */
  fetchDevSha(): Promise<string>;
  readCi(sha: string): Promise<CiSnapshot>;
  /** Return both old and new paths for renames; null means missing/non-ancestor history. */
  changedPaths(fromSha: string, toSha: string): Promise<readonly string[] | null>;
  /** Independent, clean checkout of the exact SHA, outside the developer working tree. */
  createCheckout(sha: string): Promise<Checkout>;
  /** Validate and snapshot exactly the approved operational inputs; no live symlinks. */
  prepare(checkout: Checkout, sha: string, inputs: readonly OperationalInput[]): Promise<void>;
  build(checkout: Checkout): Promise<void>;
  stage?(checkout: Checkout, targets: DeploymentTargets): Promise<void>;
  /** Resolve only after readiness. Throw on failure; the host owns installation rollback. */
  deploy(
    checkout: Checkout,
    targets: DeploymentTargets,
    progress: (value: ComponentProgress) => Promise<void>,
  ): Promise<void>;
  /** Explicitly restore/reconcile any host install journal and verify prior service readiness. */
  recover(marker: InstallMarker): Promise<void>;
}
interface InstallMarker {
  sha: string;
  checkout: Checkout;
  targets: DeploymentTargets;
  attempt: number;
}
export interface OutboxEntry {
  key: string;
  notification: Notification;
  attempts: number;
  nextAttemptAt: number;
  updatedAt: number;
}
export interface AutoDeploymentState {
  version: 1;
  deployed: Partial<Record<AutoBot, string>>;
  lastInspectedSha?: string;
  attemptedSha?: string;
  attempt: number;
  blockedBuildSha?: string;
  install?: InstallMarker;
  outbox: OutboxEntry[];
}
export interface StateStore {
  /** Hold one cross-process lock for the entire operation, including notification retries. */
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  load(): Promise<AutoDeploymentState>;
  /** Atomic, durable replacement with restrictive owner-only access. */
  save(state: AutoDeploymentState): Promise<void>;
}
export interface DeploymentNotifier {
  /** PUT the same key to update one commit's message; never expose credentials in errors. */
  put(key: string, notification: Notification): Promise<void>;
}
export interface ControllerAdapters {
  readonly host: DeploymentHost;
  readonly store: StateStore;
  readonly notifier: DeploymentNotifier;
  readonly now: () => number;
  readonly warn: (message: string) => void;
}
