import type { CiRun, CiSnapshot } from './contracts';

const CI_PATH = '.github/workflows/ci.yml';
const CODEQL_PATH = '.github/workflows/codeql.yml';
const MIGRATION_PATH = '.github/workflows/migration-drill.yml';

export interface CiDecision {
  readonly ready: boolean;
  readonly reason: string;
}

function latestRun(runs: readonly CiRun[], path: string, sha: string): CiRun | undefined {
  return runs
    .filter(
      (run) =>
        run.workflowPath === path &&
        run.headSha === sha &&
        run.headBranch === 'dev' &&
        run.event === 'push',
    )
    .sort(
      (left, right) =>
        right.runNumber - left.runNumber ||
        right.id - left.id ||
        right.runAttempt - left.runAttempt,
    )[0];
}

export function evaluateCi(sha: string, snapshot: CiSnapshot): CiDecision {
  const gates: [string, readonly string[]][] = [
    [CI_PATH, ['quality', 'tests', 'security']],
    [CODEQL_PATH, ['analyze']],
  ];
  if (snapshot.migrationRequired || latestRun(snapshot.runs, MIGRATION_PATH, sha))
    gates.push([MIGRATION_PATH, ['migration-drill']]);
  for (const [path, names] of gates) {
    const run = latestRun(snapshot.runs, path, sha);
    if (!run) return { ready: false, reason: `Missing push CI: ${path}` };
    if (run.status !== 'completed' || run.conclusion !== 'success')
      return { ready: false, reason: `Push CI not successful: ${path}` };
    for (const name of names) {
      const jobs = run.jobs.filter((job) => job.name === name && job.runAttempt === run.runAttempt);
      if (jobs.length !== 1 || jobs[0]?.status !== 'completed' || jobs[0]?.conclusion !== 'success')
        return { ready: false, reason: `Required job not successful: ${name}` };
    }
  }
  return { ready: true, reason: 'Exact dev push CI passed' };
}
