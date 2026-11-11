import { GatewayIntentBits } from 'discord.js';
import { MsgArchive } from './msg-archive';
import type configShape from './config.json';

import { bootstrapPersonality, GUILD_OBSERVER_INTENTS } from '../bootstrap';

// The backup loop lives in `MessageBackupPlugin`, scheduled by the
// host's `onReady` hook, so the composition root just starts the bot.
bootstrapPersonality<typeof configShape>({
  name: 'msg-archive',
  intents: [...GUILD_OBSERVER_INTENTS, GatewayIntentBits.GuildMessagePolls],
  build: (client, env, config) =>
    new MsgArchive(client, env.TOKEN, env.MONGO_URI ?? '', env.CLIENT_ID, config),
});
