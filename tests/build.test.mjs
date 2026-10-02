import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import * as bundle from '../rollback-netcode.js';
import * as source from '../src/index.js';
test('generated single-file distribution exposes the source entry API without runtime imports',()=>{
  execFileSync(process.execPath,['scripts/build.mjs','--check']);
  assert.deepEqual(Object.keys(bundle),Object.keys(source));
  const code=readFileSync('rollback-netcode.js','utf8');assert.doesNotMatch(code,/^\s*import\s|\bimport\s*\(/m);
  const declarations=readFileSync('rollback-netcode.d.ts','utf8');
  for(const name of Object.keys(bundle))assert.match(declarations,new RegExp('export (?:const|class|function) '+name+'\\b'));
});
test('the Core dependency boundary excludes signaling, WebRTC, cryptography and DOM',()=>{
  const code=readFileSync('src/core.js','utf8');assert.doesNotMatch(code,/nostr|WebSocket|RTCPeerConnection|\bdocument\.|\bwindow\./);
  assert.doesNotMatch(readFileSync('src/protocol.js','utf8'),/nostr|WebSocket|crypto\./);
});
