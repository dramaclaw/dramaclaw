#!/usr/bin/env node
/* Re-vendors OpenFilm Studio from upstream: clone at a ref → apply source-patches/ → build the
 * UI → patch the staged build → only then install it into vendor/openfilm.
 *
 *   node scripts/openfilm_studio/revendor.mjs --ref v0.2.5
 *   node scripts/openfilm_studio/revendor.mjs --ref v0.2.5 --from /tmp/openfilm   # reuse a clean checkout
 *
 * The UI source is not vendored, so an upgrade is always: new upstream source, our source patches
 * on top, a fresh Vite build, and new chunk names in patch_studio_ui.mjs. Everything that can
 * fail on an upstream change (patches, build, minified anchors) runs against a staged copy; when
 * it does, vendor/ and the patch script are left exactly as they were.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const VENDOR = join(REPO, 'vendor/openfilm');
const PATCH_SCRIPT = join(HERE, 'patch_studio_ui.mjs');
const SOURCE_PATCHES = join(HERE, 'source-patches');
const DEFAULT_REPO = 'https://github.com/openfilm/openfilm.git';

/* What the vendored runtime is made of. The UI ships as dist only — its source lives upstream. */
const RUNTIME_DIRS = ['src', 'studio/server', 'studio/ui/dist'];
const RUNTIME_FILES = ['studio/client.mjs', 'product.json', 'SPEC.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
/* Upstream keeps its unit tests and tsconfig next to the runtime; neither is shipped. */
const NOT_RUNTIME = /(\.test\.(?:m?js))$|[/\\]tsconfig\.json$/;

const USAGE =
  'usage: node scripts/openfilm_studio/revendor.mjs --ref <tag|branch|commit> [--repo <url>] ' +
  '[--from <checkout>] [--keep] [--no-tests]';

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...options });
}

function capture(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...options }).trim();
}

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { ref: null, repo: DEFAULT_REPO, from: null, keep: false, tests: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ref') options.ref = argv[++i];
    else if (arg === '--repo') options.repo = argv[++i];
    else if (arg === '--from') options.from = argv[++i];
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--no-tests') options.tests = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`unknown argument ${arg}\n${USAGE}`);
  }
  if (!options.help && !options.ref) fail(`--ref is required (a tag, branch or commit)\n${USAGE}`);
  return options;
}

function cloneUpstream(repo, ref, dir) {
  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    run('git', ['init', '-q', dir]);
    run('git', ['remote', 'add', 'origin', repo], { cwd: dir });
    run('git', ['fetch', '-q', '--depth', '1', 'origin', ref], { cwd: dir });
    run('git', ['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: dir });
    return;
  }
  run('git', ['clone', '-q', '--depth', '1', '--branch', ref, repo, dir]);
}

function sourcePatches() {
  if (!existsSync(SOURCE_PATCHES)) fail(`${SOURCE_PATCHES} is missing`);
  const patches = readdirSync(SOURCE_PATCHES).filter((name) => name.endsWith('.patch')).sort();
  if (!patches.length) fail(`no *.patch files under ${SOURCE_PATCHES}`);
  return patches;
}

function applySourcePatches(checkout, patches) {
  for (const name of patches) {
    try {
      run('git', ['apply', '--whitespace=nowarn', join(SOURCE_PATCHES, name)], { cwd: checkout });
    } catch {
      fail(
        `${name} does not apply to this checkout — upstream moved the code it touches. ` +
          `Re-derive that patch against the new source; nothing in vendor/ has changed.`,
      );
    }
  }
}

function packageManager() {
  /* The upstream repo pins pnpm through packageManager + corepack; fall back only if corepack is absent. */
  if (hasCommand('corepack')) return ['corepack', 'pnpm'];
  if (hasCommand('pnpm')) return ['pnpm'];
  return fail('neither corepack nor pnpm is on PATH — install Node with corepack (Node 22+)');
}

function buildUi(checkout, pkg) {
  const pnpm = packageManager();
  run(pnpm[0], [...pnpm.slice(1), 'install', '--frozen-lockfile', '--ignore-scripts'], { cwd: checkout });
  run(pnpm[0], [...pnpm.slice(1), '--filter', 'openfilm', 'build:ui'], { cwd: checkout });
  const dist = join(pkg, 'studio/ui/dist');
  if (!existsSync(join(dist, 'index.html'))) fail('the UI build produced no dist/index.html');
  return dist;
}

function stockChunk(dist) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const names = [...html.matchAll(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/g)].map((match) => match[1]);
  const unique = [...new Set(names)];
  if (unique.length !== 1) fail(`expected one stock UI chunk in dist/index.html, found ${unique.length}`);
  return unique[0];
}

