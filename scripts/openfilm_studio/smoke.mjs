// Proves a deployment can actually run the editor: Node starts the vendored server, Playwright's
// browser launches, and the served build is Dramaclaw's patched chunk. The image runs this at
// build time, so a missing browser, font or copied folder fails the build instead of the feature.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'vendor/openfilm/package.json'));
const { chromium } = require('playwright-core');

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<p id="t">视频合成与剪辑</p>');
  const text = await page.textContent('#t');
  check(text === '视频合成与剪辑', `page text came back as ${JSON.stringify(text)}`);

  const home = mkdtempSync(join(tmpdir(), 'openfilm-smoke-'));
  const key = 'smoke';
  const child = spawn(process.execPath, [join(root, 'scripts/openfilm_studio/run.mjs')], {
    cwd: root,
    env: { ...process.env, OPENFILM_HOME: home, OPENFILM_STUDIO_PORT: '0', OPENFILM_STUDIO_KEY: key },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  try {
    const said = await new Promise((done, failLaunch) => {
      let out = '';
      const timer = setTimeout(() => failLaunch(new Error(`no launch line after 30s: ${out}`)), 30_000);
      child.once('exit', (code) => failLaunch(new Error(`run.mjs exited ${code}`)));
      child.stdout.on('data', (chunk) => {
        out += chunk;
        try {
          const where = JSON.parse(out.split('\n')[0]);
          clearTimeout(timer);
          done(where);
        } catch {
          /* the line has not arrived whole yet */
        }
      });
    });

    const get = (path) => fetch(said.origin + path, { redirect: 'manual' });
    const health = await get('/api/health');
    check(health.status === 200, `/api/health answered ${health.status}`);

    const open = await get(`/open?key=${key}`);
    check(open.status === 302, `/open answered ${open.status}, expected the editor redirect`);

    const index = await get('/');
    const html = await index.text();
    check(index.status === 200, `/ answered ${index.status}`);
    const chunk = html.match(/assets\/[^"' ]+\.dramaclaw\d+\.js/)?.[0];
    check(chunk, 'index.html does not load a patched chunk; the stock editor would lose the embed');
    const asset = await get(`/${chunk}`);
    const source = await asset.text();
    check(asset.status === 200, `/${chunk} answered ${asset.status}`);
    check(source.includes('dramaclaw:studio-back'), `/${chunk} is missing the embed back navigation`);

    /* The chunk matching a regex is not the editor running. Cut a film the way the host does and
       boot the frame at it, then read the screen a person would see: staying on the Studio origin
       with its project header painted proves the bundle executes against this image's browser and
       fonts, and the copy it renders is where a brand the static sweep missed would surface. */
    const api = (path, init) =>
      fetch(said.origin + path, {
        ...init,
        headers: { 'x-studio-key': key, 'content-type': 'application/json' },
      });
    const created = await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'smoke' }) })).json();
    const film = created?.project?.id;
    check(film, `POST /api/projects created no film: ${JSON.stringify(created).slice(0, 200)}`);

    const target = new URLSearchParams({
      hostBack: 'http://127.0.0.1:5173/projects/smoke/freezone',
      hostBackLabel: '返回画布',
      /* the tag studio.py maps the host language onto: `zh` is not one of the editor's own
         codes, so sending it here would silently paint the English catalogue instead. */
      lang: 'zh-CN',
    });
    await page.goto(
      `${said.origin}/open?key=${key}&to=${encodeURIComponent(`/projects/${film}?${target}`)}`,
      { waitUntil: 'domcontentloaded' },
    );
    /* The embed's heading is the film name as a read-only label; the project list, the error card
       and the hand-back to the host all leave it absent. */
    const heading = page.locator('span.min-w-0.truncate').first();
    await heading.waitFor({ state: 'visible', timeout: 60_000 });
    check(
      page.url().startsWith(said.origin),
      `the editor left the Studio origin instead of painting: ${page.url()}`,
    );
    const painted = await page.evaluate(() => document.body.innerText);
    check(
      /[一-鿿]/.test(painted),
      `the editor ignored the host language: ${JSON.stringify(painted.slice(0, 200))}`,
    );
    check(
      !/OpenFilm/.test(painted),
      `the rendered editor still names the vendored product: ${JSON.stringify(painted.slice(0, 300))}`,
    );

    console.log(`openfilm studio smoke: ok (${chunk}, 「${(await heading.textContent())?.trim()}」 painted)`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((done) => {
      if (child.exitCode !== null) done();
      else child.once('exit', done);
    });
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`openfilm studio smoke: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
