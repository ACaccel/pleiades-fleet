/**
 * Assemble `.release/`, the self-contained tree LCM (or any host) runs with
 * `node bin/start.cjs <bot>`: sources, production dependencies, Canvas fonts
 * and the launcher. Needs only the pinned Node major and its bundled npm on
 * PATH, plus network access for `npm ci`; it runs no tests (CI gates those).
 *
 * Fonts come from `$LCM_INPUTS_DIR/fonts` when that variable is set; otherwise
 * from `$PLEIADES_FONT_DIR`, `$PLEIADES_CONDA_PREFIX/fonts` or `.conda-fonts/fonts`
 * (local development).
 */
import { spawn } from 'node:child_process';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.release');
const BOTS = ['gopher', 'konata', 'msg-archive', 'nijika', 'tomori'];
const FILES = ['package.json', 'package-lock.json', 'tsconfig.json'];
const DIRECTORIES = ['bin', 'src', 'assets'];
const FONT_FILES = ['NotoSansCJKtc-VF.ttf', 'NotoColorEmoji.ttf'];
/** Operator-owned files that live beside the sources in a local checkout. */
const OPERATOR_FILES =
  /^(?:\.env(?:\..*)?|config\.json|guild_profile\.json|avatar_url_list\.txt|remove_list\.txt)$/;

function log(message) {
  process.stdout.write(`release: ${message}\n`);
}

function run(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function requireNodeMajor() {
  const expected = (await readFile(join(root, '.nvmrc'), 'utf8')).trim().split('.')[0];
  const actual = process.versions.node.split('.')[0];
  if (actual !== expected) {
    throw new Error(`Node ${expected} is required (found ${process.versions.node}).`);
  }
}

async function fontSource() {
  // An explicitly provided input must not silently fall back to another source.
  const candidates = process.env.LCM_INPUTS_DIR
    ? [join(process.env.LCM_INPUTS_DIR, 'fonts')]
    : [
        process.env.PLEIADES_FONT_DIR,
        join(process.env.PLEIADES_CONDA_PREFIX ?? join(root, '.conda-fonts'), 'fonts'),
      ].filter(Boolean);
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) throw new Error(`Font directory must be absolute: ${candidate}`);
    const present = await Promise.all(
      FONT_FILES.map((name) =>
        lstat(join(candidate, name)).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (present.every(Boolean)) return candidate;
  }
  throw new Error(
    `Fonts not found; ${FONT_FILES.join(' and ')} must exist in ${candidates.join(' or ')}.`,
  );
}

async function copySources() {
  await mkdir(output, { recursive: true });
  for (const file of FILES) await copyFile(join(root, file), join(output, file));
  for (const directory of DIRECTORIES) {
    await cp(join(root, directory), join(output, directory), {
      recursive: true,
      // Symlinks in a local checkout point at operator files outside the tree.
      filter: async (source) =>
        !OPERATOR_FILES.test(basename(source)) && !(await lstat(source)).isSymbolicLink(),
    });
  }
  const fonts = await fontSource();
  log(`fonts from ${fonts}`);
  await mkdir(join(output, 'fonts'));
  for (const name of FONT_FILES) await copyFile(join(fonts, name), join(output, 'fonts', name));
}

/** Fail on a link that is absolute, dangling or leaving the release, and on operator files. */
async function assertClean() {
  const base = await realpath(output);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const inModules = relative(output, path).split(sep).includes('node_modules');
      if (!inModules && OPERATOR_FILES.test(entry.name)) {
        throw new Error(`Release contains an operator file: ${relative(output, path)}`);
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        const resolved = await realpath(path).catch(() => {
          throw new Error(`Release link is dangling: ${relative(output, path)} -> ${target}`);
        });
        if (isAbsolute(target) || (resolved !== base && !resolved.startsWith(base + sep))) {
          throw new Error(
            `Release link leaves the release: ${relative(output, path)} -> ${target}`,
          );
        }
      } else if (entry.isDirectory()) {
        await visit(path);
      }
    }
  }
  await visit(output);
}

async function main() {
  await requireNodeMajor();
  await rm(output, { recursive: true, force: true });
  await copySources();
  log('npm ci --omit=dev');
  await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: output });
  await assertClean();
  // Load every bot from a foreign working directory: proves the release is
  // self-contained, with native Canvas and the fonts usable.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const bot of BOTS) {
    log(`check ${bot}`);
    await run(process.execPath, [join(output, 'bin/start.cjs'), '--check', bot], {
      cwd: tmpdir(),
      env,
    });
  }
  log('assembled .release/');
}

main().catch((error) => {
  process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
