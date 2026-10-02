// Optional UI verification only. Consumers need neither Node.js nor Playwright.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDirectory = resolve(root, 'test-results');
const timeout = 20_000;

async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
  try { return await import(pathToFileURL(createRequire(import.meta.url).resolve('playwright')).href); }
  catch {
    const bundled = resolve(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
    try { return await import(pathToFileURL(bundled).href); }
    catch { throw new Error('Playwright is required only for browser verification. Set PLAYWRIGHT_MODULE to its index.mjs path.'); }
  }
}

async function launchBrowser(chromium) {
  if (process.env.BROWSER_CHANNEL) return chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL });
  const attempts = [];
  for (const channel of [undefined, 'chrome', 'msedge']) {
    try { return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); }
    catch (error) { attempts.push(error.message); }
  }
  throw new Error(`No Chromium browser is available. Set BROWSER_CHANNEL or install a Playwright browser. ${attempts.join('\n')}`);
}

async function serveDemo() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (path !== root && !path.startsWith(`${root}${sep}`)) { response.writeHead(403).end('Forbidden'); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };
      const bytes = await readFile(path);
      response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(bytes);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return server;
}

async function readState(page) {
  return JSON.parse(await page.locator('#debug-state').textContent());
}

async function settle(page, commandCount) {
  // Allow the held-input release to travel and pass the slowest preset's delay.
  await page.waitForTimeout(850);
  await page.waitForFunction(expected => {
    try {
      const peers = JSON.parse(document.querySelector('#debug-state').textContent).peers;
      return peers.length === 2 && peers.every(peer => peer.tick > 0 && peer.commandCount === expected) &&
        JSON.stringify(peers[0].positions) === JSON.stringify(peers[1].positions) &&
        JSON.stringify(peers[0].scores) === JSON.stringify(peers[1].scores);
    } catch { return false; }
  }, commandCount, { timeout });
  const state = await readState(page);
  await page.waitForTimeout(350);
  const next = await readState(page);
  assert.deepEqual(next.peers.map(peer => peer.positions), state.peers.map(peer => peer.positions), 'released input must stop both simulations');
  return next;
}

async function assertNoErrors(page, pageErrors) {
  assert.deepEqual(pageErrors, [], 'demo must have no uncaught browser errors');
  assert.equal(await page.locator('#error-log').evaluate(element => element.hidden && !element.textContent.trim()), true, 'demo error log must stay empty and hidden');
}

async function checkKoreanGuide(page) {
  assert.equal(await page.locator('html').getAttribute('lang'), 'ko');
  assert.equal(await page.locator('#quick-guide').isVisible(), true, 'first-time walkthrough must be visible');
  const guide = await page.locator('#quick-guide').textContent();
  for (const [topic, pattern] of [['start', /시작/], ['movement', /이동|움직/], ['score', /점수/], ['replay', /리플레이/], ['recovery', /복구/]]) {
    assert.match(guide, pattern, `Korean guide must explain ${topic}`);
  }
  assert.match(await page.locator('#start').textContent(), /[가-힣]/, 'primary action must be in Korean');
}

async function rtcState(page) {
  return page.evaluate(() => ({
    connections: window.__demoRtc.connections.map(connection => connection.connectionState),
    channels: window.__demoRtc.channels.map(channel => ({ label: channel.label, state: channel.readyState })),
  }));
}

async function startLocal(page, profile) {
  await page.selectOption('#mode', 'local');
  await page.selectOption('#profile', profile);
  await page.click('#start');
  await page.waitForFunction(() => document.querySelector('#connection-status').dataset.state === 'connected', null, { timeout });
  await page.waitForFunction(() => {
    try { return JSON.parse(document.querySelector('#debug-state').textContent).peers.length === 2; }
    catch { return false; }
  }, null, { timeout });
  const rtc = await rtcState(page);
  assert.equal(rtc.connections.filter(state => state === 'connected').length, 2, 'local mode must open two native RTCPeerConnections');
  assert.equal(rtc.channels.filter(channel => channel.state === 'open').length, 4, 'both peers must open input and control DataChannels');
  const state = await readState(page);
  assert.deepEqual(state.peers.map(peer => peer.peer), ['a', 'b']);
  return state;
}

async function checkReplay(page) {
  await page.click('#replay');
  await page.waitForFunction(() => document.querySelector('#replay-result').dataset.result === 'matched', null, { timeout });
  assert.match(await page.locator('#replay-result').textContent(), /리플레이/, 'replay feedback must be in Korean');
}

async function stopLocal(page) {
  await page.click('#stop');
  await page.waitForFunction(() => document.querySelector('#connection-status').dataset.state === 'idle', null, { timeout });
  assert.equal(await page.locator('#start').isEnabled(), true);
  const rtc = await rtcState(page);
  assert.ok(rtc.connections.every(state => state === 'closed'), 'stop must close every peer connection');
  assert.ok(rtc.channels.every(channel => channel.state === 'closed'), 'stop must close every DataChannel');
}

