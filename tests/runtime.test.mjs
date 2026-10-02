import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession,profiles,WebRTCTransport,playReplay,hashBytes} from '../rollback-netcode.js';

function world(accept=true){
  const state=new Uint32Array(3),seen=[];
  return {state,seen,adapter:{save:()=>new Uint8Array(state.buffer),load:data=>new Uint8Array(state.buffer).set(data),validateSnapshot:()=>accept,
    step({tick,inputs}){assert.equal(tick,state[0]);state[0]++;for(const f of inputs){state[1]+=f.input[0];for(const c of f.commands){state[2]+=c.payload[0]}}
      seen.push({tick,inputs:structuredClone(inputs)})}}};
}
function pair({profile={},accept=true,version='v1',delay=0}={}){
  const worlds=[world(),world(accept)],events=[[],[]],queue=[],receivers=[],statuses=[];let time=0,enabled=true,sendEnabled=true,delayMs=delay;
  const sessions=worlds.map((w,i)=>createSession({players:['a','b'],localPlayerId:i?'b':'a',sessionId:'runtime',simulationVersion:i?version:'v1',inputSize:1,adapter:w.adapter,
    clock:()=>time,onEvent:e=>events[i].push(e),profile:{...profiles.action,baseInputDelayTicks:0,adaptiveInputDelay:false,pacingPolicy:'none',checksumInterval:4,...profile}}));
  sessions.forEach((s,i)=>s.attachTransport(i?'a':'b',{send:data=>{if(!sendEnabled)return false;queue.push({to:1-i,data:data.slice(),at:time+delayMs});return true},
    subscribe:handler=>{receivers[i]=handler;return()=>receivers[i]=null},subscribeStatus:handler=>{statuses[i]=handler;return()=>statuses[i]=null}}));
  const pump=(ms=50)=>{time+=ms;sessions.forEach(s=>s.poll());if(enabled){const due=queue.filter(x=>x.at<=time);for(let i=queue.length-1;i>=0;i--)if(queue[i].at<=time)queue.splice(i,1);for(const p of due)receivers[p.to]?.(p.data)}};
  for(let i=0;i<8;i++)pump();
  return {sessions,worlds,events,pump,queue,statuses,setDelivery:v=>enabled=v,setSend:v=>sendEnabled=v,setDelay:v=>delayMs=v,
    drive(ticks){for(let n=0;n<ticks;n++){sessions.forEach(s=>s.advance(new Uint8Array(1)));pump()}},close(){sessions.forEach(s=>s.close())}};
}
test('silence transitions interrupt -> timeout once, rejects invalid/replayed keepalives, resumes with valid traffic',()=>{
  const p=pair({profile:{peerInterruptMs:300,peerTimeoutMs:800}});
  try{
    p.drive(8);assert.ok(p.sessions.every(s=>s.ready));
    const old=p.queue.findLast(packet=>packet.to===0);assert.ok(old);
    p.sessions[0].receive('b',old.data);const lastReceived=p.sessions[0].getPeerState('b').lastReceivedAt;
    p.setDelivery(false);p.pump(350);
    assert.equal(p.sessions[0].status,'interrupted');const before=p.sessions[0].tick;
    assert.equal(p.sessions[0].advance(new Uint8Array([1])).status,'interrupted');assert.equal(p.sessions[0].tick,before);
    for(let i=0;i<8;i++){
      p.sessions[0].receive('b',new Uint8Array([1,2,3]));
      p.sessions[0].receive('b',old.data);
      assert.equal(p.sessions[0].getPeerState('b').lastReceivedAt,lastReceived);
      p.pump(100);
    }
    assert.equal(p.sessions[0].status,'disconnected');assert.equal(p.events[0].filter(e=>e.type==='peer-timeout').length,1);
    p.setDelivery(true);for(let i=0;i<10;i++)p.pump();
    assert.equal(p.sessions[0].status,'running');assert.ok(p.events[0].some(e=>e.type==='peer-resumed'));assert.equal(p.sessions[0].failure,null);
  }finally{p.close()}
});
test('backpressure alone does not mean disconnect, while transport close is immediate and observable',()=>{
  const p=pair();try{
    p.setSend(false);p.pump(100);assert.equal(p.sessions[0].status,'running');
    p.statuses[0]('closed');assert.equal(p.sessions[0].status,'disconnected');
    assert.equal(p.events[0].at(-1).type,'peer-disconnected');assert.equal(p.sessions[0].advance(new Uint8Array(1)).status,'disconnected');
    p.statuses[0]('open');p.setSend(true);for(let i=0;i<10;i++)p.pump();assert.ok(p.sessions[0].ready);
  }finally{p.close()}
});
test('failed recovery attempts enter a single terminal state and preserve the current snapshot',()=>{
  const p=pair({accept:false,profile:{maxRecoveryAttempts:2}});try{
    p.drive(12);for(let i=0;i<8;i++)p.pump();
    const guest=p.sessions[1],before=p.worlds[1].adapter.save().slice(),tick=guest.tick;
    for(let attempt=0;attempt<2;attempt++){
      assert.equal(guest.requestResync(Math.min(guest.tick,guest.confirmedTick+1)),true);
      assert.equal(guest.advance(new Uint8Array(1)).status,'recovering');
      for(let i=0;i<8;i++)p.pump();
    }
    assert.equal(guest.status,'failed');assert.equal(guest.failure.type,'desync-unrecoverable');assert.equal(guest.failure.attempts,2);
    assert.equal(guest.advance(new Uint8Array(1)).status,'failed');assert.equal(guest.tick,tick);assert.deepEqual(p.worlds[1].adapter.save(),before);
    for(let i=0;i<8;i++)p.pump();assert.equal(p.events[1].filter(e=>e.type==='desync-unrecoverable').length,1);
  }finally{p.close()}
});
test('handshake exposes a version mismatch independently of packet parsing errors',()=>{
  const p=pair({version:'other'});try{
    assert.equal(p.sessions[0].status,'failed');const event=p.events[0].find(e=>e.type==='version-mismatch');
    assert.deepEqual(event.fields,['simulationVersion']);assert.deepEqual(event.mismatches,[{field:'simulationVersion',expected:'v1',received:'other'}]);
    assert.equal(p.sessions[0].tick,0);
  }finally{p.close()}
});
test('an unanswered final recovery request emits an unrecoverable timeout without advancing',()=>{
  const p=pair({profile:{maxRecoveryAttempts:1,recoveryTimeoutMs:200}});try{
    p.drive(5);for(let i=0;i<4;i++)p.pump();p.setDelivery(false);
    const guest=p.sessions[1],tick=guest.tick,before=p.worlds[1].adapter.save().slice();
    assert.equal(guest.requestResync(Math.min(tick,guest.confirmedTick+1)),true);p.pump(250);
    assert.equal(guest.status,'failed');assert.equal(guest.failure.reason,'timeout');assert.equal(guest.tick,tick);
    assert.deepEqual(p.worlds[1].adapter.save(),before);assert.equal(p.events[1].filter(e=>e.type==='desync-unrecoverable').length,1);
  }finally{p.close()}
});
test('delay decrease preserves a single-frame press/release and a command without retiming commits',()=>{
  const w=world(),s=createSession({players:['a'],localPlayerId:'a',sessionId:'delay',simulationVersion:'1',inputSize:1,adapter:w.adapter,
    profile:{...profiles.action,baseInputDelayTicks:4,adaptiveInputDelay:false,pacingPolicy:'none'}});
  s.advance(new Uint8Array([0]));s.setInputDelay(0);assert.equal(s.inputDelay,4);assert.equal(s.requestedInputDelay,0);
  const sequence=s.queueCommand(new Uint8Array([7]));s.advance(new Uint8Array([1]));s.advance(new Uint8Array([0]));
  for(let i=0;i<15;i++)s.advance(new Uint8Array([0]));
  assert.equal(w.state[1],1);assert.equal(w.state[2],7);assert.equal(s.inputDelay,0);
  const frames=s.exportReplay().frames,commands=frames.flatMap(f=>f.inputs[0].commands);
  assert.equal(commands.length,1);assert.equal(commands[0].sequence,sequence);assert.equal(commands[0].executeTick,5);
  const replayWorld=world();assert.equal(playReplay({adapter:replayWorld.adapter,replay:s.exportReplay()}).hash,s.getStateHash());s.close();
});
test('measured delay can rise by several ticks in one adaptation interval',()=>{
  const p=pair({profile:{adaptiveInputDelay:true,adaptationIntervalMs:1000,maxInputDelayTicks:20},delay:150});
  try{
    let largestJump=0;for(let i=0;i<70;i++){p.drive(1);for(const e of p.events[0])if(e.type==='input-delay')largestJump=Math.max(largestJump,e.value-e.previous)}
    assert.ok(largestJump>1);assert.ok(p.sessions[0].inputDelay<=20);
  }finally{p.close()}
});
test('state hashes are lazy and cached; reused adapter buffers remain isolated; replay survives ring eviction',()=>{
  const w=world(),s=createSession({players:['a'],localPlayerId:'a',sessionId:'lazy',simulationVersion:'1',inputSize:1,adapter:w.adapter,
    profile:{...profiles.rts,baseInputDelayTicks:0,adaptiveInputDelay:false},recordReplay:true});
  for(let i=0;i<100;i++)s.advance(new Uint8Array([1]));
  assert.equal(s.metrics.stateHashComputations,1);const replay=s.exportReplay();assert.equal(s.metrics.stateHashComputations,2);
  assert.equal(s.getStateHash(),replay.hash);assert.equal(s.metrics.stateHashComputations,2);
  const original=s.getStateHash();w.state[1]++;assert.equal(s.getStateHash(),original);
  assert.equal(s.metrics.retainedSnapshotBytes,32*12);assert.equal(s.getStateHash(0),undefined);
  assert.equal(playReplay({adapter:world().adapter,replay}).hash,replay.hash);s.close();
});
test('a supported-looking command that cannot fit its input frame is rejected instead of queuing forever',()=>{
  const w=world(),s=createSession({players:['a'],localPlayerId:'a',sessionId:'capacity',simulationVersion:'1',inputSize:1024,adapter:w.adapter,
    profile:{...profiles.rts,maxCommandBytes:15360}});
  assert.throws(()=>s.queueCommand(new Uint8Array(15000)),/capacity/);s.close();
});
test('WebRTC channel closure and native connection interruption reach the status capability',()=>{
  class Channel extends EventTarget{readyState='open';bufferedAmount=0;send(){}close(){this.readyState='closed';this.dispatchEvent(new Event('close'))}}
  const input=new Channel(),control=new Channel(),transport=new WebRTCTransport({inputChannel:input,controlChannel:control}),seen=[];
  transport.subscribeStatus(s=>seen.push(s));transport.setConnectionState('disconnected');assert.equal(transport.state,'interrupted');
  transport.setConnectionState('connected');assert.equal(transport.state,'open');control.close();assert.equal(transport.state,'closed');
  assert.deepEqual(seen,['interrupted','open','closed']);transport.close();assert.equal(input.readyState,'closed');
});
