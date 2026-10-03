import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDirectory = resolve(root, 'test-results');
const timeout = 45_000;
const targetTick = 240;

async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
  try {
    const require = createRequire(import.meta.url);
    return await import(pathToFileURL(require.resolve('playwright')).href);
  } catch {
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

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(root, `.${pathname === '/' ? '/tests/browser.html' : pathname}`);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };
    const bytes = await readFile(path);
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(bytes);
  } catch { response.writeHead(404).end('Not found'); }
});
await new Promise((resolveListening, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListening);
});

let browser;
let pages = [];
let report;
const browserErrors = [];
try {
  const { chromium } = await loadPlaywright();
  browser = await launchBrowser(chromium);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  pages = await Promise.all(contexts.map(context => context.newPage()));
  for (let index = 0; index < pages.length; index++) {
    pages[index].on('pageerror', error => browserErrors.push({ player: index ? 'b' : 'a', message: error.message }));
    await pages[index].setViewportSize({ width: 1100, height: 1050 });
  }
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/tests/browser.html`;
  await Promise.all(pages.map(page => page.goto(url)));
  assert.deepEqual(browserErrors, [], 'both browser pages must load the ES module without errors');
  await Promise.all(pages.map(page => page.waitForFunction(() => Boolean(window.harness), null, { timeout })));
  const capabilities = await pages[0].evaluate(async () => {
    const { createLoop, createSession, runSyncTest, runSyncTestAsync } = await import('/rollback-netcode.js');
    let tick=0,clock=0,allowed=true,polls=0,renders=0;
    const session={inputSize:1,profile:{tickRate:20,maxCatchupSteps:5},metrics:{pace:1},closed:false,resimulating:false,
      poll(){polls++;if(this.resimulating)this.resimulating=false},advance(){if(clock!==250)throw Error('frame clock');return{status:'advanced',tick:++tick}}};
    const loop=createLoop({session,beforeFrame:t=>{clock=t},canAdvance:()=>allowed,onAdvance:()=>{allowed=false},render:()=>renders++});
    loop.pulse(0);loop.pulse(250);session.resimulating=true;loop.pulse(500);
    const loopPassed=tick===1&&polls===3&&renders===3&&!session.resimulating;
    let value=0;
    const adapter={save:()=>new Uint8Array([value]),load:b=>{value=b[0]},validateSnapshot:b=>b.length===1,
      step:ctx=>{value=(value+ctx.inputs[0].input[0])%256}};
    const result=runSyncTest({adapter,players:['a'],inputSize:1,checkDistance:2,
      frames:Array.from({length:4},(_,tick)=>({tick,inputs:[{playerId:'a',input:new Uint8Array([1])}]}))});
    let heartbeats=0;const heartbeat=setInterval(()=>heartbeats++,0);
    let asyncResult;
    try{asyncResult=await runSyncTestAsync({adapter,players:['a'],inputSize:1,checkDistance:2,
      frames:Array.from({length:4},(_,tick)=>({tick,inputs:[{playerId:'a',input:new Uint8Array([1])}]}))})}
    finally{clearInterval(heartbeat)}
    const diagnosticsRestored=value===0;
    const core=createSession({adapter,players:['a'],localPlayerId:'a',sessionId:'bounded-browser',simulationVersion:'1',inputSize:1,
      profile:{baseInputDelayTicks:0,minInputDelayTicks:0,maxInputDelayTicks:0,adaptiveInputDelay:false,pacingPolicy:'none'}});
    for(let i=0;i<6;i++)core.advance(new Uint8Array([1]));
    const prefix=core.exportSyncTestFrames({maxFrames:2});prefix.frames[0].inputs[0].input[0]=99;
    const boundedPassed=prefix.frames.length===2&&prefix.initialTick===0&&core.exportSyncTestFrames({maxFrames:2}).frames[0].inputs[0].input[0]===1;
    core.close();
    return {loopPassed,boundedPassed,asyncPassed:heartbeats>0&&asyncResult.hash===result.hash&&diagnosticsRestored,heartbeats,metricsPassed:Object.isFrozen(result.metrics)&&result.metrics.checkedTicks===4&&result.metrics.resimulatedTicks===7&&diagnosticsRestored,
      metrics:result.metrics};
  });
  assert.ok(capabilities.loopPassed&&capabilities.metricsPassed&&capabilities.asyncPassed&&capabilities.boundedPassed, `browser capability verification: ${JSON.stringify(capabilities)}`);
  await Promise.all(pages.map((page, index) => page.evaluate(({ id, initiator }) => window.harness.createPeer(id, initiator), { id: index ? 'b' : 'a', initiator: index === 0 })));

  // Node relays SDP and ICE candidates; all game traffic travels through WebRTC.
  const offer = await pages[0].evaluate(() => window.harness.offer());
  const answer = await pages[1].evaluate(offer => window.harness.answer(offer), offer);
  await pages[0].evaluate(answer => window.harness.acceptAnswer(answer), answer);
  const connectDeadline = Date.now() + timeout;
  let relayedCandidates = 0;
  while (true) {
    const candidates = await Promise.all(pages.map(page => page.evaluate(() => window.harness.takeCandidates())));
    relayedCandidates += candidates[0].length + candidates[1].length;
    await Promise.all(pages.map((page, index) => page.evaluate(values => window.harness.addCandidates(values), candidates[1 - index])));
    if ((await Promise.all(pages.map(page => page.evaluate(() => window.harness.channelsOpen())))).every(Boolean)) break;
    assert.ok(Date.now() < connectDeadline, 'real WebRTC DataChannels did not open');
    await new Promise(resolveWaiting => setTimeout(resolveWaiting, 25));
  }
  await Promise.all(pages.map(page => page.evaluate(() => window.harness.start())));
  // The command is queued once before frame commitment, then transported with inputs.
  await pages[0].evaluate(() => window.harness.command([17]));
  const playDeadline = Date.now() + timeout;
  let snapshots = [];
  for (let round = 0; ; round++) {
    // Uneven small bursts create late remote input while retaining a bounded lead.
    snapshots = await Promise.all(pages.map((page, index) => page.evaluate(({ target, count }) => window.harness.step(target, count), {
      target: targetTick, count: index === 0 ? (round % 5 === 0 ? 3 : 1) : (round % 5 === 0 ? 1 : 2),
    })));
    if (snapshots.every(snapshot => snapshot.tick === targetTick && snapshot.confirmedTick >= targetTick - 1 && !snapshot.resimulating)) break;
    assert.ok(Date.now() < playDeadline, `sessions did not settle: ${JSON.stringify(snapshots)}`);
    if (round % 8 === 0) await new Promise(resolveWaiting => setTimeout(resolveWaiting, 5));
  }
  // Let the final ACK and checksum messages reach both independent pages.
  for (let round = 0; round < 12; round++) {
    await Promise.all(pages.map(page => page.evaluate(() => window.harness.poll())));
    await new Promise(resolveWaiting => setTimeout(resolveWaiting, 5));
  }
  const peers = await Promise.all(pages.map(page => page.evaluate(target => window.harness.report(target), targetTick)));
  report = { passed: peers.every(peer => peer.passed) && peers[0].hash === peers[1].hash && browserErrors.length === 0,
    transport: 'two real RTCPeerConnections in separate browser contexts', relayedCandidates, browserErrors, capabilities, peers };
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(resolve(resultsDirectory, 'browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await Promise.all(pages.map((page, index) => page.screenshot({ path: resolve(resultsDirectory, `browser-peer-${index ? 'b' : 'a'}.png`), fullPage: true })));
  assert.ok(relayedCandidates > 0, 'ICE candidates were relayed through the Node harness');
  assert.ok(report.passed, `real WebRTC verification failed: ${JSON.stringify(report)}`);
  console.log(JSON.stringify({ passed: true, ticks: targetTick, hash: peers[0].hash, relayedCandidates, metrics: peers.map(peer => ({ player: peer.player, ...peer.metrics })), report: 'test-results/browser-report.json' }, null, 2));
} catch (error) {
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(resolve(resultsDirectory, 'browser-failure.json'), `${JSON.stringify({ message: error.message, browserErrors, report }, null, 2)}\n`);
  await Promise.allSettled(pages.map((page, index) => page.screenshot({ path: resolve(resultsDirectory, `browser-failure-${index}.png`), fullPage: true })));
  console.error(error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(pages.map(page => page.evaluate(() => window.harness?.close())));
  await browser?.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
