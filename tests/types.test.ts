import {createSession,createSyncTestSession,profiles,SimulationAdapter,SessionEvent,Transport,createNostrRoom} from '../rollback-netcode.js';
const adapter:SimulationAdapter={save:()=>new Uint8Array(8),load:()=>{},step:context=>context.tick,validateSnapshot:()=>true};
const event=(value:SessionEvent)=>{if(value.type==='peer-timeout')value.silenceMs;if(value.type==='desync-unrecoverable')value.attempts};
const transport:Transport={send:()=>true,subscribe:()=>()=>{}};
const session=createSession({players:['a','b'],localPlayerId:'a',sessionId:'types',simulationVersion:'1',inputSize:1,adapter,profile:profiles.rts,onEvent:event});
session.attachTransport('b',transport);session.advance(new Uint8Array(1));session.getPeerState('b')?.ackTick;
// @ts-expect-error logical ticks belong to the Core
session.tick=4;
// @ts-expect-error renderer is not an Adapter capability
createSession({players:['a'],localPlayerId:'a',sessionId:'bad',simulationVersion:'1',inputSize:1,adapter:{render(){}}});
createSyncTestSession({players:['a'],inputSize:1,adapter}).advance([{playerId:'a',input:new Uint8Array(1)}]);
createSession({players:['a'],localPlayerId:'a',sessionId:'prediction',simulationVersion:'1',inputSize:1,adapter,
  profile:{predictionPolicy:({previousInput,lastConfirmedTick})=>lastConfirmedTick>=0?previousInput:new Uint8Array(1)}});
createNostrRoom({role:'host'}).then(room=>room.close());
