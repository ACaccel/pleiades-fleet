/**
 * AlarmPlugin — rebuilds alarm jobs on startup and guild database recovery.
 *
 * The plugin resolves its dependencies through `ctx` and calls
 * `rebootAlarmJobs` from `application/alarm`. The `/alarm` actions
 * bridge into the same service via their own `BaseBot` reference,
 * since handlers and plugins may not import each other.
 */
import { TOKENS } from '../../bot/tokens';
import type { Plugin, PluginRuntimeContext } from '../../core/plugin';
import { type AlarmDeps, rebootAlarmJobs } from '../../application/alarm/alarm';

const PLUGIN_ID = 'alarm';
const PLUGIN_VERSION = '1.0.0';

const rebuildJobs = async (ctx: PluginRuntimeContext, guildId?: string): Promise<void> => {
  try {
    const deps: AlarmDeps = {
      client: ctx.resolve(TOKENS.DiscordClient),
      registry: ctx.resolve(TOKENS.GuildRegistry),
      jobMap: ctx.resolve(TOKENS.JobMap),
      logger: ctx.logger,
      translator: ctx.translator,
    };
    await rebootAlarmJobs(deps, guildId);
  } catch (err: unknown) {
    ctx.logger.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      'alarm: rebootJobs failed; alarm jobs may be missing',
    );
  }
};

export const createAlarmPlugin = (): Plugin => ({
  id: PLUGIN_ID,
  version: PLUGIN_VERSION,
  onReady: (ctx) => rebuildJobs(ctx),
  onGuildDatabaseReady: (ctx, guildId) => rebuildJobs(ctx, guildId),
});
