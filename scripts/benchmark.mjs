// 코어 비용만 측정한다. 게임 simulation/serialization/render 비용은 포함하지 않는다.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import * as current from '../rollback-netcode.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sizes=process.env.SNAPSHOT_BYTES?[Number(process.env.SNAPSHOT_BYTES)]:[128*1024,1024*1024,2*1024*1024,4*1024*1024];
const steps=Number(process.env.BENCH_STEPS||240),results=[];
const versions=[['current',current]];
if(process.env.BENCH_BASELINE!=='0'){
  const revision='9f17ce6ee880df97f34c5e3b5d3d579ce4603d97',file=path.join(root,'.work/benchmark-baseline.mjs');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,execFileSync('git',['show',revision+':rollback-netcode.js'],{cwd:root,maxBuffer:1024*1024}));
  versions.unshift([revision,await import(pathToFileURL(file).href)]);
}
for(const profileName of ['rts','action'])for(const size of sizes)for(const [version,api]of versions){
  const state=new Uint8Array(size),view=new DataView(state.buffer),profile=api.profiles[profileName];
  const historyBytes=size*profile.stateHistorySize,defaultBudgetFits=historyBytes<=profile.maxHistoryBytes;
  const session=api.createSession({players:['a'],localPlayerId:'a',sessionId:'benchmark',simulationVersion:'blob-v1',inputSize:1,recordReplay:false,
    profile:{...profile,baseInputDelayTicks:0,adaptiveInputDelay:false,pacingPolicy:'none',maxHistoryBytes:Math.max(profile.maxHistoryBytes,historyBytes)},
    adapter:{save:()=>state,load:data=>state.set(data),validateSnapshot:data=>data.length===size,step:({tick})=>view.setUint32(0,tick+1,true)}});
  const costs=[],input=new Uint8Array(1);
  for(let tick=0;tick<steps;tick++){const start=performance.now();session.advance(input);costs.push(performance.now()-start)}
  assert.equal(view.getUint32(0,true),steps);costs.sort((a,b)=>a-b);
  const hash=session.getStateHash(),row={version,profile:profileName,snapshotBytes:size,steps,retainedSnapshotBytes:historyBytes,defaultBudgetFits,
    p50Ms:costs[Math.floor(steps*.5)],p95Ms:costs[Math.floor(steps*.95)],p99Ms:costs[Math.floor(steps*.99)],hash,stateHashComputations:session.metrics.stateHashComputations??null};
  results.push(row);session.close();console.log(JSON.stringify(row));
}
for(const result of results.filter(r=>r.version==='current')){
  const baseline=results.find(r=>r.version!=='current'&&r.profile===result.profile&&r.snapshotBytes===result.snapshotBytes);
  if(baseline)assert.equal(result.hash,baseline.hash,'Optimization preserves exact simulation result');
}
fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
fs.writeFileSync(path.join(root,'test-results/benchmark.json'),JSON.stringify({environment:{node:process.version,platform:process.platform,arch:process.arch},results},null,2));
