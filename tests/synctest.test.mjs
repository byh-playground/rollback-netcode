import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncTestSession,runSyncTest,DeterminismError,SeededPRNG} from '../rollback-netcode.js';

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
