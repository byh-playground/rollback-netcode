import { MAX_TICK, runSimulationFrame, copyFrame } from './protocol.js';
import { StateHistory } from './core.js';
import { integer, bytes, equalBytes, hashBytes, compareIds } from './utilities.js';

/** A mismatch between the forward execution and a real load/resimulation. */
export class DeterminismError extends Error {
  constructor({ tick, checkpointTick, expected, actual, inputs }) {
    let offset=0;while(offset<Math.min(expected.length,actual.length)&&expected[offset]===actual[offset])offset++;
    super(`Determinism mismatch at state S[${tick}], first byte ${offset}, checkpoint S[${checkpointTick}]`);
    this.name='DeterminismError';this.code='determinism-mismatch';this.tick=tick;this.checkpointTick=checkpointTick;
    this.firstDifference=offset;this.expectedHash=hashBytes(expected);this.actualHash=hashBytes(actual);
    this.expectedState=expected.slice();this.actualState=actual.slice();
    this.inputs=inputs.map(frame=>({...copyFrame(frame),playerId:frame.playerId,predicted:false}));
  }
}

export function createSyncTestSession(options){return new SyncTestSession(options)}

/** Local determinism diagnostic; all players supply actual input. No transport or clock. */
export class SyncTestSession {
  constructor({adapter,players,inputSize,tickRate=60,initialTick=0,checkDistance=1,
    maxSnapshotBytes=4*1024*1024,maxHistoryBytes=64*1024*1024,
    now=()=>globalThis.performance?.now()??Date.now()}={}){
    if(!adapter||['save','load','step','validateSnapshot'].some(key=>typeof adapter[key]!=='function'))throw new TypeError('Simulation Adapter capabilities');
    if(!Array.isArray(players)||!players.length||players.length>8||players.some(id=>typeof id!=='string'||!id.length)||new Set(players).size!==players.length)throw new TypeError('fixed player roster');
    if(typeof now!=='function')throw new TypeError('diagnostic clock');
    this._now=now;this._cost={forwardCostMs:0,resimulationCostMs:0,totalCostMs:0};
    this.adapter=adapter;this.players=Object.freeze([...players].sort(compareIds));
    this.inputSize=integer(inputSize,'inputSize',1,1024);this.tickRate=integer(tickRate,'tickRate',1,240);
    this.checkDistance=integer(checkDistance,'checkDistance',1,256);this._tick=integer(initialTick,'initialTick',0,MAX_TICK);
    this.initialTick=this.tick;this.maxSnapshotBytes=integer(maxSnapshotBytes,'maxSnapshotBytes',1,64*1024*1024);
    integer(maxHistoryBytes,'maxHistoryBytes',1,0x7fffffff);
    this._history=new StateHistory(checkDistance+1,maxHistoryBytes);this._frames=new Map();
    this.failure=null;this.closed=false;this.resimulatedTicks=0;this.checkedTicks=0;
    const initial=this._save();
    if(initial.length*(checkDistance+1)>maxHistoryBytes)throw new RangeError('synctest history byte budget');
    if(adapter.validateSnapshot(initial.slice(),{tick:this.tick})!==true)throw new TypeError('initial snapshot validation');
    this._history.put({tick:this.tick,bytes:initial});
  }
  get tick(){return this._tick}
  get status(){return this.closed?'closed':this.failure?'failed':'running'}
  get metrics(){
    const error=this.failure;
    const failure=error?Object.freeze({name:error.name??'Error',message:String(error.message??error),
      code:error.code??null,tick:error.tick??null,checkpointTick:error.checkpointTick??null,
      firstDifference:error.firstDifference??null,expectedHash:error.expectedHash??null,actualHash:error.actualHash??null}):null;
    return Object.freeze({status:this.status,tick:this.tick,checkDistance:this.checkDistance,
      checkedTicks:this.checkedTicks,resimulatedTicks:this.resimulatedTicks,stateHash:this.closed?null:this.getStateHash()??null,
      historyBytes:this._history.byteLength,failure,...this._cost});
  }
  _save(){const value=bytes(this.adapter.save()).slice();if(!value.length||value.length>this.maxSnapshotBytes)throw new RangeError('snapshot size');return value}
  _inputs(inputs){
    if(!Array.isArray(inputs)||inputs.length!==this.players.length)throw new TypeError('all local player inputs required');
    const ordered=[...inputs].sort((a,b)=>compareIds(a.playerId,b.playerId));
    return ordered.map((frame,index)=>{
      if(frame.playerId!==this.players[index]||bytes(frame.input).length!==this.inputSize)throw new TypeError('player/inputSize');
      const commands=frame.commands??[];if(!Array.isArray(commands)||commands.length>256)throw new TypeError('commands');
      const sorted=[...commands].sort((a,b)=>a.sequence-b.sequence);let previous=0;
      for(const command of sorted){
        integer(command.sequence,'command sequence',1);if(command.sequence<=previous||command.executeTick!==this.tick)throw new TypeError('command ordering/executeTick');
        const payload=bytes(command.payload);if(!payload.length||payload.length>15360)throw new RangeError('command payload');previous=command.sequence;
      }
      return {...copyFrame({input:bytes(frame.input),commands:sorted}),playerId:frame.playerId,predicted:false};
    });
  }
  advance(inputs){
    if(this.closed)throw new Error('sync test closed');if(this.failure)throw this.failure;
    integer(this.tick+1,'tick limit',0,MAX_TICK);
    const frames=this._inputs(inputs),before=this._history.get(this.tick),frameTick=this.tick;
    let forward=before.bytes;const started=this._now();let replayStarted;
    try{
      runSimulationFrame(this.adapter,{tick:frameTick,tickRate:this.tickRate,inputs:frames,resimulating:false,synctesting:true});
      const next=this._save();this._history.put({tick:frameTick+1,bytes:next});forward=next;this._frames.set(frameTick,frames);this._tick++;
      replayStarted=this._now();this._cost.forwardCostMs+=Math.max(0,replayStarted-started);
      const from=Math.max(this.initialTick,this.tick-this.checkDistance);
      this.adapter.load(this._history.get(from).bytes.slice());
      for(let tick=from;tick<this.tick;tick++){
        const input=this._frames.get(tick);
        runSimulationFrame(this.adapter,{tick,tickRate:this.tickRate,inputs:input,resimulating:true,synctesting:true});
        const actual=this._save(),expected=this._history.get(tick+1).bytes;this.resimulatedTicks++;
        if(!equalBytes(actual,expected))throw new DeterminismError({tick:tick+1,checkpointTick:from,expected,actual,inputs:input});
      }
      this.checkedTicks++;for(const tick of this._frames.keys())if(tick<from)this._frames.delete(tick);
    }catch(error){this.failure=error;throw error}
    finally{
      // Restore the forward snapshot even after a partial diagnostic replay.
      try{this.adapter.load(forward.slice())}catch(error){if(this.failure)this.failure.restoreError=error;else{this.failure=error;throw error}}
      finally{
        const finished=this._now();
        if(replayStarted!==undefined)this._cost.resimulationCostMs+=Math.max(0,finished-replayStarted);
        else this._cost.forwardCostMs+=Math.max(0,finished-started);
        this._cost.totalCostMs+=Math.max(0,finished-started);
      }
    }
    return {tick:this.tick,checkedTicks:this.checkedTicks,resimulatedTicks:this.resimulatedTicks};
  }
  getStateHash(){const state=this._history.get(this.tick);if(!state)return undefined;if(state.hash===undefined)state.hash=hashBytes(state.bytes);return state.hash}
  close(){this.closed=true;this._frames.clear();this._history.slots.fill(undefined);this._history.byteLength=0}
}