function stageRuntime(pkg, dist, stage) {
  mkdirSync(stage, { recursive: true });
  const runtimeOnly = (path) => !NOT_RUNTIME.test(path);
  for (const rel of RUNTIME_DIRS) {
    const from = rel === 'studio/ui/dist' ? dist : join(pkg, rel);
    cpSync(from, join(stage, rel), { recursive: true, filter: runtimeOnly });
  }
  for (const rel of RUNTIME_FILES) cpSync(join(pkg, rel), join(stage, rel), { force: true });
}

function chunkNames(stock) {
  const current = readFileSync(PATCH_SCRIPT, 'utf8');
  const previous = (current.match(/^const PATCHED_CHUNK = '([^']+)';$/m) || [])[1];
  if (!previous) fail('patch_studio_ui.mjs lost its PATCHED_CHUNK constant');
  const round = Number((previous.match(/\.dramaclaw(\d+)\.js$/) || [])[1] || 0) + 1;
  /* The new name carries a fresh round number: /assets/* is immutable, so re-patching the same
     stock build under the same name would leave returning browsers on the old bundle. */
  return { stock, patched: `${stock.replace(/\.js$/, '')}.dramaclaw${round}.js` };
}

function patchStagedBuild({ tmp, dist, names }) {
  const script = readFileSync(PATCH_SCRIPT, 'utf8');
  let next = script;
  for (const [name, value] of [
    ['SOURCE_CHUNK', names.stock],
    ['PATCHED_CHUNK', names.patched],
  ]) {
    const anchor = new RegExp(`^const ${name} = '[^']+';$`, 'm');
    if (!anchor.test(next)) fail(`patch_studio_ui.mjs lost its ${name} constant`);
    next = next.replace(anchor, `const ${name} = '${value}';`);
  }
  const copy = join(tmp, 'patch_studio_ui.mjs');
  writeFileSync(copy, next);

  const env = { ...process.env, OPENFILM_STUDIO_DIST: dist };
  try {
    run('node', [copy], { env });
    run('node', [copy, '--check'], { env });
  } catch {
    fail(
      'the staged build could not be patched — the vendored copy is untouched. ' +
        `Re-derive the moved anchors in patch_studio_ui.mjs (staged chunk: ${join(dist, 'assets', names.stock)}).`,
    );
  }
  return next;
}

