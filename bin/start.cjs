'use strict';

/**
 * Release launcher: `node bin/start.cjs [--check] [<bot>]`.
 *
 * Starts one personality from a release directory regardless of the working
 * directory, which suits a read-only release shared by several instances.
 * The bot comes from the first argument or else `PLEIADES_BOT`.
 *
 * `--check` loads the bot's code, verifies the Canvas fonts and, when one is
 * present, the config file, then prints `ok` and exits without connecting to
 * Discord, so a release can be verified before it is activated.
 *
 * Deployment settings (all optional, see docs/configuration.md): process
 * environment instead of `src/bot/<bot>/.env`, `PLEIADES_CONFIG_FILE`,
 * `PLEIADES_DATA_DIR`, `LOG_DIR`, `PLEIADES_FONT_DIR`.
 */

const { existsSync } = require('node:fs');
const path = require('node:path');

const BOTS = ['gopher', 'konata', 'msg-archive', 'nijika', 'tomori'];
const root = path.resolve(__dirname, '..');

function fail(message) {
  process.stderr.write(`pleiades launcher: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const positional = args.filter((arg) => arg !== '--check');
if (positional.length > 1 || positional.some((arg) => arg.startsWith('-'))) {
  fail(`usage: start.cjs [--check] [<bot>] (bots: ${BOTS.join(', ')})`);
}
const bot = positional[0] ?? process.env.PLEIADES_BOT;
if (bot === undefined || bot === '') {
  fail(`no bot selected; pass one as the first argument or set PLEIADES_BOT (${BOTS.join(', ')})`);
}
if (!BOTS.includes(bot)) {
  fail(`unknown bot "${bot}"; expected one of ${BOTS.join(', ')}`);
}

// Relative fallbacks (`./src/bot/<bot>/.env`, `data`, `logs`) are defined
// against the release root, wherever the process was started from.
process.chdir(root);

// A release carries production dependencies only (no pino-pretty) and its own
// fonts; explicit settings win.
process.env.NODE_ENV ??= 'production';
if (process.env.PLEIADES_FONT_DIR === undefined && existsSync(path.join(root, 'fonts'))) {
  process.env.PLEIADES_FONT_DIR = path.join(root, 'fonts');
}

// Type checking belongs to CI; the runtime only strips types, which cuts
// startup time and memory.
require('ts-node').register({
  project: path.join(root, 'tsconfig.json'),
  transpileOnly: true,
});
const tsconfig = require('tsconfig-paths').loadConfig(root);
if (tsconfig.resultType !== 'success') {
  fail(`cannot read tsconfig paths: ${tsconfig.message}`);
}
require('tsconfig-paths').register({
  baseUrl: tsconfig.absoluteBaseUrl,
  paths: tsconfig.paths,
});

if (check) {
  require(path.join(root, 'src/bot', bot, `${bot}.ts`));
  require(path.join(root, 'src/infra/graphics/canvas-font.ts')).ensureCanvasFont();
  if (
    !require(path.join(root, 'src/infra/graphics/canvas-emoji.ts')).renderEmojiImage(
      '\u{1F44D}',
      28,
    )
  ) {
    fail('the emoji font cannot render a colour glyph');
  }
  const botFiles = require(path.join(root, 'src/bot/bot-files.ts'));
  if (
    process.env.PLEIADES_CONFIG_FILE !== undefined ||
    existsSync(botFiles.defaultBotConfigFile(bot))
  ) {
    botFiles.loadBotConfig(bot);
  }
  process.stdout.write(`ok ${bot}\n`);
} else {
  require(path.join(root, 'src/bot', bot, 'index.ts'));
}
