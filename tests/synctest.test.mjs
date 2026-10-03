import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncTestSession,runSyncTest,runSyncTestAsync,DeterminismError,SeededPRNG} from '../rollback-netcode.js';

function simulation({omitRng=false,omitDeadline=false,alias=false}={}){
  let tick=0,score=0,deadline=3;const random=new SeededPRNG(19),buffer=new Uint8Array(16),steps=[];
  const adapter={
    save(){const v=new DataView(buffer.buffer);v.setUint32(0,tick,true);v.setUint32(4,score,true);v.setUint32(8,omitRng?0:random.state,true);v.setUint32(12,omitDeadline?0:deadline,true);return alias?buffer:buffer.slice()},
    load(b){const v=new DataView(b.buffer,b.byteOffset,b.byteLength);tick=v.getUint32(0,true);score=v.getUint32(4,true);if(!omitRng)random.state=v.getUint32(8,true);if(!omitDeadline)deadline=v.getUint32(12,true)},
    validateSnapshot:b=>b.length===16,
    step(ctx){assert.equal(ctx.tick,tick);assert.equal(ctx.tickRate,20);steps.push({tick,resimulating:ctx.resimulating,synctesting:ctx.synctesting});
      score=(score+random.nextInt(17)+ctx.inputs[0].input[0])>>>0;
      for(const c of ctx.inputs[0].commands)score+=c.payload[0];
      if(tick>=deadline){score+=7;deadline=tick+3}tick++;
    }
  };return{adapter,steps};
}
const input=tick=>[{playerId:'a',input:new Uint8Array([tick%3]),commands:tick===2?[{sequence:1,executeTick:tick,payload:new Uint8Array([9])}]:[]}];
const options=sim=>({adapter:sim.adapter,players:['a'],inputSize:1,tickRate:20});
test('synctest verifies multiple rollback distances, reused save buffers and ring wraps',()=>{
  for(const checkDistance of [1,4,12]){
    const sim=simulation({alias:true}),testSession=createSyncTestSession({...options(sim),checkDistance});
    for(let tick=0;tick<40;tick++)testSession.advance(input(tick));
    assert.equal(testSession.tick,40);assert.equal(testSession.checkedTicks,40);assert.ok(testSession.resimulatedTicks>=40);
    assert.equal(new DataView(sim.adapter.save().buffer).getUint32(0,true),40);
    assert.ok(sim.steps.every(s=>s.synctesting));assert.equal(sim.steps.filter(s=>!s.resimulating).length,40);testSession.close();
  }
});
test('synctest detects omitted PRNG state and reports an actionable byte mismatch',()=>{
  const sim=simulation({omitRng:true}),s=createSyncTestSession(options(sim));
  assert.throws(()=>s.advance(input(0)),error=>{
    assert.ok(error instanceof DeterminismError);assert.equal(error.tick,1);assert.equal(error.checkpointTick,0);
    assert.notEqual(error.expectedHash,error.actualHash);assert.equal(error.firstDifference,4);return true;
  });assert.equal(s.status,'failed');assert.throws(()=>s.advance(input(1)),DeterminismError);assert.equal(s.tick,1);
});
test('synctest catches a missing tick deadline when it first affects gameplay',()=>{
  const sim=simulation({omitDeadline:true}),s=createSyncTestSession({...options(sim),checkDistance:4});
  for(let tick=0;tick<3;tick++)s.advance(input(tick));
  assert.throws(()=>s.advance(input(3)),e=>e instanceof DeterminismError&&e.tick===4);
});
test('batch synctest restores caller snapshot and agrees with a straight simulation',()=>{
  const sim=simulation(),before=sim.adapter.save(),frames=Array.from({length:20},(_,tick)=>({tick,inputs:input(tick)}));
  const result=runSyncTest({...options(sim),checkDistance:5,frames});assert.deepEqual(sim.adapter.save(),before);
  const straight=simulation();for(const frame of frames)straight.adapter.step({...frame,tickRate:20});
  const control=createSyncTestSession(options(straight));assert.equal(result.hash,control.getStateHash());assert.equal(result.tick,20);
});
test('invalid diagnostic input is rejected before gameplay; history budget is checked up front',()=>{
  const sim=simulation(),s=createSyncTestSession(options(sim)),before=sim.adapter.save();
  assert.throws(()=>s.advance([{playerId:'b',input:new Uint8Array(1)}]),/player/);assert.deepEqual(sim.adapter.save(),before);
  assert.throws(()=>createSyncTestSession({...options(sim),checkDistance:8,maxHistoryBytes:32}),/budget/);
});

