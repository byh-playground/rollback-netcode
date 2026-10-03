# rollback-netcode

결정론적 P2P 입력 동기화·rollback·lockstep을 제공하는 브라우저 ES 모듈입니다. 소비자는 **JavaScript 파일 하나**를 import하며 npm·Node·번들러가 필요하지 않습니다.

현재 브랜치는 **0.2.0-dev 개발 후보**입니다. 공개 Pages는 main의 배포본을 제공하므로 후보 코드와 다를 수 있습니다. [검증 범위](docs/verification.md), [개발 계약 SSOT](CONTRACT.md), [공개 타입](rollback-netcode.d.ts)을 확인하세요.

## 한국어 예제 확인 순서

[예제 화면](https://byh-playground.github.io/rollback-netcode/)에서 **이 화면에서 두 컴퓨터 검증 → 시작**을 누릅니다. 실제 RTC 연결 두 개로 플레이어 A·B의 이동과 점수 명령을 비교할 수 있습니다. 리플레이 확인, 개발자 상세의 고의 오류/복구, 연결 없이 결정론 검사도 제공합니다. 서로 다른 기기는 방 만들기/방 참가와 같은 네 자리 번호를 사용합니다.

0.2의 결정론 검사와 새 상태 표시 기능은 이 후보가 배포된 뒤 공개 예제에서 사용할 수 있습니다. 로컬 후보 검사는 아래 개발 명령을 사용합니다.

## 가져오기와 버전 고정

```js
import { createSession, profiles, createLoop } from
  'https://byh-playground.github.io/rollback-netcode/rollback-netcode.js';
```

GitHub Pages는 GitHub 공식 정적 호스팅 기능입니다. 위 URL은 main 배포를 따라 바뀝니다. PR #1은 이미 main에 머지되었으며 이전 작업 브랜치를 배포 기준으로 사용하지 않습니다.

실제 게임은 검토한 JS를 애플리케이션에 고정하거나 콘텐츠 해시 경로를 사용하세요. 기여자는 `node scripts/stage-version.mjs`로 `versions/<SHA-256>/rollback-netcode.js`를 준비할 수 있습니다. 같은 경로는 같은 바이트만 허용하며 CI가 hash를 확인합니다. 해당 파일이 Pages 소스에 게시된 뒤 `https://byh-playground.github.io/rollback-netcode/versions/<SHA-256>/rollback-netcode.js`에서 import합니다. 준비 명령 자체는 푸시·게시를 하지 않으며 아직 생성·배포하지 않은 경로를 사용하면 안 됩니다.

연결하려는 참가자는 같은 라이브러리·프로토콜·simulationVersion·시드·플레이어 목록·TPS·초기 상태를 사용해야 합니다. 불일치 필드는 onEvent에서 확인할 수 있습니다.

## 게임 연결

아래의 gameAdapter, controls, render는 사용하는 게임이 제공합니다. Adapter 구현 규칙은 [개발 계약](CONTRACT.md#결정성determinism)을 따릅니다.

```js
const session = createSession({
  players: ['a', 'b'], localPlayerId: 'a', authorityPlayerId: 'a',
  sessionId: 'shared-match-id', simulationVersion: 'my-game-v1',
  seed: 42, inputSize: 1, profile: profiles.rts,
  adapter: gameAdapter,
  onEvent(event) {
    if (event.type === 'desync-unrecoverable') showRestartUI(event.reason);
    if (event.type === 'peer-timeout') showReconnectUI(event.peerId);
  }
});
session.attachTransport('b', transport);
const loop = createLoop({ session, getInput: () => controls.bytes(), render });
loop.start();
// 이동처럼 유지되는 조작은 input, 한 번 실행할 행동은 command로 제출합니다.
const sequence = session.queueCommand(new Uint8Array([1]));
```

Simulation Adapter는 `save(): bytes`, `load(bytes)`, `step(context)`, `validateSnapshot(bytes,{tick}): boolean`을 제공합니다. Core frame t는 step 이전 S[t]이며 step이 S[t+1]을 만듭니다. context에는 고정 tickRate, 정렬된 플레이어 입력과 command, resimulating/recovering/replaying 등의 실행 정보가 들어갑니다.

Transport는 `send(Uint8Array)`와 `subscribe(listener)` capability를 제공합니다. 선택적으로 state와 subscribeStatus를 제공하면 실제 연결 종료를 바로 전달할 수 있습니다. send(false)는 backpressure이며 Core가 재전송합니다. `WebRTCTransport`는 입력·제어 채널 분류와 backpressure를 담당합니다.

방 연결에는 `createNostrRoom({role:'host',namespace:'my-game',onStatus})`와 `createNostrRoom({role:'join',room:'1234',namespace:'my-game'})`을 사용할 수 있습니다. 생성 중 onStatus의 room 정보를 화면에 표시합니다. 반환된 sessionId/localPlayerId/remotePlayerId/transport로 Session을 연결하고 종료 시 room.close()를 호출합니다. AbortSignal로 진행 중인 연결을 취소할 수 있습니다.

Nostr는 방 발견과 SDP/ICE 전달에만 사용합니다. 자체 crypto는 임시 키를 이용한 Nostr 이벤트 서명·검증이며 내용은 공개 JSON입니다. 게임 데이터는 WebRTC로 전달하고 기본 전송 암호화는 브라우저가 담당합니다. 개발자 소유 서버·DB·기본 TURN fallback은 없습니다.

Nostr 서명 검증은 relay·발신 키에 관계없이 공유되는 수신 예산을 사용합니다. 기본 maxVerificationsPerSecond는 16, verificationBurst는 8이며 signaler.metrics에서 시도·성공·제한 횟수와 검증 경과 시간을 확인할 수 있습니다.

## Is-a / Has-a / Can-be

| 관계 | 사용 구조 |
| --- | --- |
| Is-a | Session은 입력 동기화 세션, Nostr 구현은 Signaling Adapter |
| Has-a | Session이 Simulation Adapter·Transport·History·Policy를 소유. 방 연결 조정자가 Signaler·RTC를 소유 |
| Can-be | 같은 Core가 Profile에 따라 lockstep/rollback으로 동작하고 Runtime 상황에 따라 interruption/recovery/failure 상태를 가짐 |

새 게임을 붙일 때 AI·물리·엔티티를 Core에 추가하지 않습니다. UI·AI는 같은 명령 입력을 제출하고 게임 Adapter가 실제 규칙을 실행합니다.

## Synctest: 연결 전에 상태 복원 검사

```js
import { createSyncTestSession, DeterminismError } from './rollback-netcode.js';
const check = createSyncTestSession({
  adapter: gameAdapter, players: ['a', 'b'], inputSize: 1,
  tickRate: 20, checkDistance: 4
});
check.advance([
  { playerId: 'a', input: new Uint8Array([1]), commands: [] },
  { playerId: 'b', input: new Uint8Array([0]), commands: [] }
]);
```

매 advance에서 정상 실행 후 최근 checkDistance 프레임을 load/재실행해 완전한 상태 바이트를 비교합니다. 네트워크가 없어도 RNG·timer·숨은 상태의 저장 누락을 찾을 수 있습니다. 불일치 시 DeterminismError의 tick, checkpointTick, firstDifference, expectedHash/actualHash, expectedState/actualState, inputs를 제공합니다. 실패 후에는 새 검사 세션을 만듭니다.

`runSyncTest({ ...options, frames:[{tick,inputs}] })`는 입력 묶음을 검사하고 호출 전의 직렬화 상태를 복원합니다. 검사도 실제 게임 Adapter를 사용하므로 UI·사운드 같은 외부 부수 효과를 실행하지 않는 진단 환경에서 사용하세요. Synctest는 결정론 버그를 탐지하지만 모든 입력·다른 엔진의 결정론을 보증하지는 않습니다.

## 상태와 이벤트

`session.status`는 synchronizing/running/interrupted/disconnected/recovering/resimulating/failed/closed입니다. `advance()`는 진행 시 advanced, 진행을 기다리면 held/stalled 등의 결과를 반환합니다. 끊김·복구 대기 중에도 poll과 렌더링은 계속할 수 있습니다. failed는 자동으로 다시 실행되지 않으며 failure에 원인이 남습니다.

| onEvent 종류 | 의미와 주요 필드 |
| --- | --- |
| peer-ready | handshake 완료 · peerId |
| peer-interrupted / peer-timeout / peer-disconnected | 무응답 또는 실제 Transport 종료 · peerId, reason/silenceMs |
| peer-resumed | 같은 연결 이력에서 유효한 새 traffic 복귀 |
| version-mismatch / handshake-mismatch | 호환성·초기 상태 차이 · fields/mismatches 또는 protocol expected/received |
| input-delay / input-release | 실제 지연 변경 previous/value, 해제 executeTick |
| rollback | prediction 수정 · from/target |
| desync / input-history-mismatch | 확정 상태 차이 또는 입력 이력 차이 · peerId/at |
| recovered / recovery-rejected / recovery-timeout | 과거 snapshot 복구 성공·후보 거부·시간 초과 |
| desync-unrecoverable | 연속 복구 시도 소진 · attempts/reason, 세션 failed |
| protocol-error / transport-error | 패킷 검증 또는 전송 예외 |
| history-exhausted / recovery-backpressure / replay-capacity | 이력·전송·기록 한도 도달 |
| fatal / closed | Adapter/실행 실패 또는 세션 종료 |

전체 이벤트에는 관찰 시점의 tick이 있습니다. `getPeerState(peerId)`로 연결 상태·마지막 수신·상대 simTick·confirmedInputTick·ackTick·RTT/jitter를 읽습니다. Snapshot 권위자는 기본 정렬된 첫 참가자이며 authorityPlayerId로 명시할 수 있습니다. 연결 문제나 복구 실패가 게임의 승자를 결정하지는 않습니다.

## Profile과 입력 지연

| Profile | TPS | 지연 기본/상한 | rollback window | state ring |
| --- | ---: | ---: | ---: | ---: |
| action | 60 | 2 / 8 | 12 | 64 |
| rts | 20 | 4 / 12 | 6 | 32 |
| lockstep | 20 | 4 / 20 | 0 | 32 |

`{...profiles.rts, tickRate:30}`처럼 같은 Core의 정책을 조정합니다. 논리 dt는 항상 1/tickRate이며 기본 Clock Sync는 Discrete Hold입니다. micro time dilation을 선택해도 실제 scheduler 간격만 바뀝니다.

`setInputDelay(n)`의 증가는 즉시 적용합니다. 감소는 입력을 잃지 않는 동일 sample에서 한 틱씩 적용합니다. `requestedInputDelay`가 목표, `inputDelay`가 실제 값입니다. 이미 commit한 command의 executeTick은 변경하지 않습니다. blur/visibilitychange에서는 releaseInput()을 호출하며 createLoop가 기본 연결을 제공합니다.

주요 옵션은 [Profile 타입](rollback-netcode.d.ts)에 있습니다. peerInterruptMs/peerTimeoutMs 기본값은 1초/10초, maxRecoveryAttempts는 3회입니다. 지연과 연결 한도는 Runtime 정책이며 게임 checksum에 포함하지 않습니다.

## 상태 크기·해시·리플레이

기본 maxHistoryBytes는 64 MiB, maxSnapshotBytes는 4 MiB입니다. 초기 snapshot × ring 크기를 검사하며 state가 커지면 실제 보관 예산도 검사합니다. 예를 들어 action의 64개 ring에 4 MiB state를 보관하려면 256 MiB가 필요합니다. 큰 state에는 게임 규모에 맞는 ring/byte budget을 명시해야 합니다. Sparse snapshot 간격은 현재 제공하지 않습니다.

상태 hash는 필요할 때 계산·캐시합니다. 매 tick getStateHash()를 호출하면 그 비용은 발생합니다. metrics의 stateHashComputations/hashedStateBytes/retainedSnapshotBytes로 확인하세요. 저장 버퍼를 재사용하는 Adapter도 안전하도록 Core의 보관 복사는 유지됩니다.

`exportReplay()`는 확정 입력·초기 상태·시드·버전과 최종 hash를 반환합니다. `playReplay({adapter,replay})` 결과 hash를 replay.hash와 비교합니다. 기록 한도로 truncated가 true이면 확정 입력의 앞부분만 포함합니다. 게임 콘텐츠 버전 관리는 애플리케이션이 담당합니다.

fixedPoint는 scale 1024와 signed 32-bit 결과를 사용합니다. 안전한 정수 곱은 정확한 Number 경로를, 그 밖의 곱과 나눗셈은 BigInt를 사용합니다. SeededPRNG.state는 게임 snapshot에 포함해야 합니다. statelessRandom은 안정적인 eventId로 계산합니다. 이 헬퍼가 임의의 게임 물리를 자동으로 결정론적으로 바꾸지는 않습니다.

## 기여자 검사

```sh
node scripts/build.mjs
node scripts/build.mjs --check
node --test tests/*.test.mjs
node scripts/benchmark.mjs
node scripts/primitives-benchmark.mjs
node scripts/browser-check.mjs
node scripts/demo-check.mjs
node scripts/live-room-check.mjs
```

Node와 Playwright는 기여자 검사 도구이며 소비자 실행 의존성이 아닙니다. 타입 변경은 `tsc --noEmit --strict --lib ES2022,DOM --module nodenext --moduleResolution nodenext tests/types.test.ts`로 확인합니다. CI는 단일 배포 모듈과 src/의 일치·공개 API·기본 회귀를 검사합니다.

현재 결과와 미검증 범위는 [검증 기록](docs/verification.md), 작업 운영은 [AGENTS.md](AGENTS.md)를 참고하세요.

실제 게임 비용은 선택적 `scripts/rally-benchmark.mjs`로 분리 측정합니다. `RALLY_HTML`에 Adapter가 있는 RALLY FRONTIER HTML, `RALLY_REPO`에 그 Git 저장소를 지정합니다. `RALLY_PAIRED=1`은 같은 프레임에서 실행 순서를 번갈아 비교하며 게임 step·Adapter save·Core와 연결부의 잔여 비용을 따로 기록합니다. 외부 게임 저장소는 라이브러리 소비자/기본 CI의 의존성이 아닙니다.

## 공통 값 코덱 capability (0.2 개발 후보)

`createValueCodec()`의 기본 형식은 `binary`입니다. `binaryCodec`는 기본 인스턴스이며 `jsonCodec` 또는 `createValueCodec({format:'json'})`으로 UTF-8 JSON을 명시적으로 선택합니다. 둘 다 `encode(value): Uint8Array`, `decode(bytes): value`를 제공하며 Adapter가 Has-a로 소유하고 상태/명령 계약에 맞는 값만 전달합니다. Core는 코덱·게임 구조를 모르고 opaque bytes만 보관·해시·전송합니다.

```js
import { binaryCodec, createValueCodec } from './rollback-netcode.js';
const stateCodec = binaryCodec;
const commandCodec = createValueCodec({ maxBytes: 4096, maxDepth: 16 });
const bytes = stateCodec.encode({ tick: 1, seed: 42, units: [] });
const snapshot = stateCodec.decode(bytes);
```

바이너리는 `RV`/version 1 헤더와 타입 태그를 사용합니다. 길이는 unsigned 32-bit little-endian, int32 범위 정수는 최소 길이 zigzag varint, 나머지 number는 유한 IEEE-754 float64 little-endian이고 -0은 0으로 정규화합니다. 문자열은 유효한 UTF-8이며 record 키는 JavaScript UTF-16 사전순으로 정렬합니다. null·boolean·number·string·array·plain record를 지원하고 바이너리는 Uint8Array도 지원합니다. JSON은 bytes를 지원하지 않습니다. undefined·비유한 수·순환 참조·클래스 인스턴스·고립 surrogate는 거부합니다. 게임 필드 선택·스키마 검증·권위와 표현의 분리는 Adapter 책임입니다.

기본 한도는 16 MiB/깊이 128/값과 key 1,000,000개입니다. 잘림·여분 바이트·중복/비정렬 key·비정규 수·잘못된 UTF-8·초과 한도는 decode에서 거부합니다. 선택 JSON도 정규 bytes만 허용하므로 외부 JSON 문자열은 먼저 파싱해 encode해야 합니다. 형식 변경은 byte hash를 변경하므로 실제 게임 비교에는 복원 값과 최종 결과를 사용하세요. 성능/용량 개선은 게임 상태에 따라 달라지며 코덱만으로 개선을 보장하지 않습니다.

이 API는 PR 후보에만 있습니다. 현재 공개 Pages에 API가 추가됐다고 가정하지 마세요. 콘텐츠 해시 경로의 준비와 실제 공개 배포는 별도이며 쿼리스트링은 버전을 고정하지 않습니다.

바이너리의 반복 문자열은 payload 내부 dictionary를 사용합니다. 최초 문자열만 UTF-8 literal로 기록하고 이후 같은 필드 이름/문자열 값은 최소 varuint 인덱스로 참조합니다. dictionary는 payload마다 새로 생성하므로 이전 encode/decode 호출이나 전역 cache 상태가 bytes에 영향을 주지 않습니다. 등록 순서는 정규 순회 순서이고, 중복 literal·미등록 참조·비최소 참조는 거부합니다.

## 외부 렌더 루프와 진단 표시

기존 requestAnimationFrame을 쓰는 앱은 `createLoop({ session, beforeFrame, canAdvance, onAdvance, render })`를 만들고 매 프레임 `loop.pulse(timestamp)`를 호출할 수 있습니다. 이때 `start()`는 호출하지 않습니다. `beforeFrame(timestamp)`에서 세션의 사용자 제공 clock을 해당 프레임 시각으로 갱신하면 poll과 advance가 같은 시간 기준을 사용합니다. `canAdvance()`는 새 논리 틱마다 확인하므로 승패나 앱 일시정지 뒤 추가 틱이 실행되지 않습니다. 대기 중에도 poll의 복구 작업과 render는 지속됩니다. 재시작/화면 전환 때 `resetTiming()`으로 누적 시간을 비웁니다. 자동 RAF의 start/stop과 입력 release 동작은 유지됩니다.

롤백과 복구 재실행은 과거 상태에서 이전 현재 틱까지 한 호출 안에서 완료합니다. `resimulationBudget`, `createLoop`의 `maxWorkMs` 및 측정용 `now` 옵션은 제거했습니다. 시간 예산으로 정상 틱을 생략하거나 재실행을 여러 호출로 나누지 않습니다. 깊은 롤백은 완료할 때까지 호출을 점유하며, 메트릭은 그 실제 비용을 기록합니다.

`SyncTestSession.metrics`는 읽기 전용 snapshot으로 status/tick/checkDistance/checkedTicks/resimulatedTicks/stateHash/historyBytes/failure와 SDK 내부에서 측정한 forwardCostMs/resimulationCostMs/totalCostMs를 제공합니다. 시간은 정상 step·직렬화와 재실행·비교 비용을 포함하고 필수 forward 상태 복구 load를 포함합니다. batch 전체의 초기 save와 최종 원상 복구 load, yield 대기는 제외합니다. UI에서 카운터나 hash를 별도로 계산할 필요가 없습니다. `runSyncTest`도 기존 tick/hash 필드와 함께 `metrics`를 반환하며 실패 시 던진 Error의 `syncTestMetrics`에서 같은 요약을 읽습니다. 실패 요약에는 전체 snapshot/input payload를 넣지 않습니다. 세션을 close하면 metrics의 historyBytes는 0, stateHash는 null입니다.


시간이 오래 걸리는 게임 진단은 `await runSyncTestAsync({ ...options, frames, signal })`를 사용하세요. SDK가 같은 SynctestSession으로 반복하며 각 advance 전후에 기본 `setTimeout(0)`으로 제어를 양보합니다. 선택 `yieldControl()`로 앱의 스케줄러에 맞출 수 있습니다. 명시적 AbortSignal 취소는 reason과 실패 metrics를 가진 Error로 전달하고 초기 snapshot을 복구합니다. 시간 메트릭에는 yield 대기 시간이 포함되지 않습니다.

비동기 진단에는 **독립된 동일 게임 Adapter**를 전달하세요. 진단은 await 사이에 그 Adapter의 상태를 load/step하므로 실행 중인 게임과 Adapter를 공유하면 안 됩니다. 원래 seed/rules/identity로 shadow simulation을 만들고 검사할 replay 초기 상태를 load한 뒤 전달하면 실제 게임의 poll/렌더와 나란히 진행할 수 있습니다. 한 advance 내부 checkDistance만큼의 동기 재실행은 중간에 양보하지 않으므로 한 frame 자체가 무거운 경우 거리를 줄이세요.


진단용 입력은 `session.exportSyncTestFrames({ maxFrames: 32 })`에서 가져오세요. Core의 실제 확정 기록 앞부분만 독립 복사하고 초기 bytes·players·inputSize·tickRate·initialTick을 함께 제공합니다. maxFrames는 1~256으로 제한하며 기록이 꺼졌거나 replay 예산으로 중단됐다면 존재하는 확정 prefix만 반환합니다. 현재 tick/hash를 추정해서 채우지 않습니다. resimulation 중에는 호출을 거부합니다. 전체 `exportReplay()`를 복사한 뒤 slice하는 비용을 피할 수 있습니다.
