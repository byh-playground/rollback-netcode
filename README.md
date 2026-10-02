# rollback-netcode

결정론적 P2P 입력 동기화, 롤백(rollback), 락스텝(lockstep)을 제공하는 의존성 없는 브라우저 ES 모듈입니다. JavaScript 파일 하나를 가져오면 됩니다. 사용하는 애플리케이션에는 npm, Node.js, 번들러, 빌드 단계, 외부 코드 CDN이 필요하지 않습니다.

**개발 상태:** 초기 구현 단계입니다. Stable 또는 프로덕션 검증 완료 버전으로 표시하지 않습니다. 자동 검사와 실제 브라우저 검증 근거는 아래 [검증 기록](#검증-기록)에 정리합니다. 숫자 연산 예제는 라이브러리 연결과 동작을 확인하는 용도이며, 완성된 게임을 의미하지 않습니다.

## 한국어 예제 확인 순서

[공식 예제 화면](https://byh-playground.github.io/rollback-netcode/)에서 먼저 같은 화면에 표시되는 컴퓨터 A와 B의 결과를 비교해 보세요. 기본 **이 화면에서 두 컴퓨터 검증** 모드는 한 페이지 안에서 독립적인 두 WebRTC 연결과 세션을 실행합니다.

1. 모드가 **이 화면에서 두 컴퓨터 검증**인지 확인하고 **시작**을 누릅니다. 연결되면 컴퓨터 A와 B의 결과가 두 줄로 표시됩니다.
2. **플레이어 A**의 화살표 버튼을 잠시 누르다가 놓습니다. 키보드의 ←·→ 키도 사용할 수 있습니다. 잠시 기다리면 두 줄에서 플레이어 A의 위치가 일치합니다. 플레이어 B는 해당 화살표 버튼이나 키보드 A·D 키로 움직일 수 있습니다.
3. **A 점수 명령**을 누릅니다. 아래 컴퓨터 A와 컴퓨터 B 카드에서 **플레이어 A 점수**가 같은 값으로 증가하는지 확인합니다. 한 번 누른 명령은 정해진 실행 틱에 처리됩니다.
4. **리플레이 확인**을 누릅니다. **리플레이 결과 일치**가 표시되면 확정된 입력 기록을 다시 실행한 결과가 저장된 해시와 일치한 것입니다.
5. 접혀 있는 **개발자 상세**를 열고 **상태를 고의로 어긋내기**를 누릅니다. 잠시 기다린 뒤 컴퓨터 B의 **상태 복구** 횟수가 증가하고, 두 줄의 위치와 두 카드의 점수가 다시 일치하는지 확인합니다.
6. 확인을 마쳤으면 **종료**를 누릅니다. 움직이는 중 포커스를 잃거나 화면을 숨겨도 입력은 0으로 해제됩니다.

**현재 상태 해시**는 서로 다른 틱에 있거나 예측 입력을 사용 중이면 다를 수 있습니다. 현재 해시가 다르다는 이유만으로 동기화 실패로 판단하지 마세요. 런타임은 확정된 입력 이력이 같은 과거 상태의 해시를 비교해 불일치를 판단합니다.

서로 다른 기기로 확인하려면 **연결 방식**에서 한쪽은 **다른 기기와 연결: 방 만들기**, 다른 쪽은 **다른 기기와 연결: 방 참가**를 선택합니다. 두 기기의 프로필을 같게 맞추고, 표시된 네 자리 방 번호를 입력합니다. 이 연결은 자체 운영 서버나 기본 TURN 중계 없이 공개 Nostr 릴레이로 연결 정보를 교환한 뒤 WebRTC로 직접 통신합니다. 공개 릴레이의 상태와 NAT 환경에 따라 연결이 실패할 수 있으며, 모든 네트워크에서 연결된다는 보장은 없습니다.

## 브라우저에서 사용하기

저장소의 공식 GitHub Pages 배포 주소에서 모듈을 가져올 수 있습니다.

```html
<script type="module">
  import { createSession, profiles } from
    'https://byh-playground.github.io/rollback-netcode/rollback-netcode.js';
</script>
```

[실행 가능한 예제](https://byh-playground.github.io/rollback-netcode/)를 열거나 `rollback-netcode.js`를 내려받아 애플리케이션과 함께 호스팅할 수 있습니다. Pages 주소는 저장소에 설정된 배포 소스의 리비전을 제공합니다. 초기 배포 대상으로 정한 브랜치는 개발 후보인 `codex/single-module-core`입니다. 해당 PR은 검토 가능한 상태를 유지하며, 명시적인 머지 지시 전에는 머지하지 않습니다. 공개 게시를 Stable 출시로 해석하지 않습니다. 실제 배포 리비전은 최종 검증 기록에서 확인합니다. 버전별 배포 경로는 향후 출시 정책이며, 현재 특정 버전 URL이나 태그의 배포를 약속하지 않습니다. 변경되지 않는 코드가 필요하면 검토한 파일을 애플리케이션에 직접 고정하세요.

ES 모듈은 HTTP(S)로 제공해야 합니다. 원격 방 연결에는 HTTPS 또는 localhost, Web Crypto, WebSocket, `RTCPeerConnection`, DataChannel이 필요합니다. 파일을 가져오는 것만으로 릴레이에 접속하거나 네트워크 연결을 만들지는 않습니다.

## 개발 계약과 책임 분담

이 README가 개발 계약의 유일한 기준 원본(SSOT)입니다. 구현, 테스트, 예제, API 변경을 이 계약과 일치시키고, 별도 계획 문서에 같은 계약을 복제하지 않습니다.

**기본 언어는 한국어입니다.** 문서, 예제 UI, 사용 안내는 한국어로 작성합니다. JavaScript 식별자, 공개 API 이름, 프로토콜 필드·열거값, 널리 쓰이는 기술 용어는 원래 이름을 유지합니다.

| 책임 주체 | 담당하는 일 | 맡지 않는 일 |
| --- | --- | --- |
| 결정론적 게임 어댑터 | 게임의 권위 있는 상태, 규칙, 안정적인 직렬화, 완전한 스냅샷, 결정론적 `step` | 실제 시간에 따른 스케줄링, 원격 패킷 처리, 렌더링 부수 효과 |
| 넷코드 런타임 | 입력·상태 이력, 예측, 확정, 롤백, 명령 스케줄링, 지연 정책, 불일치 감지, 검증된 스냅샷 복구 | 게임 AI, 물리, 충돌, 길 찾기, 엔티티 설계, 전투 규칙, 렌더러 |
| 전송과 시그널링 | 바이너리 게임 데이터 전달, SDP/ICE 탐색과 협상 | 게임의 권위 있는 상태, 시뮬레이션 판단 |
| 표현 계층(Presentation) | 렌더링, 보간, 카메라, 사운드, UI, 확정된 이벤트에 맞춘 효과 조정 | 권위 있는 상태 변경, 논리적 틱 간격 변경 |

추상화의 의미를 구체적으로 유지합니다. **Is-a(무엇인가)**: `Session`은 결정론적 입력 동기화 세션입니다. **Has-a(무엇을 갖는가)**: 어댑터, 크기가 제한된 이력, 상대와 연결된 전송 객체, 설정 가능한 정책을 갖습니다. **Can-be(설정에 따라 어떻게 동작하는가)**: 같은 세션이 설정에 따라 롤백 또는 락스텝으로 동작할 수 있습니다. 모든 프로필은 하나의 코어를 사용합니다. 장르별 하위 클래스, 별도 동기화 엔진, 특정 게임의 런타임 메커니즘은 범위 밖입니다. 게임 엔티티의 구조를 가정하기보다 `save`, `load`, `step`, 전송 구독처럼 동작을 제공하는 capability 인터페이스를 사용합니다.

<a id="developer-usage-scenarios"></a>

## 개발자 사용 시나리오

게임은 애플리케이션이 소유하고, 입력 동기화는 라이브러리가 담당합니다. 다음 순서로 연결합니다.

1. **오프라인에서 게임 상태를 되돌릴 수 있게 만듭니다.** 같은 맵·규칙·시드로 초기화하고 `save`, `load`, `step`, `validateSnapshot`을 구현한 다음 리플레이의 결정성을 확인합니다. 스냅샷에는 RNG 상태와 틱 기준 기한을 포함해 권위 있는 상태 전체를 저장합니다. 렌더링 캐시는 스냅샷 밖에 둡니다.
2. **해당 시뮬레이션에 맞는 프로필을 선택합니다.** Action, RTS, lockstep 프리셋을 초기 런타임 정책으로 사용합니다. 양쪽이 시뮬레이션 버전, 틱 속도, 참가자 목록, 입력 형식, 시드, 초기 상태에 합의해야 합니다. 장르가 달라져도 다른 동기화 엔진을 만들 필요는 없습니다.
3. **연결 전에 방 번호를 보여줍니다.** 방을 만드는 쪽은 네 자리를 생성해 표시하고, 참가하는 쪽은 그 번호를 입력합니다. 양쪽은 같은 애플리케이션 namespace를 사용합니다. `createNostrRoom`의 연결을 기다린 뒤 반환된 `sessionId`, 플레이어 ID, 전송 객체를 사용합니다. 대기 화면에서 취소할 때 진행 중인 소켓과 협상을 해제하도록 AbortSignal을 전달합니다.
4. **Session을 만들고 전송 객체를 연결합니다.** 각 브라우저는 자신의 게임 어댑터와 Session을 갖습니다. 일반적인 업데이트 데이터로 월드 좌표를 계속 보내지 않습니다. 세 명 이상의 고정 참가자 목록을 사용한다면 원격 참가자마다 전송 객체 하나를 연결하고, 애플리케이션에서 메시(mesh) 탐색을 구현합니다.
5. **입력 읽기, 명령 등록, 렌더링을 분리합니다.** `getInput`은 계속 누르고 있는 조작 상태를 반환합니다. `queueCommand`는 공격이나 건설 명령처럼 한 번 실행하는 동작에 사용합니다. `step`으로 전달된 동기화된 `inputs`와 명령을 적용하며, 로컬 명령을 게임에 먼저 직접 적용하지 않습니다. 렌더링에는 표현 계층 연결부를 사용하고, `resimulating` 동안에는 마지막으로 완료된 렌더링 상태를 유지합니다.
6. **관찰하고 정리합니다.** 런타임 측정값과 이벤트를 관찰하고, 버그 재현을 위해 확정된 리플레이를 내보냅니다. 스냅샷 복구는 설정된 권위 참가자에게 맡깁니다. 나갈 때 루프를 멈추고 Session과 연결을 닫습니다. 참가자 목록이 바뀌거나 중도 참가가 필요하면 호환되는 새 세션을 시작합니다.

```js
import { createNostrRoom, createSession, createLoop, profiles } from
  'https://byh-playground.github.io/rollback-netcode/rollback-netcode.js';

// gameAdapter, controls, 표현 계층 연결부는 애플리케이션에서 제공합니다.
// 두 플레이어는 같은 권위 있는 초기 상태와 시드를 사용합니다.
const abort = new AbortController();
const connection = await createNostrRoom({
  role: 'join', room: '1234', namespace: 'my-game-v1', signal: abort.signal
});
const session = createSession({
  players: ['a', 'b'], localPlayerId: connection.localPlayerId,
  sessionId: connection.sessionId, simulationVersion: 'my-game-rules-and-map-v1',
  seed: 42, inputSize: 1, profile: profiles.action, adapter: gameAdapter
});
session.attachTransport(connection.remotePlayerId, connection.transport);
const loop = createLoop({
  session,
  getInput: () => new Uint8Array([controls.heldBits]),
  onInputRelease: () => { controls.heldBits = 0; },
  render: ({ alpha, resimulating }) => {
    if (!resimulating) presentationBridge.captureCompletedState();
    presentationBridge.draw(alpha);
  },
  onError: error => showSessionError(error)
});
loop.start();
// 공격 버튼은 명령을 등록하고, step()은 실행 틱에 그 payload를 해석합니다.
session.queueCommand(new Uint8Array([1]));
// 종료 시: loop.stop(); session.close(); connection.close(); abort.abort();
```

이 코드는 애플리케이션에 연결하기 위한 예시입니다. `gameAdapter`, `controls`, 표현 계층, 오류 UI는 애플리케이션이 제공합니다. 실제 예제 화면은 같은 책임 경계를 끝까지 연결한 실행 가능한 구현입니다.

| 개발자 시나리오 | 연결 방법 | 확인할 수 있는 결과 |
| --- | --- | --- |
| 즉각적인 조작감이 필요한 두 플레이어 액션 게임 | Action 프로필, 유지되는 입력, 한 번 실행하는 명령 | 롤백 윈도우 안에서 즉시 진행하거나 예측합니다. 원격 입력이 달라지면 과거로 돌아가 다시 실행합니다. |
| 명령이 많은 RTS | 상태·이력의 한도를 측정해 설정한 RTS 프로필 | 더 높은 지연과 더 작은 롤백 윈도우를 사용합니다. 명령은 확정된 실행 틱을 유지합니다. |
| 엄격한 락스텝 또는 결정성 조사 | 롤백 윈도우 0 | 실제 입력을 기다린 뒤 진행하며, 추측으로 실행하지 않습니다. |
| 지연 또는 CPU 문제 | 측정값, 적응형 지연, hold/dilation 페이싱 | 런타임 정책이 스케줄링을 조정합니다. 고정된 논리적 틱 간격과 확정된 명령은 유지됩니다. |
| 확정된 상태의 불일치 | 어댑터 검증, 권위 참가자의 스냅샷 | 과거 후보를 검사하고 다시 실행한 뒤 원자적으로 교체합니다. 거부한 후보는 현재 상태를 바꾸지 않습니다. |
| 경기 중 버그 재현 | 확정된 리플레이 내보내기, `playReplay` 실행 | 같은 게임 어댑터로 기록된 입력 이력을 다시 실행하고 최종 해시를 비교합니다. |
| 별도의 연결 환경 | 범용 Signaler/Transport 어댑터 | 같은 Session을 재사용합니다. 게임 규칙과 입력 이력은 시그널링 제공자에 의존하지 않습니다. |

### 결정성(Determinism)

각 단계의 논리적 시간은 `1 / tickRate`로 고정합니다. 스케줄러가 대기하거나 실제 시간의 실행 속도를 조정해도 이 간격은 바꾸지 않습니다. 권위 있는 연산에는 정수 또는 고정소수점(fixed-point), 상태를 저장하는 시드 기반 PRNG, 안정적인 플레이어·엔티티·명령 순서, 바이트 순서를 명시한 정규 바이너리 직렬화를 사용합니다. 이후 단계에 영향을 줄 수 있는 값을 모두 스냅샷에 저장합니다. 시뮬레이션에 `Math.random()`, 날짜, 프레임 시간, 렌더러 상태, 플랫폼에 따라 달라지는 순회를 사용하지 않습니다.

`tick`은 다음에 실행할 단계입니다. 저장된 상태 `S[t]`는 입력 프레임 `t`를 실행하기 직전 상태를 뜻합니다. 롤백은 보관 중인 과거 `S[t]`를 복원한 뒤, 영향을 받은 프레임을 이전의 현재 시점까지 다시 실행합니다. 어댑터는 부수 효과 없이 스냅샷을 불러와야 하며, 초기 상태·시드·순서가 정해진 입력이 같으면 같은 상태 바이트를 만들어야 합니다. `resimulating` 중에는 `step`에서 되돌릴 수 없는 효과를 실행하지 않습니다. 표현 계층에서 효과를 별도로 맞출 수 있습니다.

어댑터는 `save`, `load`, `step`, `validateSnapshot`의 네 가지 동작을 모두 구현해야 합니다. 함수가 하나라도 없으면 세션 생성을 거부합니다. `validateSnapshot(bytes, { tick })`은 예상 틱의 완전하고 유효한 스냅샷에만 `true`를 반환하고, 게임을 변경하지 않아야 합니다. 정규 형태의 `save(load(bytes))`는 해당 바이트를 정확히 재현해야 합니다.

공개 헬퍼 `fixedPoint`, `SeededPRNG`, `statelessRandom`, `hashBytes`는 결정론적 어댑터 구현을 돕습니다. `fixedPoint`는 배율 1,024를 사용하고 결과가 부호 있는 32비트 범위인지 검사합니다. `SeededPRNG`는 `nextUint32()`, `nextInt(bound)`, `state`를 제공하므로 그 상태를 게임 스냅샷에 직렬화해야 합니다. `statelessRandom(seed, eventId)`은 변경 가능한 PRNG 상태 없이 안정적인 이벤트 ID에서 난수를 계산합니다. 이 헬퍼만으로 임의의 부동소수점 물리나 게임 코드가 결정론적으로 바뀌지는 않습니다.

### 입력, 명령, 시간

세션이 유지되는 동안 입력 프레임의 `inputSize`와 참가자 목록을 고정합니다. 원격 입력이 없으면 `hold` 정책은 마지막 입력을 유지하고, `neutral` 정책은 0 입력으로 예측합니다. 예측은 설정한 롤백 윈도우 안에서만 허용합니다. 입력 링은 확정·예측 입력을 저장하고, 상태 링은 완전한 바이너리 스냅샷을 저장합니다. 안전한 예측·이력 경계에 도달하면 필요한 이력을 버리지 않고 실행을 대기시킵니다.

입력 지연은 새로 확정할 프레임에 적용합니다. 적응형 지연은 측정한 RTT와 지터에 반응할 수 있지만, 이미 확정된 입력이나 명령을 다른 틱으로 옮겨서는 안 됩니다. `queueCommand(payload)`는 단조 증가하는 sequence를 할당합니다. 다음 새 로컬 입력 프레임을 확정할 때 명령의 변경 불가능한 `executeTick`을 지정합니다. 시뮬레이션에는 플레이어와 sequence 순서로 정렬된 명령을 전달합니다. `releaseInput()`은 포커스나 포인터 캡처를 잃었을 때도 명시적인 0 입력을 예약합니다.

느린 상대는 단계 대기와 제한된 스케줄러 작업량으로 처리합니다. 렌더링은 독립적으로 진행합니다. 따라잡기 단계도 항상 같은 논리적 간격인 `1 / tickRate`를 사용합니다. 적응형 페이싱이나 재시뮬레이션에서 가변 `dt`를 만들지 않습니다. 원격 틱 보고는 측정 시점의 표본입니다. 실제 시간의 진행을 추정할 때 표본의 경과 시간은 최대 한 논리 틱까지만 외삽하고, 네트워크 여유로 측정 RTT의 절반을 더합니다. 이 추정은 페이싱을 조정하며 권위 있는 시뮬레이션의 시간 간격을 바꾸지 않습니다.

`session.tick`과 `session.inputDelay`는 읽기 전용입니다. `advance`로 진행하고 `setInputDelay`로 지연을 바꿉니다. 해당 속성에 직접 값을 대입하는 방식으로 시계나 정책을 변경하지 않습니다. 부호 있는 확인 응답 필드가 아직 확정된 입력이 없음을 나타내는 `-1`을 예약하므로, 입력 틱은 `MAX_TICK = 0x7ffffffe`로 제한합니다. 이 범위를 넘어가는 확정이나 진행은 카운터가 순환하기 전에 `RangeError`를 발생시킵니다. 60 TPS로 계속 실행하면 약 414일에 해당하며, 한도 전에 새 세션을 시작해야 합니다.

### 불일치 감지, 복구, 리플레이

해시는 확정된 입력을 바탕으로 만든 상태끼리 비교합니다. 예측이 달라지면 롤백을 수행하지만, 그것만으로 결정성 실패로 판단하지 않습니다. 확정된 입력의 상태 해시가 다르면 동기화 불일치(desync)로 판단해 복구합니다. 참가자 ID를 사전순으로 정렬했을 때 첫 플레이어가 기본 스냅샷 권위 참가자입니다. `authorityPlayerId`로 참가자 중 한 명을 명시적으로 지정할 수도 있습니다. 이 권위는 복구를 위한 약속이며 부정행위 방지를 보장하지 않습니다.

복구 스냅샷은 보관 중인 과거 틱에 속해야 합니다. 세션·시뮬레이션 식별 정보, 틱, 크기, 청크 범위, 필수 어댑터 검증을 확인한 뒤 받아들입니다. 조립, 정규 형태의 왕복 검증, 후보 재실행은 트랜잭션으로 처리합니다. 형식이 잘못됐거나 오래됐거나 일부가 잘렸거나 유효하지 않은 데이터는 현재 상태를 바꾸면 안 됩니다. 유효한 과거 스냅샷을 제한된 작업량으로 나누어 재실행하고, 작업 사이에는 원래 게임 상태를 유지합니다. 완성된 대체 게임 상태와 런타임 이력을 함께 확정합니다. 보관된 스냅샷과 후보 재실행의 임시 저장 공간은 각각 기본 64 MiB인 `maxHistoryBytes`를 따릅니다. 검증하지 않았거나 일부만 재실행한 원격 스냅샷으로 현재를 덮어쓰지 않습니다.

복구 요청은 기본적으로 연속 세 번까지 시도합니다. 실패하거나 시간 초과한 시도는 한도에 포함하고, 복구에 성공하면 카운터를 초기화합니다. 세션 전체에서 복구를 세 번만 허용한다는 뜻은 아닙니다.

게임 데이터 패킷은 바이너리입니다. 스냅샷 전송은 청크당 최대 16,384바이트를 사용하고 DataChannel의 backpressure를 따릅니다. 제어 채널이 혼잡하면 주기적인 해시를 가장 최근에 보관된 확정 체크섬 경계로 합칩니다. 이 때문에 예외를 던지거나 큐를 무제한으로 늘리지 않습니다. 이력, 대기 패킷, 청크 조립, sequence 윈도우, 재시뮬레이션 작업량에는 명시적인 한도가 있어야 합니다. 입력 손실·중복·순서 변경, 패킷 파싱 실패, 제어 채널 혼잡을 실패 경로로 검증합니다.

`exportReplay()`는 초기 상태, 참가자 목록, 시드, 틱 속도, 시뮬레이션 식별 정보와 함께 정규 형태의 확정 입력을 저장합니다. `playReplay()`는 같은 어댑터를 사용해 `{ tick, hash }`를 반환합니다. 예제처럼 그 해시를 `replay.hash`와 비교해야 합니다. 기록 용량은 기본 64 MiB인 `maxReplayBytes`로 제한합니다. 한도에 도달해 기록이 멈추면 내보낸 데이터에 `truncated: true`를 표시합니다. 연속된 확정 입력의 앞부분과 그 부분의 최종 해시를 보존하며, 해당 상태가 실제 스냅샷 링에서 사라진 뒤에도 해시를 유지합니다. 잘린 리플레이에는 이후 세션 내용이 포함되지 않습니다. 리플레이는 결정론적 디버깅 자료이며, 게임 콘텐츠의 버전 관리를 대신하지 않습니다.

## 세션 API

```js
const session = createSession({
  players: ['a', 'b'],
  localPlayerId: 'a',
  sessionId: 'match-unique-id',
  simulationVersion: 'my-game-rules-v1',
  seed: 42,
  inputSize: 1,
  profile: profiles.action,
  adapter: {
    save() { return stateBytes(); },             // 완전한 상태를 담은 Uint8Array
    load(bytes) { restoreState(bytes); },        // 네트워크·렌더링 부수 효과 없이 복원
    step({ tick, tickRate, inputs, resimulating }) {
      // inputs의 형식: [{ playerId, input: Uint8Array,
      //                  commands: [{ sequence, executeTick, payload }], predicted }]
      simulateOneFixedStep(tick, tickRate, inputs, resimulating);
    },
    validateSnapshot(bytes, { tick }) {
      return isValidCompleteState(bytes, tick);  // 상태를 변경하지 않고 boolean 반환
    }
  }
});
```

어댑터 계약을 설명하는 예시입니다. `stateBytes`, `restoreState`, 게임 규칙은 애플리케이션이 제공합니다. [예제 소스](index.html)에는 완전한 32바이트 정수 어댑터가 포함되어 있으며 그대로 실행할 수 있습니다.

| API | 동작 |
| --- | --- |
| `VERSION`, `MAX_TICK`, `profiles` | 런타임 버전, 입력 틱 한도, 재사용할 수 있는 설정 프리셋 |
| `session.tick` | `S[tick]`을 나타내는 읽기 전용 다음 논리 단계 |
| `session.confirmedTick` | 모든 플레이어의 연속된 입력이 확정된 마지막 틱. 초기값은 `-1`이며, 시뮬레이션이 완료된 확정 상태 경계는 `min(tick, confirmedTick + 1)` |
| `session.inputDelay` | 새로 확정할 로컬 프레임의 현재 지연. 읽기 전용이며 `setInputDelay`로 변경 |
| `session.metrics` | 측정한 런타임 카운터와 시간 |
| `advance(input: Uint8Array)` | 고정된 한 단계를 시도하고 `{ status, tick }` 반환. status는 `advanced`, `stalled`, `held`, `resimulating`, `synchronizing` 중 하나 |
| `poll(now)` | 호출자가 제공한 단조 증가 시간으로 들어온 작업과 시간 처리 |
| `attachTransport(peerId, transport)` | 고정 참가자 목록에 있는 원격 참가자의 게임 데이터 전송 객체 연결 |
| `queueCommand(payload: Uint8Array)` | 명령을 큐에 등록하고 sequence 번호 반환 |
| `setInputDelay(ticks)` | 설정 범위 안에서 새 프레임의 지연 정책 변경 |
| `releaseInput()` | 명시적인 0 입력 확정 |
| `getStateHash()` | 현재 정규 상태의 해시 |
| `requestResync(tick)` | 보관 중인 과거 틱에서 복구 요청 |
| `exportReplay()` | 초기 상태, 확정 프레임, 메타데이터, 보존된 최종 해시, `truncated` 표시 내보내기 |
| `close()` | 세션의 전송 구독과 자원 해제 |
| `playReplay({ adapter, replay, simulationVersion? })` | 결정론적 어댑터로 리플레이를 실행하고 `{ tick, hash }` 반환 |
| `createLoop({ session, getInput, render, onError, onInputRelease })` | 렌더링을 분리한 고정 틱 브라우저 스케줄러. 작업량에 한도가 있으며 `{ start, stop, running }` 반환. 포커스 상실·화면 숨김 시 `onInputRelease`에서 애플리케이션이 유지하던 조작 상태를 해제해야 함 |

`metrics`는 `predictedTicks`, `rollbacks`, `resimulatedTicks`, `maxRollbackDepth`, `stalls`, `holds`, `recoveries`, `rejectedSnapshots`, `rejectedPackets`, `hashMismatches`, `sentBytes`, `receivedBytes`, `latestResimulationMs`, `smoothedRTT`, `jitter`, `lateInputRate`, `rollbackFrequency`, `stallFrequency`, `resimulationCostMs`를 제공합니다. 적응형 지연은 이 런타임 측정값을 평활화하고 히스테리시스와 한도를 사용합니다. 이 값들을 권위 있는 상태에 넣지는 않습니다. 실행 중 관찰한 값이며 성능 보장은 아닙니다.

| 프로필 | 틱 속도 | 기본 지연과 허용 범위 | 롤백 윈도우 | 상태 이력 | 예측 |
| --- | ---: | ---: | ---: | ---: | --- |
| `profiles.action` | 60 TPS | 2틱, 허용 0–8틱 | 12틱 | 스냅샷 64개 | `hold`: 마지막 입력 유지 |
| `profiles.rts` | 20 TPS | 4틱, 허용 0–12틱 | 6틱 | 스냅샷 32개 | `neutral`: 0 입력 |
| `profiles.lockstep` | 60 TPS | 2틱, 허용 0–8틱 | 0틱 | 스냅샷 32개 | 예측 실행 없음 |

프로필은 시작 설정이며, 라이브러리가 해당 장르의 게임을 구현한다는 뜻은 아닙니다. 게임에서 측정한 입력 지연, 상태 크기, 어댑터 재실행 비용에 맞춰 윈도우와 지연 정책을 정합니다.

`{ ...profiles.action, baseInputDelayTicks: 3 }`처럼 설정 객체를 전달하면 같은 코어를 조정할 수 있습니다. 설정에는 `tickRate`, `baseInputDelayTicks`, `minInputDelayTicks`, `maxInputDelayTicks`, `rollbackWindowTicks`, `stateHistorySize`, `predictionPolicy`(`hold`/`neutral`), `tickDriftThreshold`, `pacingPolicy`(`hold`/`dilation`), `checksumInterval`, `resimulationBudget`, `maxCatchupSteps`, `adaptiveInputDelay`, 시간 간격, `maxHistoryBytes`를 포함한 용량 한도가 있습니다. 시간 팽창(Time dilation)은 실제 시간의 스케줄링만 조정합니다. 롤백 윈도우를 감당할 만큼 상태 이력을 확보해야 하며, 런타임은 잘못된 한도를 거부합니다. 기본 참가자 한도는 8명, 입력 크기는 1–1,024바이트, 명령 payload 한도는 2,048바이트, 스냅샷 한도는 4 MiB, 보관 상태의 예산은 64 MiB입니다. 프로토콜 동작의 한도이며, 8인 게임 성능을 검증했다는 주장은 아닙니다.

## WebRTC와 네 자리 방

`WebRTCTransport({ inputChannel, controlChannel })`는 원시 RTCDataChannel을 감쌉니다. `createWebRTCPeer({ initiator, signaler, remoteId, rtcConfig, timeoutMs, signal })`은 채널을 협상하고 `{ transport, peerConnection, close }`를 반환합니다. 선택적인 `signal`은 협상 중에도 즉시 취소할 수 있는 `AbortSignal`입니다. Signaler는 `{ id, send(to, message), subscribe(handler), close? }`를 제공하고, 구독 이벤트의 형식은 `{ from, to, message }`입니다. offer를 보내기 전에 응답 쪽을 등록하거나, 구독할 때까지 시그널링 메시지를 보관해야 합니다.

범용 게임 데이터 전송 객체는 `send(Uint8Array)`, 구독 해제 함수를 반환하는 `subscribe(handler)`, 선택적인 `close()`를 제공합니다. backpressure가 발생하면 `send`에서 `false`를 반환해 런타임이 재시도할 수 있게 합니다. 예제의 제한된 지연 래퍼는 이 공개 capability를 사용하면서 실제 RTCDataChannel 전송을 유지합니다.

```js
import { createSession, createNostrRoom, profiles } from './rollback-netcode.js';

// 연결을 기다리기 전에 방 번호 네 자리를 보여줍니다. 참가 쪽도 같은 번호를 사용합니다.
const room = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000)
  .padStart(4, '0');
console.info('이 방 번호를 공유하세요:', room); // 게임의 방 번호 UI로 표시하세요.
const connection = await createNostrRoom({ role: 'host', room });
const session = createSession({
  // 위 예시처럼 adapter, simulationVersion, seed, inputSize를 제공합니다.
  players: ['a', 'b'],
  localPlayerId: connection.localPlayerId,
  sessionId: connection.sessionId,
  profile: profiles.action,
  adapter: myDeterministicAdapter,
  simulationVersion: 'my-game-rules-v1',
  seed: 42,
  inputSize: 1
});
session.attachTransport(connection.remotePlayerId, connection.transport);
// 종료 시: session.close(); connection.close();
```

서로 다른 브라우저나 기기에서 같은 namespace와 호환되는 시뮬레이션 설정으로 host와 join을 호출합니다. `createNostrRoom({ role, room?, namespace?, relays?, rtcConfig?, signal?, onStatus? })`은 WebRTC 연결이 완료된 뒤 반환합니다. 방을 만드는 쪽이 헬퍼에 번호 생성을 맡기면, 연결을 기다리는 동안 `onStatus` 콜백이 `{ type: 'room', room, role }`를 받습니다. 그때 번호를 표시해야 합니다. Nostr 릴레이는 방 탐색과 SDP/ICE 시그널링에만 사용합니다. 연결 뒤의 게임 입력, 해시, 스냅샷은 WebRTC로 직접 전달하며 Nostr로 중계하지 않습니다. 방을 닫거나 signal을 취소하면 시그널링 연결도 해제합니다.

방 연결 헬퍼는 두 플레이어를 위한 편의 기능입니다. 방을 만든 쪽은 `a`, 참가한 쪽은 `b`입니다. 코어는 원격 플레이어마다 전송 객체 하나를 연결하는 방식으로 소규모 고정 참가자 목록을 지원합니다. 더 많은 참가자의 탐색과 전체 메시 협상은 애플리케이션이 맡습니다. 중도 참가와 참가자 목록 변경은 현재 세션 계약 밖입니다.

네 자리 번호는 탐색을 위한 UX이며 인증 비밀이 아닙니다. 방 번호 충돌과 릴레이의 가용성 때문에 참가하지 못할 수 있습니다. 공개 시그널링 서비스는 탐색 메타데이터를 볼 수 있습니다. 직접 연결의 성공 여부는 ICE와 사용자 네트워크에 달려 있습니다. 기본 설정에는 TURN 릴레이나 자체 운영 매치메이킹·게임 데이터 서버가 없으므로, 제한적인 NAT에서는 연결에 실패할 수 있습니다. 필요하면 애플리케이션에서 자체 TURN 설정을 포함한 `rtcConfig`를 명시적으로 제공할 수 있습니다.

기본 공개 릴레이는 Primal과 Damus입니다. 릴레이는 요청을 거부하거나 인증을 요구하거나 클라이언트의 요청 빈도를 제한할 수 있으므로, 가용성을 외부 서비스에 의존합니다. 시그널링 발행은 기본 500 ms 간격으로 순서대로 처리하고, ICE 후보는 묶어 전달합니다. 거부한 릴레이는 제외하며, 대기 중인 대체 릴레이가 같은 서명 이벤트를 받아들일 수 있습니다. `createNostrSignaler`는 `publishIntervalMs`, `signal`, 릴레이 URL, 주입한 WebSocket/WebCrypto capability를 받습니다. 내장 BIP-340 코드는 임시 시그널링 식별자를 위한 것입니다. BigInt 연산은 상수 시간(constant-time)이 아니며 지갑 구현이 아닙니다. 자동 릴레이 재연결·인증과 더 많은 참가자의 방 탐색은 초기 버전의 범위 밖입니다.

## 개발과 검증

가장 작고 일관된 책임 경계를 변경합니다. fixed timestep, fixed-point, seeded PRNG, prediction, rollback, confirmed input, snapshot, checksum, replay, DataChannel, signaling처럼 널리 쓰이는 용어를 사용합니다. 범용 capability를 한 번 구현해 조합하고, 게임 메커니즘, 프로필마다 복제한 엔진, 실제 동작 없는 구조 계층, 필요가 확인되지 않은 확장 지점을 추가하지 않습니다.

테스트는 구현을 그대로 따라 적기보다 위험을 기준으로 작성합니다. 결정론적 리플레이, 입력 지연·순서 변경·손실·중복, 예측 수정, 롤백 이력 경계, 윈도우 0인 락스텝, 확정 명령을 옮기지 않는 지연 변경, 포커스 상실 시 입력 해제, 확정 입력 해시 불일치, 트랜잭션 방식의 스냅샷 거부와 작업량을 제한한 복구, 연속 시도 카운터 초기화, 청크 조립·이력 바이트 한도, 잘린 리플레이의 해시 보존, backpressure 중 체크섬 병합, 틱 한도, 잘못된 패킷, 호환되지 않는 버전, 자원 정리를 다룹니다. 어댑터의 실제 재실행 비용, 보관 메모리, 패킷 크기, 스케줄러 작업량을 측정합니다. 단순한 숫자 연산 예제의 속도나 카운터만으로 프로덕션 프레임 예산을 판단하지 않습니다.

기여자 검사를 위한 Node.js 22는 선택적인 개발 도구입니다.

```sh
node --check rollback-netcode.js
node --test tests/*.test.mjs
node scripts/benchmark.mjs
```

선택적인 브라우저 검사는 별도로 설치된 Playwright를 사용하며, `PLAYWRIGHT_MODULE`로 설치 경로를 지정할 수 있습니다. `node scripts/browser-check.mjs`는 격리된 두 브라우저 컨텍스트에서 실제 RTCDataChannel을 검사합니다. `node scripts/demo-check.mjs`는 한국어 예제의 조작·리플레이·복구와 모바일 화면을 확인합니다. `node scripts/live-room-check.mjs`는 공개 Nostr 릴레이와 WebRTC로 전체 예제의 동작을 확인합니다. 게시된 Pages 리비전을 검사하려면 실제 방 검사에 `BASE_URL`을 설정합니다. 모두 기여자용 도구이며 런타임 의존성을 추가하지 않습니다.

CI는 의존성을 설치하지 않고 실행하며, 사용하는 런타임이 자체 완결된 ES 모듈 하나인지 검사합니다. 브라우저 검증에서는 실제 RTCDataChannel, 입력 변경, 명령, 입력 해제, 확정 해시, 고의로 만든 불일치의 복구, 리플레이, 연결 종료를 실행해야 합니다. 모바일 배치와 포커스·포인터 상실 동작을 눈으로 확인합니다. 실제 Nostr 시그널링과 서로 다른 네트워크 사이의 연결은 별도 근거가 필요합니다. 같은 컴퓨터 안의 두 연결만으로 이를 증명할 수 없습니다. 관련 주장을 검증하지 않은 출시를 Stable 또는 검증 완료로 표시하지 않습니다.

<a id="verification-record"></a>

### 검증 기록

2026-10-02에 Windows, Chromium 154.0.8037.58, Node.js 25.9.0에서 초기 로컬 연결 검사를 완료했습니다. CI는 별도로 Node.js 22를 사용하도록 설정되어 있습니다. 모듈과 예제 스크립트의 문법 검사 및 공백 검사가 통과했습니다.

실제 Pages 예제는 두 RTCPeerConnection과 DataChannel을 연결하고, 한 방향당 80 ms의 제한된 시험 지연을 적용했습니다. Action, RTS, lockstep 세션 모두 점수 명령 두 개를 처리하고, 포커스를 잃었을 때 누른 조작을 해제했으며, 확정 입력을 다시 실행해 최종 해시가 일치했습니다. 측정한 Action 실행에서는 최대 네 틱을 롤백했고, 고의로 어긋낸 확정 상태를 감지했습니다. 컴퓨터 B는 한 번 복구한 뒤 양쪽 위치가 `[-22, 80]`, 점수가 `[7, 8]`로 일치했습니다. Lockstep의 예측 틱 수는 0이었습니다. 단순한 연산 검증용 어댑터에서 관찰한 결과이며 게임 성능 보장이 아닙니다.

데스크톱 1,080 px와 모바일 390 px 스크린샷을 확인했습니다. 모바일에서 가로 넘침이 없었고 브라우저 스크립트 오류도 기록되지 않았습니다. 한국어 UI로 전환한 뒤에도 Action, RTS, lockstep 세 프로필의 실제 예제 검사와 390 px 모바일 검사를 통과했습니다. 종료하면 세션 조작과 컴퓨터 카드가 정리됐습니다. 연결이 끝나지 않는 릴레이를 모사한 검사에서도 방 취소 시 소켓을 닫고, 탐색 시간 초과까지 기다리지 않고 즉시 실패 결과를 반환했습니다.

최종 자동 검사는 59개입니다. 코어 33개, Nostr 17개, 방 수명주기 4개, 결정론적 헬퍼 4개, 세 참가자 메시 1개를 다룹니다. 런타임 입력 지연 한도가 다른 참가자들도 같은 순서의 입력 이력으로 일치했습니다. 격리된 컨텍스트의 DataChannel 검증용 프로그램은 240틱을 실행했고, 오프라인 기준 결과 및 리플레이 해시 `67059ea7`와 일치했습니다. 체크섬 불일치와 브라우저 예외는 0건이었습니다.

기여자용 벤치마크는 128 KiB 바이트 상태의 검증용 어댑터와 스냅샷 32개를 보관하는 RTS 링으로 1,000단계를 실행했습니다. 보관한 스냅샷 바이트는 4 MiB입니다. 이 Windows x64 / Node 25.9.0 환경에서 단계 비용은 중앙값 약 0.52 ms, p95 2.11 ms, p99 2.68 ms였습니다. 비용이 작은 어댑터의 스냅샷 복사, 해시 계산, 런타임 비용을 측정했으며, 실제 게임의 시뮬레이션과 렌더링 비용은 포함하지 않습니다.

실제 방 연결은 두 Chromium 컨텍스트에서 공개 Nostr 시그널링과 WebRTC를 사용했습니다. 양쪽이 명령 두 개를 실행한 뒤 위치 `[-56, 58]`과 점수 `[7, 8]`가 일치했고, 각각의 리플레이도 일치했습니다. 두 참가자는 같은 컴퓨터와 네트워크를 사용했습니다. 앞선 반복 검사에서 Damus의 요청 빈도 제한에 걸렸습니다. 현재 구현은 발행 빈도를 제한하고 ICE를 묶으며, 대체 릴레이의 응답이 늦어도 서명 메시지를 잃지 않게 처리합니다. 실제 검사에 성공했다고 공개 릴레이의 가용성이 보장되는 것은 아닙니다.

서로 다른 네트워크의 NAT 연결, Safari/Firefox, 장시간 신뢰성, 서명 코드에 대한 독립적인 감사, 프로덕션 게임 어댑터의 예산은 아직 검증하지 않았습니다. Stable 또는 프로덕션 검증 완료 출시로 주장하지 않습니다. Pages 배포와 후보 리비전은 연결된 PR과 저장소 배포 이력에서 추적합니다.

### 설계 참고 자료

용어와 롤백 모델은 공식 [GGPO 소개](https://www.ggpo.net/), [GGRS 0.13 문서](https://docs.rs/ggrs/0.13.0/ggrs/), [세션 설정 문서](https://docs.rs/ggrs/0.13.0/ggrs/struct.SessionBuilder.html)를 참고합니다. 이 라이브러리는 독립적인 브라우저 구현이며, 해당 프로젝트와의 호환성이나 같은 수준의 완성도를 주장하지 않습니다.

Nostr 시그널링은 [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)을 따릅니다. 이벤트 서명은 [BIP-340 Schnorr 서명](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki)을 사용하며, 공식 [BIP-340 테스트 벡터](https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv)를 검증 참고 자료로 사용합니다. 시그널링 키는 짧은 수명으로 사용하고 게임 플레이어 ID와 분리합니다.
