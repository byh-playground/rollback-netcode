import { createNostrGroupRoom, createNostrSignaler, createWebRTCPeer, createSession, createLoop, profiles, playReplay } from '../rollback-netcode.js';
const $=id=>document.getElementById(id),sleep=ms=>new Promise(r=>setTimeout(r,ms));
class LocalRelay extends EventTarget {
  static sockets=new Set();
  constructor(){super();this.readyState=0;this.filter=null;LocalRelay.sockets.add(this);queueMicrotask(()=>{if(this.readyState!==0)return;this.readyState=1;this.dispatchEvent(new Event('open'));});}
  deliver(value){if(this.readyState===1)this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  send(text){const [type,...args]=JSON.parse(text);if(type==='REQ'){this.subscription=args[0];this.filter=args[1];queueMicrotask(()=>this.deliver(['EOSE',this.subscription]));}
    if(type==='EVENT'){const event=args[0];queueMicrotask(()=>{this.deliver(['OK',event.id,true,'']);for(const socket of LocalRelay.sockets){if(socket.filter?.['#d']?.includes(event.tags.find(t=>t[0]==='d')?.[1]))socket.deliver(['EVENT',socket.subscription,event]);}});}}
  close(){if(this.readyState===3)return;this.readyState=3;LocalRelay.sockets.delete(this);this.dispatchEvent(new Event('close'));}
}
let active,rows=[];
function adapter(n){let state=new Int32Array(4200),faultTick=-1;return {
  adapter:{save:()=>new Uint8Array(state.buffer.slice(0)),load:b=>{state=new Int32Array(b.slice().buffer)},validateSnapshot:(b,{tick})=>b.length===16800&&new DataView(b.buffer,b.byteOffset,b.byteLength).getInt32(0,true)===tick,
    step({tick,inputs}){if(state[0]!==tick)throw Error('adapter tick');if(tick===faultTick)state[1]+=999;state[0]++;inputs.forEach((p,i)=>{state[i+1]+=p.input[0];state[n+1]+=p.commands.length;});}},
  corrupt(){faultTick=state[0]+10;},state:()=>state
};}
async function scenario(playerCount,topology,signal,publicRelay=false){
 let now=0,rooms=[],sessions=[],loops=[],corrupted=false,packetCounter=0;const events=[];const started=performance.now(),timers=new Set(),actors=Array.from({length:playerCount},()=>adapter(playerCount));
 const room=String(Math.floor(Math.random()*10000)).padStart(4,'0'),namespace='netcode-check-'+crypto.randomUUID();
 const peerFactory=async options=>{const p=await createWebRTCPeer({...options,rtcConfig:{iceServers:[]}}),raw=p.transport;let closed=false;const controls=[];
  const later=(fn,ms)=>{const h=setTimeout(()=>{timers.delete(h);fn()},ms);timers.add(h);};
  const flushControl=()=>{if(closed)return;while(controls.length){if(raw.send(controls[0])===false){if(raw.state==='open')later(flushControl,10);return;}controls.shift();}};
  return {...p,transport:{get state(){return raw.state},subscribe:fn=>raw.subscribe(fn),subscribeStatus:fn=>raw.subscribeStatus(fn),
    send(bytes){if(closed)return false;const count=++packetCounter;if(bytes[5]===2&&count%37===0)return true;const data=bytes.slice();
      // Reordering applies only to unordered input/clock. Control remains reliable and ordered.
      if(![2,3].includes(bytes[5])){const wasEmpty=controls.length===0;controls.push(data);if(wasEmpty)later(flushControl,30);return true;}
      const attempt=()=>{if(closed)return;if(raw.send(data)===false&&raw.state==='open'){const h=setTimeout(()=>{timers.delete(h);attempt()},10);timers.add(h)}};
      const h=setTimeout(()=>{timers.delete(h);attempt()},15+count*13%30);timers.add(h);return true;},close(){}},close(){closed=true;p.close();}};
 };
 try{
  const results=await Promise.allSettled(Array.from({length:playerCount},(_,i)=>createNostrGroupRoom({role:i?'join':'host',room,namespace,playerCount,topology,timeoutMs:90000,signal,peerFactory,
    signalerFactory:publicRelay?createNostrSignaler:options=>createNostrSignaler({...options,relays:['wss://test.invalid'],WebSocketImpl:LocalRelay,publishIntervalMs:0}),
    onStatus:e=>{if(e.type==='group-failed')$('status').textContent=e.reason;else if(e.type.startsWith('group-'))$('status').textContent=`${playerCount}인 ${topology} · ${e.type}`;}})));
  rooms=results.filter(r=>r.status==='fulfilled').map(r=>r.value);const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
  const connections=rooms.reduce((sum,r)=>sum+r.peerConnections.size,0),expected=topology==='mesh'?playerCount*(playerCount-1):2*(playerCount-1);
  if(connections!==expected)throw Error('physical topology mismatch');
  sessions=rooms.map((r,i)=>createSession({players:[...r.players],localPlayerId:r.localPlayerId,authorityPlayerId:r.authorityPlayerId,sessionId:r.sessionId,simulationVersion:'group-browser-v1',inputSize:1,adapter:actors[i].adapter,clock:()=>now,onEvent:e=>{if(['protocol-error','recovery-rejected','recovery-timeout','desync','input-history-mismatch','recovered','desync-unrecoverable'].includes(e.type)){events.push({i,...e,error:e.error?.message});if(events.length>80)events.shift();}},
    profile:{...profiles.action,adaptiveInputDelay:false,pacingPolicy:'none',checksumInterval:10,stateHistorySize:96}}));
  sessions.forEach((s,i)=>{for(const [id,t]of rooms[i].transports)s.attachTransport(id,t);s.queueCommand(new Uint8Array([i+1]));});
  loops=sessions.map((s,i)=>createLoop({session:s,canAdvance:()=>s.tick<240,getInput:()=>new Uint8Array([(Math.floor(s.tick/11)+i)%8])}));let maxWorkMs=0;
  for(let frame=0;frame<4000;frame++){
    if(signal.aborted)throw Error('cancelled');now=performance.now();
    if(!corrupted&&sessions.every(s=>s.tick>=70)){actors[1].corrupt();corrupted=true;}
    const before=performance.now();loops.forEach(loop=>loop.pulse(now));maxWorkMs=Math.max(maxWorkMs,performance.now()-before);
    if(sessions.some(s=>s.status==='failed'))throw Error('Core failed: '+JSON.stringify({failures:sessions.map(s=>s.failure),events,ticks:sessions.map(s=>s.tick)}));
    if(sessions.every(s=>s.tick===240&&s.confirmedTick>=239&&!s.resimulating))break;
    if(frame%60===0)$('status').textContent=`${playerCount}인 ${topology} · ticks ${sessions.map(s=>s.tick).join('/')}`;
    await sleep(8);
  }
  if(!sessions.every(s=>s.tick===240&&s.confirmedTick>=239))throw Error('convergence timeout');
  const hashes=sessions.map(s=>s.getStateHash());if(new Set(hashes).size!==1)throw Error('final state mismatch');
  const recoveries=sessions.reduce((n,s)=>n+s.metrics.recoveries,0),rollbacks=sessions.reduce((n,s)=>n+s.metrics.rollbacks,0);
  if(!corrupted||!recoveries||!rollbacks)throw Error('rollback/recovery scenario not exercised: '+JSON.stringify({corrupted,recoveries,rollbacks}));
  if(actors.some(a=>a.state()[playerCount+1]!==playerCount))throw Error('command duplicated/lost');
  const replay=sessions[0].exportReplay(),restored=playReplay({adapter:adapter(playerCount).adapter,replay});if(restored.hash!==replay.hash)throw Error('replay mismatch');
  let bytesSent=0;for(const r of rooms)for(const pc of r.peerConnections.values()){const stats=await pc.getStats();stats.forEach(row=>{if(row.type==='data-channel')bytesSent+=row.bytesSent||0;});}if(!bytesSent)throw Error('no real RTC traffic');
  return {playerCount,topology,signaling:publicRelay?'public Nostr relays':'local signed relay fixture',status:'PASS',physicalConnections:connections/2,tick:240,hash:hashes[0],rollbacks,recoveries,bytesSent,largestWorkMs:+maxWorkMs.toFixed(2),elapsedMs:Math.round(performance.now()-started)};
 }finally{loops.forEach(l=>l.stop());sessions.forEach(s=>s.close());rooms.forEach(r=>r.close());timers.forEach(clearTimeout);timers.clear();}
}
async function run(all){if(active)return;active=new AbortController();$('run').disabled=$('all').disabled=true;rows=[];
 try{const cases=all?['mesh','star'].flatMap(t=>[2,3,4,8].map(n=>[n,t])):[[Number($('count').value),$('topology').value]];
  for(const [n,t]of cases){const row=await scenario(n,t,active.signal,$('public-relay').checked);rows.push(row);$('result').textContent=JSON.stringify(rows,null,2);await sleep(100);}
  $('status').textContent='전체 선택 검사 통과';
 }catch(e){$('status').textContent='실패: '+e.message;$('result').textContent=JSON.stringify(rows,null,2)+'\n'+e.stack;}
 finally{active.abort();active=null;$('run').disabled=$('all').disabled=false;}
}
$('run').onclick=()=>run(false);$('all').onclick=()=>run(true);$('cancel').onclick=()=>active?.abort();