test('SDK metrics snapshots expose diagnostic work without mutable payloads or extra simulation',()=>{
  const sim=simulation();let clock=0;const s=createSyncTestSession({...options(sim),checkDistance:4,now:()=>++clock});
  const initial=s.metrics;s.advance(input(0));s.advance(input(1));const m=s.metrics;
  assert.ok(Object.isFrozen(m));assert.equal(initial.tick,0);assert.equal(m.tick,2);assert.equal(m.checkedTicks,2);
  assert.equal(m.resimulatedTicks,3);assert.equal(m.historyBytes,48);assert.equal(m.stateHash,s.getStateHash());
  assert.equal(m.forwardCostMs,2);assert.equal(m.resimulationCostMs,2);assert.equal(m.totalCostMs,4);assert.equal(m.failure,null);
  s.close();assert.equal(s.metrics.status,'closed');assert.equal(s.metrics.historyBytes,0);assert.equal(s.metrics.stateHash,null);
});
test('batch metrics include failure summary and preserve caller state',()=>{
  const sim=simulation(),frames=Array.from({length:3},(_,tick)=>({tick,inputs:input(tick)}));
  const r=runSyncTest({...options(sim),checkDistance:2,frames});assert.equal(r.metrics.stateHash,r.hash);assert.equal(r.metrics.checkedTicks,3);
  const bad=simulation({omitRng:true}),initial=bad.adapter.save();
  assert.throws(()=>runSyncTest({...options(bad),frames}),e=>{
    assert.equal(e.syncTestMetrics.status,'failed');assert.equal(e.syncTestMetrics.resimulatedTicks,1);
    assert.equal(e.syncTestMetrics.failure.firstDifference,4);assert.ok(Object.isFrozen(e.syncTestMetrics.failure));
    assert.equal('expectedState' in e.syncTestMetrics.failure,false);return true;
  });assert.deepEqual(bad.adapter.save(),initial);
});

test('async batch yields before and after each shared session advance and restores caller state',async()=>{
  const sim=simulation(),before=sim.adapter.save(),frames=Array.from({length:4},(_,tick)=>({tick,inputs:input(tick)}));
  let yields=0;const pending=runSyncTestAsync({...options(sim),checkDistance:2,frames,yieldControl:async()=>{yields++}});
  assert.equal(sim.steps.length,0);const result=await pending;
  assert.equal(yields,8);assert.equal(result.metrics.checkedTicks,4);assert.equal(result.metrics.resimulatedTicks,7);
  assert.deepEqual(sim.adapter.save(),before);assert.equal(result.hash,runSyncTest({...options(sim),checkDistance:2,frames}).hash);
});
test('async abort and determinism failure retain SDK metrics and restore original state',async()=>{
  const sim=simulation(),before=sim.adapter.save(),controller=new AbortController();let yields=0;
  const frames=Array.from({length:4},(_,tick)=>({tick,inputs:input(tick)}));
  await assert.rejects(runSyncTestAsync({...options(sim),frames,signal:controller.signal,yieldControl:()=>{
    if(++yields===2)controller.abort('user cancelled');
  }}),error=>{
    assert.equal(error.name,'AbortError');assert.match(error.message,/user cancelled/);
    assert.equal(error.syncTestMetrics.status,'failed');assert.equal(error.syncTestMetrics.checkedTicks,1);return true;
  });assert.deepEqual(sim.adapter.save(),before);
  const bad=simulation({omitRng:true}),initial=bad.adapter.save();
  await assert.rejects(runSyncTestAsync({...options(bad),frames,yieldControl:()=>{}}),error=>{
    assert.ok(error instanceof DeterminismError);assert.equal(error.syncTestMetrics.failure.firstDifference,4);return true;
  });assert.deepEqual(bad.adapter.save(),initial);
});

test('Synctest cost includes mandatory forward restore, even if restore throws',()=>{
  for(const failRestore of [false,true]){
    const sim=simulation();let clock=0,loads=0;const load=sim.adapter.load;
    sim.adapter.load=b=>{clock+=10;loads++;if(failRestore&&loads===2)throw Error('restore failed');load(b)};
    const session=createSyncTestSession({...options(sim),now:()=>clock});
    if(failRestore)assert.throws(()=>session.advance(input(0)),/restore failed/);else session.advance(input(0));
    assert.equal(session.metrics.resimulationCostMs,20);assert.equal(session.metrics.totalCostMs,20);
    assert.equal(session.metrics.status,failRestore?'failed':'running');
  }
});