function installIntoVendor(stage) {
  const backup = join(VENDOR, '.revendor-backup');
  rmSync(backup, { recursive: true, force: true });
  mkdirSync(backup, { recursive: true });

  const moved = [];
  const written = [];
  const swap = (rel) => {
    const target = join(VENDOR, rel);
    const saved = join(backup, rel);
    if (existsSync(target)) {
      mkdirSync(dirname(saved), { recursive: true });
      renameSync(target, saved);
      moved.push(rel);
    }
    /* Record the target before writing it: a cpSync that dies halfway leaves a partial copy
       behind, and rollback has to remove that before the saved tree can be moved back. */
    written.push(rel);
    cpSync(join(stage, rel), target, { recursive: true, force: true });
  };

  try {
    for (const rel of [...RUNTIME_DIRS, ...RUNTIME_FILES]) swap(rel);
  } catch (error) {
    for (const rel of written) rmSync(join(VENDOR, rel), { recursive: true, force: true });
    for (const rel of moved) renameSync(join(backup, rel), join(VENDOR, rel));
    rmSync(backup, { recursive: true, force: true });
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
}

/* The repo runs its tests through uv; a dev shell often has uv only inside .venv. */
function pythonTests() {
  /* --no-sync: a guard run must not rewrite the developer's environment. */
  if (hasCommand('uv')) return ['uv', ['run', '--no-sync', 'pytest']];
  for (const candidate of [join(REPO, '.venv/bin/uv'), join(REPO, '.venv/bin/pytest')]) {
    if (existsSync(candidate)) {
      return candidate.endsWith('/uv') ? [candidate, ['run', '--no-sync', 'pytest']] : [candidate, []];
    }
  }
  fail('uv/pytest not found — run `uv sync --group dev` or activate .venv');
}

function updateReadmePin(version, commit) {
  const path = join(VENDOR, 'README.md');
  const current = readFileSync(path, 'utf8');
  const pin = /OpenFilm v[^\s,]+, upstream commit `[0-9a-f]{7,40}`/;
  if (!pin.test(current)) {
    console.warn('revendor: vendor/openfilm/README.md has no version/commit line to update');
    return;
  }
  writeFileSync(path, current.replace(pin, `OpenFilm v${version}, upstream commit \`${commit.slice(0, 7)}\``));
}

/* The vendored package.json is Dramaclaw's own install shim (it pins playwright-core for the
   runtime), not upstream's manifest — but its version tracks the vendored release. Leaving it
   behind is how the folder starts claiming 0.2.4 while shipping 0.2.5. */
function updatePackageVersion(version) {
  const pkgPath = join(VENDOR, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const lockPath = join(VENDOR, 'package-lock.json');
  if (!existsSync(lockPath)) return;
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const patches = sourcePatches();
  const tmp = mkdtempSync(join(tmpdir(), 'openfilm-revendor-'));
  let succeeded = false;

  try {
    let checkout;
    if (options.from) {
      checkout = resolve(options.from);
      if (!existsSync(join(checkout, 'packages/openfilm'))) fail(`${checkout} is not an OpenFilm checkout`);
      const dirty = capture('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: checkout });
      if (dirty) {
        fail(
          `${checkout} has local changes — reset it with \`git checkout -- .\` (revendor applies the stored ` +
            'patches itself) or point --from at a clean worktree',
        );
      }
    } else {
      checkout = join(tmp, 'openfilm');
      console.log(`revendor: cloning ${options.repo} at ${options.ref}`);
      cloneUpstream(options.repo, options.ref, checkout);
    }
    const commit = capture('git', ['rev-parse', 'HEAD'], { cwd: checkout });
    const pkg = join(checkout, 'packages/openfilm');
    const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
    console.log(`revendor: OpenFilm v${version} (${commit.slice(0, 7)}), ${patches.length} source patches`);

    applySourcePatches(checkout, patches);
    console.log('revendor: building the UI');
    const dist = buildUi(checkout, pkg);

    const names = chunkNames(stockChunk(dist));
    const stage = join(tmp, 'stage');
    stageRuntime(pkg, dist, stage);
    console.log(`revendor: patching staged build ${names.stock} → ${names.patched}`);
    const patchedScript = patchStagedBuild({ tmp, dist: join(stage, 'studio/ui/dist'), names });

    installIntoVendor(stage);
    writeFileSync(PATCH_SCRIPT, patchedScript);
    updateReadmePin(version, commit);
    updatePackageVersion(version);
    run('node', [PATCH_SCRIPT, '--check'], { cwd: REPO });

    if (options.tests) {
      const [python, args] = pythonTests();
      run(python, [...args, 'tests/test_openfilm_studio_ui_patch.py', '-q'], { cwd: REPO });
    }

    succeeded = true;
    console.log(
      `\nrevendor: vendor/openfilm is now OpenFilm v${version} (${commit.slice(0, 7)})\n` +
        `  source patches  ${patches.length}\n` +
        `  stock chunk     ${names.stock}\n` +
        `  patched chunk   ${names.patched}\n` +
        'Review the diff, then walk the checklist in scripts/openfilm_studio/README.md.',
    );
  } finally {
    if (succeeded && !options.keep) rmSync(tmp, { recursive: true, force: true });
    else console.error(`revendor: working copy kept at ${tmp}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`\nrevendor: ${error.message}`);
  process.exitCode = 1;
}
