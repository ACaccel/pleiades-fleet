import { AUTO_BOTS, type AutoBot } from './contracts';

const DOC_FILES = new Set(['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE']);

function affectsBot(path: string, bot: AutoBot): boolean {
  if (path.startsWith('docs/') || DOC_FILES.has(path)) return false;
  const match = /^src\/bot\/([^/]+)\//.exec(path);
  if (match && AUTO_BOTS.some((name) => name === match[1])) return match[1] === bot;
  return true;
}

/** Each bot compares against its own last installed revision, never the previous poll. */
export function selectBotTargets(
  enabled: readonly AutoBot[],
  changes: Readonly<Partial<Record<AutoBot, readonly string[] | null>>>,
): AutoBot[] {
  return enabled.filter((bot) => {
    const paths = changes[bot];
    return paths === undefined || paths === null || paths.some((path) => affectsBot(path, bot));
  });
}