function beginSyncTestBatch(frames,options){
  if(!Array.isArray(frames))throw new TypeError('frames');
  return {initial:bytes(options.adapter.save()).slice(),session:createSyncTestSession(options)};
}
function advanceSyncTestBatch(session,frame){
  if(frame.tick!==session.tick)throw new TypeError('non-contiguous test frames');
  session.advance(frame.inputs);
}
function syncTestBatchResult(session){
  return {tick:session.tick,checkedTicks:session.checkedTicks,resimulatedTicks:session.resimulatedTicks,hash:session.getStateHash(),metrics:session.metrics};
}
function syncTestBatchFailure(session,error){
  const failure=error instanceof Error?error:new Error(String(error));
  session.failure??=failure;failure.syncTestMetrics=session.metrics;return failure;
}
function checkSyncTestAbort(signal){
  if(signal?.aborted){
    if(signal.reason instanceof Error)throw signal.reason;
    const error=new Error(signal.reason===undefined?'Synctest aborted':String(signal.reason));error.name='AbortError';throw error;
  }
}

/** Batch check. Restores the caller's initial serialized state on completion/failure. */
export function runSyncTest({frames,...options}={}){
  const {initial,session}=beginSyncTestBatch(frames,options);
  try{
    for(const frame of frames)advanceSyncTestBatch(session,frame);
    return syncTestBatchResult(session);
  }catch(error){throw syncTestBatchFailure(session,error)}
  finally{session.close();options.adapter.load(initial)}
}

/** Cooperative batch check using the same session and frame boundary as the synchronous API. */
export async function runSyncTestAsync({frames,yieldControl=()=>new Promise(resolve=>setTimeout(resolve,0)),signal,...options}={}){
  if(typeof yieldControl!=='function')throw new TypeError('yieldControl');
  const {initial,session}=beginSyncTestBatch(frames,options);
  try{
    checkSyncTestAbort(signal);
    for(const frame of frames){
      await yieldControl();checkSyncTestAbort(signal);
      advanceSyncTestBatch(session,frame);
      await yieldControl();checkSyncTestAbort(signal);
    }
    return syncTestBatchResult(session);
  }catch(error){throw syncTestBatchFailure(session,error)}
  finally{session.close();options.adapter.load(initial)}
}
