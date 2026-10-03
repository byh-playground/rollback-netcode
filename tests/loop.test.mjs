import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoop} from '../src/loop.js';
function fixture(options={}){
  const events=[];let tick=0, clock=0;
  const session={inputSize:1,profile:{tickRate:20,maxCatchupSteps:5},metrics:{pace:1},closed:false,resimulating:false,
    poll(){events.push(['poll',clock]);if(this.resimulating)this.resimulating=false},
    advance(input){events.push(['advance',clock,input[0]]);return{status:'advanced',tick:++tick}},releaseInput(){events.push(['release'])}};
  const loop=createLoop({session,getInput:()=>new Uint8Array([7]),beforeFrame:timestamp=>{clock=timestamp;events.push(['before',timestamp])},
    render:ctx=>events.push(['render',ctx.alpha]),...options});
  return{session,loop,events,get tick(){return tick}};
}
test('manual loop updates clock before polling, respects each terminal step and continues recovery/render on holds',()=>{
  let allowed=true;const f=fixture({canAdvance:()=>allowed,onAdvance:()=>{allowed=false}});
  f.loop.pulse(0);f.loop.pulse(250);assert.equal(f.tick,1);
  assert.deepEqual(f.events.slice(0,2),[['before',0],['poll',0]]);
  assert.equal(f.events.filter(e=>e[0]==='advance')[0][1],250);
  f.session.resimulating=true;f.loop.pulse(500);assert.equal(f.session.resimulating,false);assert.equal(f.tick,1);
  assert.equal(f.events.filter(e=>e[0]==='render').length,3);
  allowed=true;f.loop.resetTiming();f.loop.pulse(1000);assert.equal(f.tick,1);f.loop.pulse(1050);assert.equal(f.tick,2);
});
test('loop executes due fixed ticks and caps accumulated wall-clock catchup',()=>{
  const f=fixture();
  f.loop.pulse(0);f.loop.pulse(250);assert.equal(f.tick,5);
  f.loop.pulse(300);assert.equal(f.tick,6);
  f.loop.pulse(10000);assert.equal(f.tick,11);
});
test('automatic RAF start/stop is idempotent and errors stop scheduling',()=>{
  const callbacks=new Map();let next=0,cancelled=0,error;
  const f=fixture({requestFrame:callback=>{callbacks.set(++next,callback);return next},cancelFrame:id=>{callbacks.delete(id);cancelled++},onError:e=>{error=e}});
  f.loop.start();f.loop.start();assert.equal(callbacks.size,1);callbacks.get(1)(0);assert.equal(f.loop.running,true);
  callbacks.get(2)(NaN);assert.equal(f.loop.running,false);assert.match(error.message,/timestamp/);assert.equal(cancelled,1);
  const manual=fixture();assert.throws(()=>manual.loop.start(),/frame scheduler/);
});
test('loop rejects invalid callbacks',()=>{
  const f=fixture();
  assert.throws(()=>createLoop({session:f.session,canAdvance:false}),/callback/);
});
