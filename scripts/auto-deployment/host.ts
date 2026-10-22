import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { AUTO_BOTS, type Checkout, type CiRun, type DeploymentHost } from './contracts';
import type { AutoDeploymentSettings } from './settings';
import { deploymentSchema } from '../deployment/config';
import { prepareIsolatedRelease } from '../deployment/isolated';

const shaPattern = /^[0-9a-f]{40}$/;
const runSchema = z.object({
  id: z.number().int().positive(),
  run_number: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  path: z.string(),
  head_sha: z.string().regex(shaPattern),
  head_branch: z.string(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const runsSchema = z.array(
  z.object({
    total_count: z.number().int().nonnegative().safe(),
    workflow_runs: z.array(runSchema),
  }),
);
const jobsSchema = z.array(
  z.object({
    total_count: z.number().int().nonnegative().safe(),
    jobs: z.array(
      z.object({
        name: z.string(),
        run_attempt: z.number().int().positive(),
        status: z.string(),
        conclusion: z.string().nullable(),
      }),
    ),
  }),
);

async function output(
  program: string,
  args: readonly string[],
  cwd?: string,
  raw = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      [...args],
      { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(new Error(`${program} operation failed; check protected service logs`));
        else resolve(raw ? stdout : stdout.trim());
      },
    );
  });
}

