// Proves a deployment can actually run the editor: Node starts the vendored server, Playwright's
// browser launches, and the served build is Dramaclaw's patched chunk. The image runs this at
// build time, so a missing browser, font or copied folder fails the build instead of the feature.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { filmHtml } from '../../vendor/openfilm/src/film-doc.mjs';
import { FilmPage, launch } from '../../vendor/openfilm/src/host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

let browser;
try {
  browser = await launch();
  const page = await browser.newPage();
  await page.setContent('<p id="t">视频合成与剪辑</p>');
  const text = await page.textContent('#t');
  check(text === '视频合成与剪辑', `page text came back as ${JSON.stringify(text)}`);

  const home = mkdtempSync(join(tmpdir(), 'openfilm-smoke-'));
  const key = 'smoke';
  const child = spawn(process.execPath, [join(root, 'scripts/openfilm_studio/run.mjs')], {
    cwd: root,
    env: { ...process.env, OPENFILM_HOME: join(home, 'state'), OPENFILM_HOSTED_RENDER: '1', OPENFILM_STUDIO_PORT: '0', OPENFILM_STUDIO_KEY: key },
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
    const created = await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ path: join(home, 'film'), create: true }) })).json();
    const film = created?.project?.id;
    check(film, `POST /api/projects created no film: ${JSON.stringify(created).slice(0, 200)}`);
    const folder = join(home, 'film');
    mkdirSync(join(folder, 'assets'), { recursive: true });
    writeFileSync(join(folder, 'assets/smoke.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="royalblue"/><text x="25" y="90" fill="white" font-size="24">剪辑烟测</text></svg>');
    writeFileSync(join(folder, 'film.html'), filmHtml({
      stage: { w: 320, h: 180 },
      tracks: [{ clips: [{ id: 'smoke-clip', src: 'assets/smoke.svg', at: 0, time: [0, 1] }] }],
    }));

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

    const endpoint = `/api/projects/${film}`;
    const before = await (await api(endpoint)).json();
    const edit = await api(`${endpoint}/edit`, {
      method: 'POST', body: JSON.stringify({ base: before.rev, ops: [{ op: 'set', clip: 'smoke-clip', field: 'at', value: 0.1 }] }),
    });
    check(edit.ok, `edit answered ${edit.status}`);
    const saved = await (await api(endpoint)).json();
    check(saved.doc?.tracks?.[0]?.clips?.[0]?.at === 0.1, 'the edit was not saved');
    const preview = await fetch(`${saved.folder}film.html`);
    check(preview.ok && (await preview.text()).includes('smoke-clip'), 'preview did not serve the saved film');
    const started = await api(`${endpoint}/exports`, {
      method: 'POST', body: JSON.stringify({ jobs: [{ kind: 'video', codec: 'h264', fps: 12 }], folder: join(home, 'exports') }),
    });
    check(started.ok, `export answered ${started.status}`);
    const jobId = (await started.json()).exports?.[0]?.id;
    check(jobId, 'export did not return a job');
    let job;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = await (await api(`${endpoint}/exports`)).json();
      job = result.exports?.find((item) => item.id === jobId);
      if (['done', 'failed', 'cancelled'].includes(job?.status)) break;
      await new Promise((done) => setTimeout(done, 500));
    }
    check(job?.status === 'done', `export did not finish: ${JSON.stringify(job)}`);
    const output = job.outputs?.[0];
    check(output && statSync(output).size > 0, 'export produced no file');
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', output], { encoding: 'utf8' }));
    check(probe.streams?.some((stream) => stream.codec_name === 'h264'), 'export is not H.264');
    check(Number(probe.format?.duration) >= 1, 'export is truncated');

    // A fresh render context must also block transports that HTTP routing does
    // not intercept: Service Workers and WebSockets.
    let escaped = 0;
    const outside = createServer((_req, res) => { escaped++; res.end('unexpected'); });
    outside.on('upgrade', (_req, socket) => { escaped++; socket.destroy(); });
    await new Promise((done) => outside.listen(0, '127.0.0.1', done));
    const external = `http://127.0.0.1:${outside.address().port}`;
    const previousHosted = process.env.OPENFILM_HOSTED_RENDER;
    process.env.OPENFILM_HOSTED_RENDER = '1';
    let protectedFilm;
    try {
      writeFileSync(join(folder, 'network-worker.js'), `self.addEventListener('install', e => e.waitUntil(fetch('${external}/worker')));`);
      writeFileSync(join(folder, 'network-check.html'), `<!doctype html><script>
window.networkCheck = Promise.all([
  fetch('${external}/http').then(() => false, () => true),
  new Promise(resolve => { const ws = new WebSocket('${external.replace('http:', 'ws:')}/socket');
    ws.onclose = ws.onerror = () => resolve(true); ws.onopen = () => { resolve(false); ws.close(); }; }),
  navigator.serviceWorker.register('./network-worker.js').then(registration => !registration, () => true)
]);
window.film = { width: 320, height: 180, duration: 1, frame() {},
  ready: window.networkCheck.then(results => { window.networkResults = results; }) };
</script>`);
      const address = new URL('network-check.html', saved.folder);
      protectedFilm = await FilmPage.open(browser, address.origin, address.pathname);
      const results = await protectedFilm.page.evaluate(() => window.networkResults);
      check(results?.length === 3 && results.every(Boolean), `hosted transport was available: ${JSON.stringify(results)}`);
      check(escaped === 0, `${escaped} hosted render requests escaped its film origin`);
    } finally {
      await protectedFilm?.close();
      await new Promise((done) => outside.close(done));
      if (previousHosted === undefined) delete process.env.OPENFILM_HOSTED_RENDER;
      else process.env.OPENFILM_HOSTED_RENDER = previousHosted;
    }
    console.log(`openfilm studio smoke: ok (${chunk}; editor, edit, save, preview, H.264 export, hosted network isolation)`);

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
