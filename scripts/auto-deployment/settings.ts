import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { AUTO_BOTS } from './contracts';

const absolute = z
  .string()
  .refine((value) => isAbsolute(value) && resolve(value) === value && !/[\r\n\0]/.test(value));
const schema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: z.literal('dev'),
    source: absolute,
    checkout: absolute,
    stateDirectory: absolute,
    enabledBots: z
      .array(z.enum(AUTO_BOTS))
      .min(1)
      .refine((bots) => new Set(bots).size === bots.length),
    operationalInputs: z.array(
      z
        .object({
          source: absolute,
          destination: z
            .string()
            .regex(
              /^(?:deployment\.json|src\/guild_profile\.json|src\/bot\/(?:tomori|nijika|msg-archive|konata|gopher)\/(?:\.env|config\.json|guild_profile\.json|avatar_url_list\.txt|remove_list\.txt))$/,
            ),
        })
        .strict(),
    ),
    condaExecutable: absolute,
    notification: z
      .object({ endpoint: z.string().url(), route: z.string(), keyFile: absolute })
      .strict()
      .optional(),
  })
  .strict();

export type AutoDeploymentSettings = z.infer<typeof schema>;

export function readAutoDeploymentSettings(path: string): AutoDeploymentSettings {
  const settings = schema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  for (const path of [settings.source, settings.stateDirectory]) {
    if (realpathSync(path) !== path) throw new Error('Deployment paths must not contain symlinks');
  }
  if (
    settings.source === settings.checkout ||
    settings.checkout.startsWith(`${settings.source}/`) ||
    settings.source.startsWith(`${settings.checkout}/`)
  )
    throw new Error('Development and release checkouts must be separate');
  if (
    settings.stateDirectory === settings.checkout ||
    settings.stateDirectory.startsWith(`${settings.checkout}/`)
  )
    throw new Error('Deployment state must be outside the release checkout');
  const destinations = settings.operationalInputs.map((input) => input.destination);
  if (
    new Set(destinations).size !== destinations.length ||
    !destinations.includes('deployment.json')
  )
    throw new Error('Operational inputs require one deployment.json and unique destinations');
  for (const bot of settings.enabledBots) {
    if (
      !destinations.includes(`src/bot/${bot}/.env`) ||
      !destinations.includes(`src/bot/${bot}/config.json`)
    )
      throw new Error(`Missing operational input snapshot for ${bot}`);
  }
  for (const input of settings.operationalInputs) {
    if (!input.source.startsWith(`${settings.stateDirectory}/inputs/`))
      throw new Error('Operational inputs must use independent snapshots in the state directory');
  }
  return settings;
}
