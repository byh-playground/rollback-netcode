/** 브라우저 단일 ES 모듈의 공개 계약. 구현 규칙의 SSOT는 CONTRACT.md. */
export type Bytes = Uint8Array | ArrayBuffer | ArrayBufferView;
export type PlayerId = string;
export interface Command { sequence: number; executeTick: number; payload: Uint8Array; }
export interface PlayerInput { playerId: PlayerId; input: Uint8Array; commands: Command[]; predicted: boolean; }
export interface StepContext {
  tick: number; tickRate: number; inputs: PlayerInput[]; resimulating: boolean;
  recovering?: boolean; replaying?: boolean; synctesting?: boolean;
}
export interface SimulationAdapter {
  /** 반환 버퍼를 재사용해도 된다. Core는 보관 전에 복사한다. */
  save(): Bytes;
  load(snapshot: Uint8Array): void;
  step(context: StepContext): unknown;
  /** 현재 simulation을 변경하지 않는 후보 검증. */
  validateSnapshot(snapshot: Uint8Array, context: { tick: number }): boolean;
}
export type TransportState = 'connecting' | 'open' | 'interrupted' | 'closed' | 'failed';
export interface Transport {
  /** false는 backpressure 등으로 이번 송신을 받지 않았다는 뜻이다. */
  send(data: Uint8Array): boolean | void;
  subscribe(listener: (data: Uint8Array) => void): () => void;
  subscribeStatus?(listener: (state: TransportState) => void): () => void;
  readonly state?: TransportState;
  readonly bufferedAmount?: number;
  close?(): void;
}
export type PredictionPolicy = 'hold' | 'neutral' | ((context: { playerId: PlayerId; tick: number; previousInput: Uint8Array; lastConfirmedTick: number }) => Bytes);
export interface Profile {
  tickRate: number; baseInputDelayTicks: number; minInputDelayTicks: number; maxInputDelayTicks: number;
  rollbackWindowTicks: number; stateHistorySize: number; predictionPolicy: PredictionPolicy; stallPolicy: 'wait';
  tickDriftThreshold: number; pacingPolicy: 'none' | 'hold' | 'dilation'; checksumInterval: number;
  maxCatchupSteps: number; adaptiveInputDelay: boolean;
  heartbeatMs: number; adaptationIntervalMs: number; peerInterruptMs: number; peerTimeoutMs: number;
  maxSnapshotBytes: number; maxHistoryBytes: number; maxReplayBytes: number;
  maxCommandBytes: number; maxPendingCommands: number; maxQueuedBytes: number;
  recoveryTimeoutMs: number; maxRecoveryAttempts: number;
}
export const VERSION: string;
export const PROTOCOL_VERSION: number;
export const CHUNK_SIZE: number;
export const MAX_TICK: number;
export const profiles: Readonly<Record<'action' | 'rts' | 'lockstep', Readonly<Profile>>>;
export type SessionStatus = 'synchronizing' | 'running' | 'interrupted' | 'disconnected' | 'recovering' | 'resimulating' | 'failed' | 'closed';
export type PeerConnectionState = 'connecting' | 'connected' | 'interrupted' | 'disconnected';
export interface PeerState {
  peerId: PlayerId; state: PeerConnectionState; handshakeComplete: boolean; lastReceivedAt: number;
  simTick: number; confirmedInputTick: number; ackTick: number; rtt: number; jitter: number;
}
export interface SessionFailure {
  type: 'fatal' | 'desync-unrecoverable' | 'version-mismatch' | 'handshake-mismatch';
  error?: unknown; reason?: string; attempts?: number; authorityPlayerId?: PlayerId; peerId?: PlayerId;
  fields?: readonly string[]; mismatches?: readonly { field: string; expected: unknown; received: unknown }[];
}
export type SessionEvent = { tick: number } & (
  | SessionFailure
  | { type: 'version-mismatch'; peerId: PlayerId; field: 'protocol'; expected: number; received: number }
  | { type: 'peer-ready'; peerId: PlayerId }
  | { type: 'peer-interrupted' | 'peer-disconnected' | 'peer-timeout' | 'peer-resumed'; peerId: PlayerId; previous: PeerConnectionState; state: PeerConnectionState; reason?: string; silenceMs?: number }
  | { type: 'input-delay'; previous: number; value: number }
  | { type: 'input-release'; executeTick: number }
  | { type: 'rollback' | 'recovered'; from: number; target: number }
  | { type: 'desync' | 'input-history-mismatch'; peerId: PlayerId; at: number }
  | { type: 'recovery-rejected'; reason: string }
  | { type: 'protocol-error' | 'transport-error'; peerId: PlayerId; error: unknown }
  | { type: 'history-exhausted'; inputTick: number }
  | { type: 'recovery-backpressure'; peerId: PlayerId }
  | { type: 'recovery-timeout' | 'replay-capacity' | 'closed' }
);
export interface SessionOptions {
  players: PlayerId[]; localPlayerId: PlayerId; sessionId: string; simulationVersion: string;
  seed?: number; inputSize: number; profile?: Partial<Profile>; adapter: SimulationAdapter;
  authorityPlayerId?: PlayerId; onEvent?: (event: SessionEvent) => void; recordReplay?: boolean; clock?: () => number;
}
export interface SessionMetrics {
  rollbacks: number; resimulatedTicks: number; maxRollbackDepth: number; stalls: number; holds: number;
  recoveries: number; rejectedSnapshots: number; rejectedPackets: number; sentBytes: number; receivedBytes: number;
  predictedTicks: number; hashMismatches: number; latestResimulationMs: number; smoothedRTT: number; jitter: number;
  lateInputRate: number; rollbackFrequency: number; stallFrequency: number; resimulationCostMs: number;
  stateHashComputations: number; hashedStateBytes: number; retainedSnapshotBytes: number;
  inputDelay: number; requestedInputDelay: number; confirmedTick: number; tick: number; pace: number;
}
export interface Replay {
  version: string; simulationVersion: string; seed: number; players: PlayerId[]; inputSize: number; tickRate: number;
  initialState: Uint8Array; frames: { tick: number; inputs: PlayerInput[] }[]; tick: number; hash: number; truncated: boolean;
}
export interface AdvanceResult { status: 'advanced' | 'held' | 'stalled' | 'synchronizing' | 'resimulating' | 'recovering' | 'interrupted' | 'disconnected' | 'failed'; tick: number; failure?: Readonly<SessionFailure> | null; }
export class RollbackSession {
  constructor(options: SessionOptions);
  readonly tick: number; readonly inputDelay: number; readonly requestedInputDelay: number; readonly confirmedTick: number;
  readonly ready: boolean; readonly resimulating: boolean; readonly closed: boolean; readonly status: SessionStatus;
  readonly failure: Readonly<SessionFailure> | null; readonly metrics: SessionMetrics; readonly profile: Readonly<Profile>;
  readonly players: readonly PlayerId[]; readonly localPlayerId: PlayerId; readonly inputSize: number; readonly authorityPlayerId: PlayerId;
  attachTransport(peerId: PlayerId, transport: Transport): () => void;
  receive(peerId: PlayerId, data: Bytes, now?: number): boolean;
  poll(now?: number): void;
  advance(input?: Bytes): AdvanceResult;
  queueCommand(payload: Bytes): number;
  /** 증가 즉시 적용. 감소는 동일 샘플에 한 틱씩 적용하며 requestedInputDelay로 목표를 조회한다. */
  setInputDelay(ticks: number): void;
  releaseInput(): void;
  requestResync(tick: number): boolean;
  getStateHash(tick?: number): number | undefined;
  getPeerState(peerId: PlayerId): Readonly<PeerState> | undefined;
  exportReplay(): Replay;
  exportSyncTestFrames(options?: { maxFrames?: number }): { initialState: Uint8Array; players: PlayerId[]; inputSize: number; tickRate: number; initialTick: 0; frames: { tick: number; inputs: PlayerInput[] }[] };
  close(): void;
}
export function createSession(options: SessionOptions): RollbackSession;
export function playReplay(options: { adapter: SimulationAdapter; replay: Replay; simulationVersion?: string }): { tick: number; hash: number };
export interface SyncTestOptions {
  adapter: SimulationAdapter; players: PlayerId[]; inputSize: number; tickRate?: number; initialTick?: number;
  checkDistance?: number; maxSnapshotBytes?: number; maxHistoryBytes?: number; now?: () => number;
}
export interface SyncTestMetrics {
  readonly status: 'running' | 'failed' | 'closed'; readonly tick: number; readonly checkDistance: number;
  readonly checkedTicks: number; readonly resimulatedTicks: number; readonly stateHash: number | null; readonly historyBytes: number;
  readonly forwardCostMs: number; readonly resimulationCostMs: number; readonly totalCostMs: number;
  readonly failure: Readonly<{ name: string; message: string; code: string | null; tick: number | null;
    checkpointTick: number | null; firstDifference: number | null; expectedHash: number | null; actualHash: number | null }> | null;
}
export type LocalTestInput = { playerId: PlayerId; input: Uint8Array; commands?: Command[] };
export class DeterminismError extends Error {
  constructor(detail: { tick: number; checkpointTick: number; expected: Uint8Array; actual: Uint8Array; inputs: PlayerInput[] });
  readonly syncTestMetrics?: SyncTestMetrics; readonly code: 'determinism-mismatch'; readonly tick: number; readonly checkpointTick: number; readonly firstDifference: number;
  readonly expectedHash: number; readonly actualHash: number; readonly expectedState: Uint8Array; readonly actualState: Uint8Array; readonly inputs: PlayerInput[];
}
export class SyncTestSession {
  constructor(options: SyncTestOptions);
  readonly tick: number; readonly status: 'running' | 'failed' | 'closed'; readonly failure: unknown;
  readonly checkedTicks: number; readonly resimulatedTicks: number; readonly metrics: SyncTestMetrics;
  advance(inputs: LocalTestInput[]): { tick: number; checkedTicks: number; resimulatedTicks: number };
  getStateHash(): number | undefined;
  close(): void;
}
export function createSyncTestSession(options: SyncTestOptions): SyncTestSession;
export function runSyncTest(options: SyncTestOptions & { frames: { tick: number; inputs: LocalTestInput[] }[] }): { tick: number; checkedTicks: number; resimulatedTicks: number; hash: number; metrics: SyncTestMetrics };
export function runSyncTestAsync(options: SyncTestOptions & { frames: { tick: number; inputs: LocalTestInput[] }[]; yieldControl?: () => void | Promise<void>; signal?: AbortSignal }): Promise<{ tick: number; checkedTicks: number; resimulatedTicks: number; hash: number; metrics: SyncTestMetrics }>;
export class SeededPRNG { constructor(seed?: number); state: number; nextUint32(): number; nextInt(bound: number): number; }
export function statelessRandom(seed: number, eventId: number): number;
export function hashBytes(value: Bytes, seed?: number): number;
export const fixedPoint: Readonly<{ scale: number; fromNumber(x: number): number; toNumber(x: number): number; add(a: number,b: number): number; sub(a: number,b: number): number; mul(a: number,b: number): number; div(a: number,b: number): number }>;
export class WebRTCTransport implements Transport {
  constructor(options: { inputChannel?: RTCDataChannel; controlChannel: RTCDataChannel; highWaterMark?: number; lowWaterMark?: number });
  readonly state: TransportState; readonly bufferedAmount: number; readonly closed: boolean;
  send(data: Uint8Array): boolean; subscribe(listener: (data: Uint8Array) => void): () => void;
  subscribeStatus(listener: (state: TransportState) => void): () => void;
  setConnectionState(state: RTCPeerConnectionState): void; close(): void;
}
export interface SignalingMessage { type: 'discover' | 'presence' | 'offer' | 'answer' | 'ice' | 'bye' | 'group'; [key: string]: unknown; }
export interface SignalEnvelope { from: string; to: string; message: SignalingMessage; }
export interface Signaler { readonly id: string; send(to: string,message: SignalingMessage): Promise<void>; subscribe(listener: (event: SignalEnvelope) => unknown): () => void; close(): void; }
export interface ConnectionStatus { type: string; state?: string; status?: string; error?: unknown; room?: string; role?: string; relay?: string; message?: string; }
export interface NostrOptions {
  room: string; namespace?: string; relays?: string[]; timeoutMs?: number; onStatus?: (status: ConnectionStatus) => void;
  WebSocketImpl?: typeof WebSocket; cryptoImpl?: Crypto; signal?: AbortSignal; publishIntervalMs?: number;
  maxVerificationsPerSecond?: number; verificationBurst?: number;
}
export interface NostrSignaler extends Signaler { readonly room: string; readonly metrics: { attempted: number; verified: number; throttled: number; totalVerificationMs: number; maxVerificationMs: number }; }
export function createNostrSignaler(options: NostrOptions): Promise<NostrSignaler>;
export const nostrCrypto: Readonly<{ publicKey(secret: Uint8Array): Uint8Array; sign(message: Uint8Array,secret: Uint8Array,auxiliary: Uint8Array): Promise<Uint8Array>; verify(signature: Uint8Array,message: Uint8Array,publicKey: Uint8Array): Promise<boolean> }>;
export interface PeerOptions { initiator?: boolean; signaler: Signaler; remoteId: string; rtcConfig?: RTCConfiguration; timeoutMs?: number; RTCPeerConnectionImpl?: typeof RTCPeerConnection; onStatus?: (status: ConnectionStatus) => void; signal?: AbortSignal; }
export interface PeerConnection { transport: WebRTCTransport; peerConnection: RTCPeerConnection; close(): void; }
export function createWebRTCPeer(options: PeerOptions): Promise<PeerConnection>;
export interface RoomOptions { role: 'host' | 'join'; room?: string; namespace?: string; relays?: string[]; rtcConfig?: RTCConfiguration; timeoutMs?: number; onStatus?: (status: ConnectionStatus) => void; signal?: AbortSignal; signalerFactory?: typeof createNostrSignaler; peerFactory?: typeof createWebRTCPeer; }
export function createNostrRoom(options: RoomOptions): Promise<PeerConnection & { room: string; sessionId: string; localPlayerId: string; remotePlayerId: string }>;
export type RoomTopology = 'mesh' | 'star';
export interface GroupRoomStatus extends ConnectionStatus {
  type: string; room?: string; role?: 'host' | 'join'; playerCount?: number; topology?: RoomTopology;
  phase?: string; players?: readonly PlayerId[]; localPlayerId?: PlayerId; peerId?: PlayerId;
  reason?: string; previousPhase?: string; event?: ConnectionStatus;
}
export interface GroupRoomOptions {
  role: 'host' | 'join'; room?: string; playerCount?: number; topology?: RoomTopology;
  namespace?: string; relays?: string[]; rtcConfig?: RTCConfiguration; timeoutMs?: number;
  onStatus?: (status: GroupRoomStatus) => void; signal?: AbortSignal;
  signalerFactory?: typeof createNostrSignaler; peerFactory?: typeof createWebRTCPeer;
}
export interface GroupRoom {
  readonly room: string; readonly sessionId: string; readonly playerCount: number; readonly topology: RoomTopology;
  readonly players: readonly PlayerId[]; readonly localPlayerId: PlayerId;
  readonly authorityPlayerId: PlayerId; readonly hostPlayerId: PlayerId;
  /** Logical remote peers, including relayed guest-to-guest routes in star topology. */
  readonly transports: ReadonlyMap<PlayerId, Transport>;
  /** Physical connections only: N-1 per mesh/host, one per star guest. */
  readonly peerConnections: ReadonlyMap<PlayerId, RTCPeerConnection>;
  readonly closed: boolean;
  readonly metrics: Readonly<{ sentFrames: number; forwardedFrames: number; rejectedFrames: number;
    queuedBytes: number; queuedFrames: number; assemblyBytes: number }> | null;
  close(): void;
}
export function createNostrGroupRoom(options: GroupRoomOptions): Promise<GroupRoom>;
export function createLoop(options: { session: RollbackSession; getInput?: () => Bytes; beforeFrame?: (timestamp: number) => void; canAdvance?: () => boolean; onAdvance?: (result: AdvanceResult) => void; render?: (context: { session: RollbackSession; alpha: number; resimulating: boolean }) => void; onError?: (error: unknown) => void; onInputRelease?: () => void; requestFrame?: (callback: FrameRequestCallback) => number; cancelFrame?: (handle: number) => void }): { start(): void; stop(): void; pulse(timestamp: number): void; resetTiming(): void; readonly running: boolean };
export type CodecValue = null | boolean | number | string | Uint8Array | CodecValue[] | { [key: string]: CodecValue };
export interface ValueCodec { readonly format: 'binary' | 'json'; encode(value: CodecValue): Uint8Array; decode(bytes: Bytes): CodecValue; }
export function createValueCodec(options?: { format?: 'binary' | 'json'; maxBytes?: number; maxDepth?: number; maxEntries?: number }): ValueCodec;
export const binaryCodec: ValueCodec;
export const jsonCodec: ValueCodec;
