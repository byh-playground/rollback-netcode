// Optional live integration check: public relays + actual WebRTC, no test signaling server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
let playwright;
try { playwright = await import(pathToFileURL(createRequire(import.meta.url).resolve('playwright')).href); }
catch {
  const bundle = process.env.PLAYWRIGHT_MODULE ?? resolve(process.env.USERPROFILE ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  playwright = await import(pathToFileURL(bundle).href);
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost'), file = resolve(root, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(resolve(root) + sep)) { response.writeHead(403).end(); return; }
    const data = await readFile(file);
    response.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' }).end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
let pages = [];
const errors = [];
try {
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? 'chrome' });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  pages = await Promise.all(contexts.map(context => context.newPage()));
  pages.forEach((page, index) => page.on('pageerror', error => errors.push({ index, message: error.message })));
  const base = process.env.BASE_URL ?? `http://127.0.0.1:${server.address().port}/`;
  await Promise.all(pages.map(page => page.goto(base)));
  await pages[0].selectOption('#mode', 'host'); await pages[0].click('#start');
  const room = await pages[0].locator('#room-display').textContent();
  assert.match(room, /^\d{4}$/);
  await pages[1].selectOption('#mode', 'join'); await pages[1].fill('#room-input', room); await pages[1].click('#start');
  await Promise.all(pages.map(page => page.waitForFunction(() =>
    document.querySelector('#connection-status').dataset.state === 'connected', null, { timeout: 35000 })));
  await pages[0].click('#command-a'); await pages[1].click('#command-b');
  await Promise.all(pages.map(page => page.waitForFunction(() => {
    try { return JSON.parse(document.querySelector('#debug-state').textContent).peers[0]?.commandCount === 2; } catch { return false; }
  }, null, { timeout: 15000 })));
  await pages[0].keyboard.down('ArrowRight'); await pages[0].waitForTimeout(200); await pages[0].keyboard.up('ArrowRight');
  await pages[1].keyboard.down('a'); await pages[1].waitForTimeout(160); await pages[1].keyboard.up('a');
  await Promise.all(pages.map(page => page.click('#release')));
  await pages[0].waitForTimeout(500);
  const reports = await Promise.all(pages.map(page => page.locator('#debug-state').textContent().then(JSON.parse)));
  assert.deepEqual(reports[0].peers[0].positions, reports[1].peers[0].positions);
  assert.deepEqual(reports[0].peers[0].scores, reports[1].peers[0].scores);
  await Promise.all(pages.map(page => page.click('#replay')));
  await Promise.all(pages.map(page => page.waitForFunction(() => document.querySelector('#replay-result').dataset.result === 'matched', null, { timeout: 5000 })));
  assert.deepEqual(errors, []);
  const out = resolve(root, 'test-results'); await mkdir(out, { recursive: true });
  const report = { passed: true, room, browser: browser.version(), publicSignaling: true,
    actualWebRTC: true, separateContexts: true, differentNetworks: false, reports, errors };
  await writeFile(resolve(out, 'live-room-report.json'), JSON.stringify(report, null, 2));
  await Promise.all(pages.map((page, i) => page.screenshot({ path: resolve(out, `live-room-${i}.png`), fullPage: true })));
  console.log(JSON.stringify({ passed: true, room, positions: reports[0].peers[0].positions,
    scores: reports[0].peers[0].scores, publicSignaling: true, actualWebRTC: true, browser: report.browser }));
  await Promise.all(pages.map(page => page.click('#stop')));
} catch (error) {
  console.error(error.stack);
  const diagnostics = await Promise.all(pages.map(page => page.evaluate(() => ({
    status: document.querySelector('#connection-status')?.textContent,
    error: document.querySelector('#error-log')?.textContent,
    state: document.querySelector('#debug-state')?.textContent,
  })).catch(() => null)));
  console.error(JSON.stringify({ errors, diagnostics })); process.exitCode = 1;
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
