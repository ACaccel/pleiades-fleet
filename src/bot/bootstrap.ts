/**
 * Shared entry-point body for the five personality composition roots.
 *
 * Every `src/bot/<name>/index.ts` performs the same steps in the
 * same order — load the personality's `.env` and `config.json`, validate
 * the environment into a typed {@link Env}, construct the Discord client
 * with that personality's gateway intents, then start the bot under the
 * {@link runOrExit} failure policy. Only the intent list and the constructor call differ,
 * so those are the parameters and everything else lives here; a startup
 * concern added here reaches all five personalities at once.
 */
import { Client, GatewayIntentBits, Partials } from 'discord.js';

import { loadEnv, type Env } from '../core/config';
import { waitForMongoReady } from '../infra/mongo/ready';

import { loadBotConfig, loadBotEnvFile } from './bot-files';
import { runOrExit, type StartablePersonality } from './run-or-exit';

/**
 * Intents for a personality that observes the whole guild: message
 * edits and deletes, member and role changes, invites,
 * scheduled events, automod. What the guild-events / activity /
 * message-backup feature set needs to see.
 */
export const GUILD_OBSERVER_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildEmojisAndStickers,
  GatewayIntentBits.GuildIntegrations,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildPresences,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildMessageTyping,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.DirectMessageReactions,
  GatewayIntentBits.DirectMessageTyping,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.AutoModerationExecution,
];

/**
 * Intents for a personality that only reads and answers messages. The
 * minimum for slash commands and message content — a bot
 * that mirrors nothing has no reason to receive the rest.
 */
export const MESSAGE_BOT_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

interface BootstrapOptions<C> {
  /**
   * Personality directory name under `src/bot/`. Selects the `.env` and
   * `config.json` files loaded before validation.
   */
  readonly name: string;
  readonly intents: readonly GatewayIntentBits[];
  /** Partial structures to receive, such as DM channels for DM message events. */
  readonly partials?: readonly Partials[];
  /** Env requirements this personality cannot start without. */
  readonly env?: {
    /** Require a usable `MONGO_URI`. Defaults to true. */
    readonly requireDb?: boolean;
  };
  /**
   * Construct the personality from its validated env and client, plus the
   * parsed `config.json`. `C` is the shape of the committed example config.
   */
  readonly build: (client: Client, env: Env, config: C) => StartablePersonality;
}

/**
 * Boot one personality. Returns once startup has been handed to
 * {@link runOrExit}, which owns the failure path (log, best-effort
 * teardown, exit 1) so a rejected login can never leave a zombie
 * process behind.
 */
/**
 * Partials for personalities that read DMs: discord.js emits a DM's
 * `messageCreate` only when the uncached DM channel may be partial.
 */
export const DM_PARTIALS: readonly Partials[] = [Partials.Channel];

export const bootstrapPersonality = <C>(options: BootstrapOptions<C>): void => {
  loadBotEnvFile(options.name);
  const requireDb = options.env?.requireDb ?? true;
  const env = loadEnv({ requireDb });
  let config: C;
  try {
    config = loadBotConfig<C>(options.name);
  } catch (err: unknown) {
    process.stderr.write(`bot startup failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
  let bot: StartablePersonality | undefined;
  // The database wait comes first so a bot started before MongoDB accepts
  // connections stays out of Discord, instead of logging in with its guilds
  // disabled; a timeout exits non-zero for the supervisor to restart.
  const startup: StartablePersonality = {
    get logger() {
      return bot?.logger;
    },
    run: async () => {
      if (requireDb && env.MONGO_URI !== undefined && env.MONGO_READY_TIMEOUT_SECONDS > 0) {
        await waitForMongoReady(env.MONGO_URI, env.MONGO_READY_TIMEOUT_SECONDS, {
          onUnavailable: () =>
            process.stderr.write(
              `waiting up to ${env.MONGO_READY_TIMEOUT_SECONDS} s for MongoDB to accept connections\n`,
            ),
        });
      }
      const client = new Client({
        intents: [...options.intents],
        ...(options.partials ? { partials: [...options.partials] } : {}),
      });
      bot = options.build(client, env, config);
      await bot.run();
    },
    shutdown: async () => {
      await bot?.shutdown?.();
    },
  };
  // `runOrExit` is written to always resolve, so the `catch` is the last
  // hole in the entry-point failure path rather than a routine branch:
  // it covers a throw on the failure path itself (a logger that is bound
  // but broken). stderr is the only sink guaranteed to work there.
  void runOrExit(startup).catch((err: unknown) => {
    process.stderr.write(`bot startup failed and the failure path threw: ${String(err)}\n`);
    process.exit(1);
  });
};