let server, browser;
const pages = [];
const pageErrors = [];
const report = { passed: false, profiles: [], pageErrors };
try {
  await mkdir(resultsDirectory, { recursive: true });
  if (!process.env.BASE_URL) server = await serveDemo();
  const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;
  const { chromium } = await loadPlaywright();
  browser = await launchBrowser(chromium);
  report.browser = browser.version(); report.url = base;
  const context = await browser.newContext({ viewport: { width: 1100, height: 1050 } });
  // Observe real browser objects without replacing their network behavior.
  await context.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection;
    const tracked = window.__demoRtc = { connections: [], channels: [] };
    function TrackedPeerConnection(...args) {
      const peer = new NativePeerConnection(...args);
      tracked.connections.push(peer);
      const createChannel = peer.createDataChannel.bind(peer);
      peer.createDataChannel = (...channelArgs) => {
        const channel = createChannel(...channelArgs); tracked.channels.push(channel); return channel;
      };
      peer.addEventListener('datachannel', event => tracked.channels.push(event.channel));
      return peer;
    }
    Object.setPrototypeOf(TrackedPeerConnection, NativePeerConnection);
    TrackedPeerConnection.prototype = NativePeerConnection.prototype;
    window.RTCPeerConnection = TrackedPeerConnection;
  });
  const page = await context.newPage(); pages.push(page);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base);
  await checkKoreanGuide(page);
  for (const profile of ['action', 'rts', 'lockstep']) {
    const initial = await startLocal(page, profile);
    // Native keyboard events exercise the tutorial's A-player movement.
    await page.click('#simulation');
    await page.keyboard.down('ArrowRight'); await page.waitForTimeout(350); await page.keyboard.up('ArrowRight');
    const keyboard = await settle(page, 0);
    assert.ok(keyboard.peers[0].positions[0] > initial.peers[0].positions[0], `${profile}: keyboard must move A right`);
    assert.equal(await page.locator('.direction.active').count(), 0, 'keyup must clear the held direction');
    // Pointer capture must release B even when the mouse leaves its button.
    const left = page.locator('.direction[data-player="b"][data-input="1"]');
    await left.scrollIntoViewIfNeeded();
    const bounds = await left.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down(); await page.waitForTimeout(350); await page.mouse.move(5, 5); await page.mouse.up();
    const pointer = await settle(page, 0);
    assert.ok(pointer.peers[0].positions[1] < keyboard.peers[0].positions[1], `${profile}: pointer must move B left`);
    assert.equal(await page.locator('.direction.active').count(), 0, 'pointerup outside the button must clear the direction');
    await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(180); await page.click('#release'); await page.keyboard.up('ArrowLeft');
    assert.equal(await page.locator('.direction.active').count(), 0, 'release action must clear all held directions');
    await settle(page, 0);
    await page.click('#command-a'); await page.click('#command-b');
    const scored = await settle(page, 2);
    assert.ok(scored.peers[0].scores.every(score => score > 0), `${profile}: both score commands must execute`);
    await checkReplay(page);
    if (profile === 'action') {
      await page.screenshot({ path: resolve(resultsDirectory, 'demo-ko-desktop.png'), fullPage: true });
      const beforeRecovery = scored.peers.find(peer => peer.peer === 'b').metrics.recoveries;
      await page.locator('#debug summary').click();
      await page.click('#desync');
      await page.waitForFunction(previous => {
        try { return JSON.parse(document.querySelector('#debug-state').textContent).peers.find(peer => peer.peer === 'b').metrics.recoveries > previous; }
        catch { return false; }
      }, beforeRecovery, { timeout });
      const recovered = await settle(page, 2);
      assert.deepEqual(recovered.peers[0].scores, scored.peers[0].scores, 'snapshot recovery must preserve both executed commands');
      report.recovery = recovered.peers.map(peer => ({ peer: peer.peer, positions: peer.positions, scores: peer.scores, recoveries: peer.metrics.recoveries }));
      await page.locator('#debug summary').click();
    }
    report.profiles.push({ profile, positions: scored.peers[0].positions, scores: scored.peers[0].scores, commandCount: scored.peers[0].commandCount, replay: 'matched', actualWebRTC: true });
    await assertNoErrors(page, pageErrors);
    await stopLocal(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await checkKoreanGuide(page);
  await startLocal(page, 'action');
  await page.click('#command-a'); await page.click('#command-b');
  await settle(page, 2); await checkReplay(page);
  const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(layout.document <= layout.viewport && layout.body <= layout.viewport, `390px layout must not overflow: ${JSON.stringify(layout)}`);
  await page.screenshot({ path: resolve(resultsDirectory, 'demo-ko-mobile.png'), fullPage: true });
  await assertNoErrors(page, pageErrors);
  await stopLocal(page);
  report.mobile = { ...layout, screenshot: 'test-results/demo-ko-mobile.png' };
  report.passed = true;
  await writeFile(resolve(resultsDirectory, 'demo-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = error.message;
  report.diagnostics = await Promise.all(pages.map(page => page.evaluate(() => ({
    status: document.querySelector('#connection-status')?.textContent,
    error: document.querySelector('#error-log')?.textContent,
    state: document.querySelector('#debug-state')?.textContent,
  })).catch(() => null)));
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(resolve(resultsDirectory, 'demo-failure.json'), `${JSON.stringify(report, null, 2)}\n`);
  await Promise.allSettled(pages.map((page, index) => page.screenshot({ path: resolve(resultsDirectory, `demo-failure-${index}.png`), fullPage: true })));
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
}