async function execute(
  program: string,
  args: readonly string[],
  cwd: string,
  env = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', () => reject(new Error(`${program} could not start`)));
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${program} failed`)),
    );
  });
}

export function migrationInputsChanged(paths: readonly string[] | null, workflow: string): boolean {
  if (paths === null) return true;
  const block = /paths:\s*&drill-paths\s*\n([\s\S]*?)\n {2}push:/.exec(workflow)?.[1];
  if (!block) return true;
  const patterns = [...block.matchAll(/^\s+- ['"]([^'"]+)['"]\s*$/gm)].map((match) => match[1]!);
  if (
    !patterns.length ||
    patterns.some(
      (pattern) =>
        /[?[\]{}!]/.test(pattern) ||
        (pattern.includes('*') &&
          !(pattern.endsWith('/**') && !pattern.slice(0, -3).includes('*'))),
    )
  )
    return true;
  return paths.some((path) =>
    patterns.some((pattern) =>
      pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern,
    ),
  );
}

export function createDeploymentHost(settings: AutoDeploymentSettings): DeploymentHost {
  const git = (root: string, ...args: string[]): Promise<string> =>
    output('git', ['-C', root, ...args]);
  const api = (endpoint: string): Promise<string> =>
    output('gh', ['api', '--paginate', '--slurp', endpoint]);
  const checkCheckout = async (checkout: Checkout): Promise<void> => {
    if (
      checkout.directory !== settings.checkout ||
      (await git(checkout.directory, 'rev-parse', 'HEAD')) !== checkout.sha ||
      (await git(checkout.directory, 'status', '--porcelain', '--untracked-files=normal'))
    )
      throw new Error('Release checkout is dirty or does not match the approved commit');
  };
  const changedPaths = async (from: string, to: string): Promise<readonly string[] | null> => {
    if (!shaPattern.test(from) || !shaPattern.test(to)) throw new Error('Invalid comparison SHA');
    try {
      await git(settings.source, 'merge-base', '--is-ancestor', from, to);
      const result = await output(
        'git',
        ['-C', settings.source, 'diff', '--name-only', '--no-renames', '-z', from, to],
        undefined,
        true,
      );
      return result.split('\0').filter(Boolean);
    } catch {
      return null;
    }
  };
  let staged: { sha: string; bots: readonly string[]; id: string } | undefined;
  return {
    async fetchDevSha() {
      const remote = await git(settings.source, 'remote', 'get-url', 'origin');
      if (
        ![
          `git@github.com:${settings.repository}.git`,
          `https://github.com/${settings.repository}.git`,
        ].includes(remote)
      )
        throw new Error('Origin does not match the configured GitHub repository');
      await git(
        settings.source,
        'fetch',
        '--no-tags',
        'origin',
        '+refs/heads/dev:refs/remotes/origin/dev',
      );
      const sha = await git(settings.source, 'rev-parse', 'refs/remotes/origin/dev');
      if (!shaPattern.test(sha)) throw new Error('Invalid dev revision');
      return sha;
    },
    async readCi(sha) {
      if (!shaPattern.test(sha)) throw new Error('Invalid CI revision');
      const pages = runsSchema.parse(
        JSON.parse(
          await api(
            `repos/${settings.repository}/actions/runs?branch=dev&event=push&head_sha=${sha}&per_page=100`,
          ),
        ) as unknown,
      );
      const rawRuns = pages.flatMap((page) => page.workflow_runs);
      if (rawRuns.length !== pages[0]?.total_count) throw new Error('Incomplete workflow response');
      const runs: CiRun[] = [];
      for (const run of rawRuns) {
        const jobPages = jobsSchema.parse(
          JSON.parse(
            await api(
              `repos/${settings.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
            ),
          ) as unknown,
        );
        const jobs = jobPages.flatMap((page) => page.jobs);
        if (jobs.length !== jobPages[0]?.total_count) throw new Error('Incomplete workflow jobs');
        runs.push({
          id: run.id,
          runNumber: run.run_number,
          runAttempt: run.run_attempt,
          workflowPath: run.path,
          headSha: run.head_sha,
          headBranch: run.head_branch,
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          jobs: jobs.map((job) => ({
            name: job.name,
            runAttempt: job.run_attempt,
            status: job.status,
            conclusion: job.conclusion,
          })),
        });
      }
      const history = await output('gh', [
        'api',
        `repos/${settings.repository}/actions/workflows/ci.yml/runs?branch=dev&event=push&per_page=100`,
      ]);
      const ciHistory = runsSchema
        .parse([JSON.parse(history) as unknown])
        .flatMap((page) => page.workflow_runs);
      const current = ciHistory
        .filter((run) => run.head_sha === sha)
        .sort((a, b) => b.run_number - a.run_number)[0];
      const previous =
        current &&
        ciHistory
          .filter((run) => run.run_number < current.run_number)
          .sort((a, b) => b.run_number - a.run_number)[0];
      const paths = previous ? await changedPaths(previous.head_sha, sha) : null;
      const workflow = await git(
        settings.source,
        'show',
        `${sha}:.github/workflows/migration-drill.yml`,
      );
      return { runs, migrationRequired: migrationInputsChanged(paths, workflow) };
    },
    changedPaths,
    async createCheckout(sha) {
      if (!shaPattern.test(sha)) throw new Error('Invalid checkout revision');
      if (!existsSync(settings.checkout))
        await git(settings.source, 'worktree', 'add', '--detach', settings.checkout, sha);
      if (
        realpathSync(settings.checkout) !== settings.checkout ||
        !lstatSync(join(settings.checkout, '.git')).isFile()
      )
        throw new Error('Expected an independent linked worktree');
      const common = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
      if (
        (await git(settings.source, ...common)) !== (await git(settings.checkout, ...common)) ||
        (await git(settings.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')) !== 'HEAD' ||
        (await git(settings.checkout, 'status', '--porcelain', '--untracked-files=normal'))
      )
        throw new Error('Invalid or dirty deployment worktree');
      await git(settings.checkout, 'checkout', '--detach', sha);
      return { directory: settings.checkout, sha };
    },
    async prepare(checkout, sha, inputs) {
      if (sha !== checkout.sha) throw new Error('Unexpected input revision');
      await checkCheckout(checkout);
      for (const input of inputs) {
        if (realpathSync(input.source) !== input.source || !lstatSync(input.source).isFile())
          throw new Error('Operational inputs must be regular snapshots');
        const destination = join(checkout.directory, input.destination);
        if (await git(checkout.directory, 'ls-files', '--', input.destination))
          throw new Error('Operational inputs cannot overwrite tracked files');
        await git(checkout.directory, 'check-ignore', '--', input.destination);
        try {
          if (!lstatSync(destination).isFile())
            throw new Error('Operational input destination must be a regular file');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        if (realpathSync(dirname(destination)) !== dirname(destination))
          throw new Error('Operational input parents cannot contain symlinks');
        await copyFile(input.source, destination);
        await chmod(destination, 0o600);
      }
      // Disabled composition roots still import config.json during the full type gate.
      for (const bot of AUTO_BOTS) {
        const example = join(checkout.directory, 'src/bot', bot, 'config.example.json');
        const destination = join(checkout.directory, 'src/bot', bot, 'config.json');
        let absent = false;
        try {
          if (!lstatSync(destination).isFile())
            throw new Error('Bot configuration must be a regular file');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') absent = true;
          else throw error;
        }
        if (existsSync(example) && absent) {
          if (realpathSync(dirname(destination)) !== dirname(destination))
            throw new Error('Bot configuration parents cannot contain symlinks');
          await copyFile(example, destination);
          await chmod(destination, 0o600);
        }
      }
      await checkCheckout(checkout);
    },
    async build(checkout) {
      await checkCheckout(checkout);
      const buildEnv: NodeJS.ProcessEnv = { ...process.env, CONDA_EXE: settings.condaExecutable };
      for (const key of [
        'PLEIADES_NODE_PREFIX',
        'PLEIADES_CONDA_PREFIX',
        'PLEIADES_FONT_DIR',
        'CONDA_PREFIX',
        'NODE_PATH',
        'npm_config_prefix',
        'NPM_CONFIG_PREFIX',
      ])
        delete buildEnv[key];
      // setup-env.sh creates new versioned Node and font prefixes; active releases are immutable.
      await execute('bash', ['scripts/setup-env.sh'], checkout.directory, buildEnv);
      for (const gate of [
        'typecheck',
        'typecheck:emit',
        'lint',
        'format:check',
        'handlers:gen:check',
        'test:coverage',
        'knip',
        'security',
      ])
        await execute(
          process.execPath,
          ['scripts/runtime.mjs', 'exec', 'npm', 'run', gate],
          checkout.directory,
          buildEnv,
        );
      await checkCheckout(checkout);
    },
    async stage(checkout, targets) {
      if (targets.databaseServices.length)
        throw new Error('Database cutover requires the explicit maintenance procedure');
      await checkCheckout(checkout);
      const config = deploymentSchema.parse(
        JSON.parse(readFileSync(join(checkout.directory, 'deployment.json'), 'utf8')) as unknown,
      );
      if (!config.isolation || targets.bots.some((bot) => !config.bots.includes(bot)))
        throw new Error('Isolated deployment targets are not configured');
      staged = {
        sha: checkout.sha,
        bots: [...targets.bots],
        id: prepareIsolatedRelease(checkout.directory, config, targets.bots),
      };
    },
    async deploy(checkout, targets, progress) {
      if (
        !staged ||
        staged.sha !== checkout.sha ||
        JSON.stringify(staged.bots) !== JSON.stringify(targets.bots) ||
        targets.databaseServices.length
      )
        throw new Error('Release has not passed staging');
      const id = staged.id;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'sudo',
          ['-n', '/usr/local/libexec/pleiades-local-deploy', 'install', id],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        let pending = Promise.resolve();
        let progressError: unknown;
        const lines = createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          try {
            const event = z
              .object({
                event: z.literal('component'),
                service: z.string(),
                state: z.enum(['running', 'done', 'failed', 'rolled-back']),
              })
              .parse(JSON.parse(line) as unknown);
            const component = targets.bots.find(
              (bot) => event.service === `pleiades@${bot}.service`,
            );
            if (component)
              pending = pending
                .then(() =>
                  progress({
                    component,
                    state: event.state === 'rolled-back' ? 'failed' : event.state,
                  }),
                )
                .catch((error: unknown) => {
                  progressError = error;
                });
          } catch {
            /* The helper's ordinary progress is retained in its protected journal. */
          }
        });
        child.once('error', () => reject(new Error('Isolated installer could not start')));
        child.once('close', (code) => {
          void pending
            .then(() =>
              code === 0 && !progressError
                ? resolve()
                : reject(new Error('Isolated installation or progress persistence failed')),
            )
            .catch(reject);
        });
      });
      for (const component of targets.bots) await progress({ component, state: 'done' });
    },
    async recover() {
      await execute(
        'sudo',
        ['-n', '/usr/local/libexec/pleiades-local-deploy', 'recover'],
        settings.source,
      );
    },
  };
}
