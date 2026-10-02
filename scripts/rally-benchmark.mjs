// 선택적 실제 게임 Adapter 벤치. 게임 코드/배포는 수정하지 않는다.
// RALLY_HTML: PR #20의 Adapter가 있는 index.html, RALLY_REPO: 원본 Git 저장소.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const htmlPath=process.env.RALLY_HTML,repo=process.env.RALLY_REPO||path.dirname(htmlPath||'.');
if(!htmlPath)throw Error('Set RALLY_HTML to the game Adapter candidate index.html');
const legacyRef=process.env.RALLY_BASELINE||'0decb825d7d1e97a39b68c3661a16b401bd30176';
const currentHtml=fs.readFileSync(htmlPath,'utf8'),legacyHtml=execFileSync('git',['show',legacyRef+':index.html'],{cwd:repo,encoding:'utf8',maxBuffer:12*1024*1024});
const sdkSource=fs.readFileSync(path.join(root,'rollback-netcode.js'),'utf8');
let playwright;try{playwright=await import(pathToFileURL(createRequire(import.meta.url).resolve('playwright')).href)}catch{playwright=await import(pathToFileURL(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href)}
const browser=await playwright.chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'}),results=[];
const counts=(process.env.RALLY_COUNTS||'20,60,200').split(',').map(Number),steps=Number(process.env.RALLY_STEPS||60),warmup=12;
async function prepare(html,name){
  const page=await browser.newPage(),at=html.lastIndexOf('})();');assert.ok(at>0);
  const body=html.slice(0,at)+`window.__rallyPerf={StrategySim,GameRuleDefinition,HashUtil,StableSerializationUtil,
    RallySimulationAdapter:typeof RallySimulationAdapter==='undefined'?null:RallySimulationAdapter,
    RallyCommandCodec:typeof RallyCommandCodec==='undefined'?null:RallyCommandCodec};`+html.slice(at);
  await page.route('http://rally-perf.local/**',r=>r.fulfill({contentType:r.request().url().endsWith('.mjs')?'text/javascript':'text/html',body:r.request().url().endsWith('.mjs')?sdkSource:body}));
  await page.goto('http://rally-perf.local/'+name);await page.waitForFunction(()=>window.__rallyPerf);
  if(name==='current')await page.evaluate(async()=>{window.__newSDK=await import('/candidate.mjs')});
  return page;
}
async function measure({mode,count,steps,warmup,round}){
  const q=window.__rallyPerf,all=steps+warmup,saveCosts=[],loadCosts=[],stepCosts=[],totals=[];
  const rules=q.GameRuleDefinition.resolve({overrides:{simulation:{tps:20}}});q.GameRuleDefinition.current=rules;
  const start=performance.now(),draft={decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}};
  const sim=new q.StrategySim(draft,831047,rules);
  sim.applyDebugScenario({kind:'unit-combat',allyType:'swordsman',enemyType:'swordsman',allyCount:Math.min(count,60),enemyCount:Math.min(count,60),research:false,humanRole:'host'});
  // A benchmark scenario supplies only its initial roster through real spawn APIs.
  if(count>60)for(const side of [0,1])for(let i=60;i<count;i++){
    const col=(i-60)%16,row=Math.floor((i-60)/16);
    sim.spawnUnit(side,'swordsman',sim.world.width*.5+(col-7.5)*40,sim.world.height*.5+(side===0?1:-1)*(240+row*40));
  }
  sim.rebuildRuntimeIndexes();const initialUnits=sim.units.length,setupMs=performance.now()-start;
  const proto=q.StrategySim.prototype,originalStep=proto.step;
  proto.step=function(...args){const t=performance.now();try{return originalStep.apply(this,args)}finally{stepCosts.push(performance.now()-t)}};
  let core=null,adapter=null,initialBytes=null,sequence=0;
  const sdk=mode==='sdk-current'?window.__newSDK:window.RallyNetcode;
  if(mode.startsWith('sdk')){
    adapter=new q.RallySimulationAdapter({sim,onNetcodeFrameApplied(){}});
    const save=adapter.save.bind(adapter),load=adapter.load.bind(adapter);
    adapter.save=()=>{const t=performance.now();try{return save()}finally{saveCosts.push(performance.now()-t)}};
    adapter.load=b=>{const t=performance.now();try{return load(b)}finally{loadCosts.push(performance.now()-t)}};
    initialBytes=adapter.save().length;
    core=sdk.createSession({players:['host'],localPlayerId:'host',sessionId:'rally-perf',simulationVersion:'rally-perf-182',inputSize:1,seed:831047,adapter,recordReplay:true,
      profile:{...sdk.profiles.rts,baseInputDelayTicks:0,adaptiveInputDelay:false,pacingPolicy:'none',maxSnapshotBytes:8*1024*1024,maxHistoryBytes:256*1024*1024}});
  }
  const input=new Uint8Array(1);
  try{
    for(let tick=0;tick<all;tick++){
      const action=tick%17===4?{type:'SET_FLAG',x:sim.world.width*.5+(tick%3)*10,y:sim.world.height*.5-300,forced:true}:null;
      if(action){sequence++;if(core)core.queueCommand(q.RallyCommandCodec.encode(action));else sim.queueCommand({actor:'host',seq:tick*4096+1,tick:tick+1,netcodeSequence:sequence,action})}
      const before=performance.now();if(core){const result=core.advance(input);if(result.status!=='advanced')throw Error(result.status)}else sim.step();totals.push(performance.now()-before);
    }
    const stats=list=>{const sorted=list.slice(-steps).sort((a,b)=>a-b);return {p50:sorted[Math.floor(sorted.length*.5)]||0,p95:sorted[Math.floor(sorted.length*.95)]||0,total:list.reduce((a,b)=>a+b,0)}};
    const finalGameplayHash=sim.checksumBundle({includeScheduled:false}).root;
    const stateHash=adapter?window.__newSDK.hashBytes(adapter.save()):null;
    const snapshot=adapter?.save();if(snapshot)for(let i=0;i<8;i++)adapter.load(snapshot);
    return {round,mode,initialUnits,finalUnits:sim.units.length,tps:sim.tps,ticks:sim.tick,setupMs,snapshotBytes:initialBytes,totalMs:stats(totals),gameStepMs:stats(stepCosts),adapterSaveMs:stats(saveCosts),adapterLoadMs:stats(loadCosts),finalGameplayHash,stateHash,coreMetrics:core?.metrics||null};
  }finally{proto.step=originalStep;core?.close();sim.dispose('benchmark')}
}
async function measurePaired({count,steps,warmup}){
  const q=window.__rallyPerf,modes=['raw-current','sdk-previous','sdk-current'],cases=[],rules=q.GameRuleDefinition.resolve({overrides:{simulation:{tps:20}}});
  q.GameRuleDefinition.current=rules;
  const original=q.StrategySim.prototype.step;let active=null;
  q.StrategySim.prototype.step=function(...args){const start=performance.now();try{return original.apply(this,args)}finally{if(active)active.step+=performance.now()-start}};
  const sample=(values)=>{const sorted=values.slice(warmup).sort((a,b)=>a-b);return {p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],mean:sorted.reduce((a,b)=>a+b,0)/sorted.length}};
  try{
    for(const mode of modes){
      const sim=new q.StrategySim({decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}},831047,rules);
      sim.applyDebugScenario({kind:'unit-combat',allyType:'swordsman',enemyType:'swordsman',allyCount:Math.min(count,60),enemyCount:Math.min(count,60),research:false,humanRole:'host'});
      if(count>60)for(const side of [0,1])for(let i=60;i<count;i++)sim.spawnUnit(side,'swordsman',sim.world.width*.5+((i-60)%16-7.5)*40,sim.world.height*.5+(side===0?1:-1)*(240+Math.floor((i-60)/16)*40));
      sim.rebuildRuntimeIndexes();
      const row={mode,sim,initialUnits:sim.units.length,total:[],game:[],save:[],coreOnly:[],core:null,adapter:null};
      if(mode.startsWith('sdk')){
        const sdk=mode==='sdk-current'?window.__newSDK:window.RallyNetcode,adapter=new q.RallySimulationAdapter({sim,onNetcodeFrameApplied(){}}),save=adapter.save.bind(adapter);
        row.snapshotBytes=save().length;adapter.save=()=>{const start=performance.now();try{return save()}finally{if(active)active.save+=performance.now()-start}};
        row.adapter=adapter;row.core=sdk.createSession({players:['host'],localPlayerId:'host',sessionId:'paired',simulationVersion:'rally-perf-182',inputSize:1,seed:831047,adapter,recordReplay:true,
          profile:{...sdk.profiles.rts,baseInputDelayTicks:0,adaptiveInputDelay:false,pacingPolicy:'none',maxSnapshotBytes:8*1024*1024,maxHistoryBytes:256*1024*1024}});
      }cases.push(row);
    }
    const input=new Uint8Array(1);let sequence=0;
    for(let tick=0;tick<steps+warmup;tick++){
      const action=tick%17===4?{type:'SET_FLAG',x:cases[0].sim.world.width*.5+(tick%3)*10,y:cases[0].sim.world.height*.5-300,forced:true}:null;
      if(action)sequence++;
      const order=tick%2?[...cases].reverse():cases;
      for(const row of order){
        if(action){if(row.core)row.core.queueCommand(q.RallyCommandCodec.encode(action));else row.sim.queueCommand({actor:'host',seq:tick*4096+1,tick:tick+1,netcodeSequence:sequence,action})}
        active={step:0,save:0};const start=performance.now();
        if(row.core){if(row.core.advance(input).status!=='advanced')throw Error('Core did not advance');if(row.core.tick%20===0)row.core.getStateHash()}
        else row.sim.step();
        const total=performance.now()-start;row.total.push(total);row.game.push(active.step);row.save.push(active.save);row.coreOnly.push(Math.max(0,total-active.step-active.save));active=null;
      }
    }
    const report=cases.map(row=>({mode:row.mode,initialUnits:row.initialUnits,finalUnits:row.sim.units.length,snapshotBytes:row.snapshotBytes??null,
      ticks:row.sim.tick,tps:row.sim.tps,totalMs:sample(row.total),gameStepMs:sample(row.game),adapterSaveMs:sample(row.save),runtimeResidualMs:sample(row.coreOnly),
      finalGameplayHash:row.sim.checksumBundle({includeScheduled:false}).root,stateHash:row.adapter?window.__newSDK.hashBytes(row.adapter.save()):null}));
    if(new Set(report.map(r=>r.finalGameplayHash)).size!==1||report[1].stateHash!==report[2].stateHash)throw Error('Paired gameplay/state mismatch');
    return report;
  }finally{active=null;q.StrategySim.prototype.step=original;for(const row of cases){row.core?.close();row.sim.dispose('paired-benchmark')}}
}
try{
  const legacy=await prepare(legacyHtml,'legacy'),current=await prepare(currentHtml,'current');
  if(process.env.RALLY_PAIRED==='1'){
    for(const count of counts){const group=await current.evaluate(measurePaired,{count,steps,warmup});results.push(...group);console.log(JSON.stringify(group))}
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});fs.writeFileSync(path.join(root,'test-results/rally-paired-benchmark.json'),JSON.stringify({legacyRef,htmlPath,browser:browser.version(),steps,warmup,interleaved:true,periodicHashInterval:20,results},null,2));
  }else{
  for(let round=0;round<2;round++)for(const count of counts){
    const modes=round?['sdk-current','sdk-previous','raw-current','raw-legacy']:['raw-legacy','raw-current','sdk-previous','sdk-current'];
    const group=[];
    for(const mode of modes){const result=await(mode==='raw-legacy'?legacy:current).evaluate(measure,{mode,count,steps,warmup,round});results.push(result);group.push(result);console.log(JSON.stringify(result))}
    assert.equal(new Set(group.map(r=>r.finalGameplayHash)).size,1,'Same scenario/input timeline must preserve gameplay');
    assert.equal(group.find(r=>r.mode==='sdk-current').stateHash,group.find(r=>r.mode==='sdk-previous').stateHash,'Core optimization preserves complete game memento');
  }
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});fs.writeFileSync(path.join(root,'test-results/rally-benchmark.json'),JSON.stringify({legacyRef,htmlPath,browser:browser.version(),steps,warmup,results},null,2));
  }
}finally{await browser.close()}
