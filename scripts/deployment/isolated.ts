import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'dotenv';
import { loadEnv } from '../../src/core/config/env';
import { validateBotSettings } from './bot-settings';
import { run } from './host';
import { runtimePrefixFor } from './release';
import type { BotName, DeploymentConfig } from './config';

const isolatedStageRoot = '/var/lib/pleiades-deployer/stage';
const isolatedHelper = '/usr/local/libexec/pleiades-local-deploy';
export interface IsolatedProgress {
  event: 'component';
  service: string;
  state: 'running' | 'done' | 'failed' | 'rolled-back';
}
/** Prepare unprivileged inputs; the installed helper supplies privileged paths and units. */
export function prepareIsolatedRelease(
  root: string,
  config: DeploymentConfig,
  bots: readonly BotName[],
): string {
  if (!config.isolation || config.user !== config.isolation.serviceUser)
    throw new Error('Configure isolation and user pleiades before isolated preparation');
  if (
    bots.length === 0 ||
    new Set(bots).size !== bots.length ||
    bots.some((bot) => !config.bots.includes(bot))
  )
    throw new Error('Select a nonempty unique subset of configured bots');
  for (const bot of bots) {
    const settings = join(config.isolation.settingsRoot, 'bots', bot);
    loadEnv({
      source: parse(readFileSync(join(settings, '.env'))),
      requireDb: bot !== 'gopher',
      exitOnFailure: false,
    });
    validateBotSettings(bot, readFileSync(join(settings, 'config.json'), 'utf8'));
  }
  const prefix = runtimePrefixFor(root, config);
  const fonts = resolve(process.env.PLEIADES_CONDA_PREFIX ?? join(root, '.conda-fonts'), 'fonts');
  if (!existsSync(join(fonts, 'NotoSansCJKtc-VF.ttf')))
    throw new Error('Missing fonts; run bash scripts/setup-env.sh');
  const id = `${Date.now()}-${randomUUID()}`;
  const stage = join(isolatedStageRoot, id);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const tracked = run('git', ['ls-files', '-z'], { cwd: root }).split('\0').filter(Boolean);
    for (const file of tracked) {
      if (
        !/^(?:src\/|scripts\/|tools\/mongo-backup\/|package(?:-lock)?\.json$|tsconfig(?:\.[^/]+)?\.json$)/.test(
          file,
        )
      )
        continue;
      if (/^src\/bot\/[^/]+\/(?:\.env|config\.json)$/.test(file)) continue;
      const source = resolve(root, file);
      const destination = resolve(stage, file);
      if (!source.startsWith(`${resolve(root)}/`) || !destination.startsWith(`${stage}/`))
        throw new Error('Invalid tracked release path');
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { dereference: false, verbatimSymlinks: true });
    }
    cpSync(join(root, 'node_modules'), join(stage, 'node_modules'), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    cpSync(prefix, join(stage, 'runtime'), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    cpSync(fonts, join(stage, 'fonts'), { recursive: true, dereference: true });
    run(
      join(stage, 'runtime/bin/node'),
      [
        '-e',
        "require('ts-node/register'); require('./src/infra/graphics/canvas-font').ensureCanvasFont()",
      ],
      {
        cwd: stage,
        env: { ...process.env, PLEIADES_FONT_DIR: join(stage, 'fonts') },
      },
    );
    writeFileSync(
      join(stage, 'manifest.json'),
      JSON.stringify({
        version: 1,
        id,
        bots,
        readinessTimeoutSeconds: config.readinessTimeoutSeconds,
        commit: run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim(),
      }) + '\n',
      { mode: 0o600 },
    );
    return id;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
/** Stream only schema-checked component events; stderr stays available to the operator. */
export async function deployIsolatedRelease(
  id: string,
  progress?: (event: IsolatedProgress) => void | Promise<void>,
): Promise<void> {
  if (!/^\d{13}-[a-f\d-]{36}$/.test(id)) throw new Error('Invalid isolated release id');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('sudo', ['-n', isolatedHelper, 'install', id], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let pending = '';
    let updates = Promise.resolve();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (value: string) => {
      pending += value;
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const event = JSON.parse(line) as Partial<IsolatedProgress>;
          if (
            event.event === 'component' &&
            typeof event.service === 'string' &&
            /^pleiades@(tomori|nijika|msg-archive|konata|gopher)\.service$/.test(event.service) &&
            ['running', 'done', 'failed', 'rolled-back'].includes(event.state ?? '')
          ) {
            updates = updates
              .then(async () => {
                await progress?.(event as IsolatedProgress);
              })
              .catch(() => undefined);
          }
        } catch {
          /* Non-event output is not forwarded as notification content. */
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      void updates.then(() =>
        code === 0
          ? resolvePromise()
          : reject(
              new Error(
                `Isolated deployment failed (exit ${code}); inspect the root helper journal`,
              ),
            ),
      );
    });
  });
}
export function recoverIsolatedDeployment(): void {
  run('sudo', ['-n', isolatedHelper, 'recover'], { quiet: false, timeoutMs: 900_000 });
}
