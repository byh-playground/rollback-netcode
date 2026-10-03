# 검증 기록

## 2026-10-03 N인 방과 풀메시·스타형 후보

`createNostrGroupRoom`을 추가한 작업 브랜치의 결과입니다. Core는 기존 구현을 사용합니다. 공개 배포 완료나 여러 기기의 실제 게임 출시 검증을 뜻하지 않습니다.

- Windows x64 / Node 25.9.0에서 `node --test tests/*.test.mjs`: **130개 PASS**. 2~8명 전 인원의 양쪽 방 토폴로지·논리 경로·최대 패킷, 시작 메시지 유실 재시도, 인원/토폴로지 불일치, 취소·형성 제한 시간, 늦은 참가·방장 종료, 잘못된 명단, 제3자 방장 광고가 실행 중 방을 닫지 못하는 사례를 포함합니다.
- 스타 전송: 16KiB 경계의 분할·역순 조립·중복 억제, 물리 발신자 사칭·다른 세션 거부, 방장 backpressure 후 전달, 큐 초과의 명시적 실패, 불완전 조립 만료·종료 후 해제를 검사했습니다.
- 2·3·4·8피어 Core 회귀에서 서로 다른 입력 지연, 손실·중복·역순, 명령의 단일 실행, 독립 입력 oracle, 최종 확정 해시와 각 피어의 리플레이 일치를 확인했습니다. 최종 조건은 필요한 롤백까지 완료된 상태입니다.
- TypeScript 7.0.2 strict 검사 및 단일 배포 모듈/소스 일치 검사 PASS.
- 기존 `node scripts/browser-check.mjs`의 독립 두 브라우저 context/실제 RTC 240틱 검사 PASS. oracle·리플레이·양쪽 hash 1728421543 일치, browser error 0.

### N인 실제 RTC 통합 검사

`node scripts/group-browser-serve.mjs`로 제공하는 `tests/group-browser.html`에서 실행했습니다. Windows의 Codex 내장 Chromium에서 N개의 독립 Session/Adapter와 실제 RTCPeerConnection을 생성했습니다. 입력·시계 채널에는 15~44ms 지연·지터와 입력 약 1/37 손실을 주었고, 제어 채널은 ordered/reliable 계약을 유지했습니다. 16,800바이트 상태에 고의 불일치를 넣어 큰 스냅샷 복구까지 검사했습니다. 기본 시그널링은 로컬 릴레이 대역이며 Nostr 서명·검증은 라이브러리의 실제 구현입니다.

실제 시간과 `createLoop`의 60TPS를 사용한 결과입니다. 아래 각 행의 모든 참가자가 240틱의 동일 확정 상태 및 리플레이 결과에 도달했고, 일회성 명령도 참가자당 한 번만 실행됐습니다. 서로 다른 행은 참가자 ID·입력 샘플 타이밍이 다르므로 행 사이 해시가 같아야 한다는 조건은 아닙니다.

| 인원 | 토폴로지 | 물리 연결 | RTC 전송 합계 B | 롤백 합계 | 복구 합계 | 동기 pulse 구간 최대 ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 2 | mesh | 1 | 43,978 | 20 | 1 | 0.8 |
| 3 | mesh | 3 | 115,086 | 55 | 2 | 1.2 |
| 4 | mesh | 6 | 216,607 | 100 | 3 | 1.0 |
| 8 | mesh | 28 | 937,866 | 313 | 7 | 3.0 |
| 2 | star | 1 | 61,572 | 21 | 1 | 0.8 |
| 3 | star | 2 | 216,311 | 81 | 2 | 0.7 |
| 4 | star | 3 | 466,237 | 181 | 3 | 1.2 |
| 8 | star | 7 | 2,468,624 | 669 | 7 | 7.1 |

8인 스타형은 이 조건에서 물리 연결이 28→7개로 줄지만 전송 합계는 약 2.6배였습니다. 표의 시간은 한 브라우저에서 모든 Session을 pulse한 동기 구간만 측정하며, 비동기 RTC 수신·릴레이·서명 검증 전체 CPU나 실제 게임 렌더 프레임 시간을 포함하지 않습니다. 실제 기기별 게임 성능 보장으로 사용하지 않습니다.

초기 검사의 제어 패킷 역순 주입은 실제 ordered control 채널 계약과 달라 복구 시간 초과를 만들었습니다. 제어 순서를 보존하도록 테스트를 수정했습니다. 또한 초기 수동 드라이버는 8ms마다 60TPS 논리 틱을 직접 진행해 실제 게임보다 빠른 통신 부하를 만들었습니다. 이 조건에서는 8인 star가 약 22.7MB를 전송했으므로 해당 수치를 일반 플레이 비용으로 사용하지 않고, 위의 공통 createLoop 검사로 구분했습니다.

### 공개 릴레이 검사

같은 검사 화면에서 테스트 전용 무작위 namespace로 기본 공개 Nostr 릴레이와 기본 publication pacing을 사용한 4인 검사도 통과했습니다. 게임 전송은 실제 RTC입니다.

- 4인 mesh: 물리 연결 6개, 240틱, 롤백 111회·복구 3회, 216,707B 전송, 최종 hash 2094787106과 리플레이 일치.
- 4인 star: 물리 연결 3개, 240틱, 롤백 180회·복구 3회, 466,161B 전송, 최종 hash 4278660878과 리플레이 일치.
- 브라우저 오류 0. 로컬 보고서는 `test-results/group-browser-60tps.json`, `group-browser-public-mesh.json`, `group-browser-public-star.json`에 저장했습니다.

서로 다른 기기·외부 NAT·모바일, 실제 게임 규모의 장시간 성능, 공개 릴레이를 쓰는 8인 조합은 이번에 검증하지 않았습니다. 진행 중 합류와 방장 승계는 API 범위 밖입니다.

## 이전 후보 검증

2026-10-03의 0.2.0-dev 적용 후보 검사입니다. 환경은 Windows x64, Node 25.9.0, Chromium 154.0.8037.95, TypeScript 7.0.2입니다. 아래 범위를 통과했으며 Stable/모든 게임의 출시 검증을 뜻하지 않습니다.

## 기능과 브라우저

- 자동 검사 **79개 PASS**. Core·mesh·Nostr·room·수학 헬퍼에 Synctest, 상태/실패, 입력 보존, 생성물/타입 API, 콘텐츠 주소 검사를 추가했습니다.
- Synctest는 거리 1/4/12, ring wrap, 재사용 save buffer, 누락된 RNG와 tick deadline의 실제 불일치를 검사했습니다.
- interruption→timeout, 실제 transport close, 새 traffic 재개, malformed/duplicate keepalive 거부, 최종 recovery 거부/timeout의 종단 실패, handshake 불일치를 확인했습니다.
- 순간 입력·release·일회성 command를 지연 감소에서 보존했고, 측정 지연 증가가 한 번에 여러 틱 반영됐습니다.
- 단일 생성 모듈과 src 공개 API가 같으며 Core의 의존 경계에 Nostr/WebRTC/DOM이 없습니다. `.d.ts`의 실제 소비자 fixture가 strict TypeScript 검사를 통과했습니다.
- 독립 browser context의 실제 RTC에서 **240tick**, offline oracle 및 replay hash **67059ea7** 일치. 최대 rollback depth 12, 정상 hash mismatch와 browser error 0.
- 실제 예제의 Action/RTS/lockstep, 키보드·pointer release, 점수 command 2개, replay, 고의 DESYNC의 snapshot recovery, Synctest 버튼 PASS. 390px 화면의 가로 넘침과 스크립트 오류 0, 화면 직접 확인.
- 실제 RTCPeerConnection을 실행 중 닫았을 때 양쪽 모두 disconnected로 전환하고 논리 tick이 정지했습니다.
- 공개 Nostr relay의 room 8373으로 실제 RTC 연결·점수 [7,8] 일치·정상 종료 PASS. 같은 컴퓨터의 독립 컨텍스트이며 외부 NAT 두 기기 검증은 아닙니다.

## Core 바이트 상태 벤치

기준은 이전 main `9f17ce6`, 현재 후보이며 각 조합 240step입니다. 한 local player, 재사용하는 byte state, replay 기록 없음, 게임 로직/직렬화/렌더링 제외 조건입니다. 모든 조합의 최종 state hash가 이전판과 같습니다.

Action profile의 단계 비용(ms):

| state | 이전 p50 | 현재 p50 | 이전 p95 | 현재 p95 | ring 메모리 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 128 KiB | 0.535 | 0.055 | 0.695 | 0.102 | 8 MiB |
| 1 MiB | 3.922 | 0.247 | 4.407 | 0.607 | 64 MiB |
| 2 MiB | 7.767 | 0.350 | 8.877 | 0.845 | 128 MiB |
| 4 MiB | 15.483 | 0.800 | 17.277 | 2.150 | 256 MiB |

큰 조합은 **byte budget을 명시적으로 높여** 측정했습니다. 기본 64 MiB로 4 MiB×64 state가 가능하다는 뜻이 아닙니다. RTS 32개 ring의 4 MiB 사례도 128 MiB 예산에서 p50 16.068→0.858ms였습니다. 필요하지 않은 state hash 계산과 Writer 할당을 줄인 효과이며 방어적 snapshot 복사는 유지했습니다.

fixed-point 100,000회 제한 범위 곱셈은 BigInt 기준 22.99ms, 안전 정수 fast path 포함 구현 8.57ms였습니다. 20,225개 경계/무작위 입력에서 BigInt 결과·overflow와 일치했습니다. division은 BigInt, scale은 1024를 유지합니다. Nostr 서명 검증 32개 표본의 p50/p95는 10.89/21.33ms이며 동시 환경 부하의 영향을 받는 경과 시간입니다. 물리 모바일 기기 수치가 아닙니다. 수신 검증에는 relay·회전 public key를 합산한 token budget을 적용했습니다.

## 실제 RALLY FRONTIER 비교

게임 기준은 도입 전 `0decb825`, Adapter 후보는 RALLY PR #20의 `050c621`입니다. 같은 seed 831047·20 TPS·초기 roster·명령을 사용했습니다. renderer·macro AI·실제 네트워크 전송은 제외한 simulation/직렬화/Core 경로입니다. 438유닛 사례는 밀집 전투 stress 조건입니다.

먼저 도입 전후 simulation만 2회 비교했고, 게임 결과 hash가 같았습니다. 이어 같은 게임 코드에서 이전/현재 SDK와 simulation 단독을 **프레임마다 순서를 바꿔 교차 실행**했습니다. warmup 12tick 뒤 90tick을 측정하고 실제 checksum 경계인 20tick마다 hash를 요청했습니다. 모든 변형의 게임 결과와 SDK 양쪽의 전체 memento hash가 같습니다.

교차 비교의 단계 **평균**(ms):

| 초기 유닛 | simulation 단독 | 이전 SDK 포함 | 현재 SDK 포함 | 이전→현재 | 현재 Adapter save | 이전→현재 잔여 비용 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 78 | 9.26 | 13.55 | 13.23 | −2.4% | 4.63 | 0.330→0.154 |
| 158 | 39.58 | 48.12 | 47.48 | −1.3% | 7.98 | 0.510→0.179 |
| 438 | 143.23 | 165.44 | 163.71 | −1.0% | 21.20 | 1.139→0.256 |

잔여 비용은 전체에서 실제 game step과 Adapter save를 뺀 값으로 **Core와 Adapter 연결부를 포함**합니다. Core 자체 비용의 상한에 가까우며, 엄밀한 profiler self-time은 아닙니다. 이전 대비 잔여 평균은 약 53–78% 감소했습니다. 전체 p95는 78유닛 16.9→15.7ms, 158유닛 61.5→59.7ms, 438유닛 183.8→189.4ms였습니다. 큰 사례의 tail은 약 3% 증가했으므로 모든 지표가 개선됐다고 주장하지 않습니다. 작은 전체 평균 차이는 환경 잡음의 영향을 받을 수 있습니다.

**도입 전보다 추가되는 비용은 여전히 있습니다.** 현재 SDK 포함 평균은 simulation 단독보다 약 43%/20%/14% 높고, 대부분 게임 Adapter의 전체 상태 저장·직렬화입니다. 현재 상태는 약 113/207/535 KiB입니다. 라이브러리의 계산/할당 비용은 줄었고 큰 회귀는 관찰되지 않았으므로, 다음 성능 작업은 게임 Adapter의 중복 복사·직렬화와 밀집 전투 step을 우선해야 합니다. 438유닛 stress에서는 simulation 단독부터 20 TPS의 50ms 예산을 넘습니다.

재현 명령은 `node scripts/benchmark.mjs`, `node scripts/primitives-benchmark.mjs`, `RALLY_HTML`/`RALLY_REPO`를 설정한 `node scripts/rally-benchmark.mjs` 및 `RALLY_PAIRED=1` 변형입니다. 상세 JSON은 실행할 때 `test-results/`에 생성됩니다.

## 범위와 배포

현재 생성 JS SHA-256은 `e577f63fc8f5e88e55202afbb354aa3f50e95f8847d04987a77d0211488ff77a`입니다. 같은 hash의 `versions/` 파일을 준비하고 일치 검사를 통과했습니다. 이 기록은 Pages 공개 게시를 뜻하지 않습니다.

실제 모바일 기기, Safari/Firefox 간 결정론, 외부 NAT 환경 두 기기, 장시간 신뢰성, 암호 코드 독립 감사는 미검증입니다. sparse snapshot 간격은 도입하지 않았습니다. 큰 state에는 적절한 history/byte budget이 필요하며 게임의 저장·복원 비용을 별도로 측정해야 합니다.

## 공통 값 코덱 추가 검증 (2026-10-03)

기본 binary/선택 JSON `encode/decode` capability를 추가했습니다. Core는 codec을 import하지 않고 게임 구조를 모르는 opaque bytes 계약을 유지합니다. `npm test` 82/82 PASS: 순서가 다른 record의 정규 bytes, Unicode/값 왕복, Uint8Array, 모든 길이의 잘림, 여분 byte, 잘못된 tag/UTF-8, 중복 JSON key, cycle/undefined/비유한 number, 깊이·값 개수·byte 한도, prototype key 처리를 포함합니다. `node scripts/build.mjs`로 단일 ES 모듈을 재생성했고 test가 source API/types/generated artifact 일치를 검사했습니다.

후보 binary 코덱은 JSON body를 포함하지 않습니다. 이 추가 자체의 실제 게임 성능·두 브라우저 RTC·모바일 UI 검증은 랠리 통합 검증에서 기록해야 합니다. 이 변경은 공개 배포나 머지가 아니며, 앞 절의 SHA-256은 이전 후보 기록입니다. 신규 API를 포함하는 공개 URL과 immutable version URL의 게시 완료를 주장하지 않습니다.

코덱 성능 재검토로 binary encode의 정규화 객체 복사를 제거하고 validation과 write를 합쳤습니다. Writer DataView는 버퍼 성장 때만 재생성합니다. 문자열 UTF-8 cache는 최대 1,024개/128 KiB로 제한합니다. int32는 최소 길이 zigzag varint로 저장하고, decoder는 직접 정규성을 검사하여 전체 재인코딩을 제거합니다. Uint8Array 결과는 소유한 독립 복사이며 문자열 BOM은 보존합니다. 부호/경계/비정규 varint/float64 정수 중복 표현/BOM 테스트를 추가해 `npm test` 83/83 PASS입니다. 실제 랠리 총 CPU 수치는 통합 측정 기록을 따릅니다.

반복 필드의 크기/복원 비용을 줄이기 위해 payload 내부 문자열 dictionary를 추가했습니다. 최초 문자열은 UTF-8 literal, 다음 같은 문자열은 최소 varuint 인덱스 참조(tag 9)로 저장합니다. 필드 이름과 문자열 값을 같은 dictionary에 보관하며 등록 순서는 정규 순회로 결정됩니다. 미등록 참조·중복 literal·비최소 인덱스는 거부합니다. dictionary의 등록/참조는 기존 maxEntries/byte 한도의 적용을 받습니다. 일반 record 필드는 직접 할당하고 `__proto__`만 안전한 own property로 정의합니다. 관련 테스트 포함 `npm test` 84/84 PASS입니다.

300개 record의 다수 문자열(1-byte 범위를 넘는 reference index), 혼합 수, 호출 사이 dictionary 격리, 잘림/항목 한도 테스트까지 추가해 최종 `npm test` 85/85 PASS입니다.

2026-10-03 랠리 URL 소비 연계 검증: 실제 Edge RTC 240tick/oracle/replay hash 67059ea7 일치. 랠리 후보는 URL 응답을 명시적으로 후보 생성물로 제공한 테스트에서 상태 11, AI 9, 수명주기 6 검사를 통과했다. 손실/지연/역순 깊이3 롤백, 종료 깊이5 롤백, 손상 chunk 거부 후 복구와 replay 결과 일치를 확인했다. 공개 API 미배포/오프라인 로딩 실패를 실제 URL 경로에서 오류로 표시한다. 후보 검증과 공개 배포 성공은 구분한다.

랠리 78/158유닛에서 같은 상태·35tick 결과가 JSON/바이너리로 동일했다. 반복 문자열 참조 후 126427→43675B, 232165→75253B. 숫자 바이트 hash는 포맷 변경으로 달라지므로 복원 데이터/최종 게임 결과를 비교했다. 중복 JSON 복사를 제거한 JSON만의 restore는 binary보다 빠를 수 있으며 바이너리가 모든 비용에서 우세하다고 주장하지 않는다. 전체 벤치 재현은 랠리 scripts/netcode-codec-benchmark.cjs에 있다.


## 2026-10-03 외부 루프 capability와 Synctest 메트릭 후보

- 전체 `node --test tests/*.test.mjs`: **91개 PASS**. 추가된 manual pulse, clock-before-poll, step별 terminal guard, hold 중 poll/recovery/render, timing reset, CPU budget, 기존 RAF start/stop/error 경로를 확인했습니다.
- Synctest SDK의 frozen metrics snapshot, history 바이트·hash·실행/재실행 수, 내부 비용 측정, failure 요약과 batch 실패 시 `error.syncTestMetrics`, 원래 게임 상태 복원을 검사했습니다. hash는 이력 snapshot에 캐시됩니다.
- `npx --yes -p typescript tsc --noEmit --strict --target es2022 --module nodenext --lib es2022,dom tests/types.test.ts` PASS. 새 loop API와 readonly 진단 metrics 소비자 타입을 확인했습니다.
- `node scripts/browser-check.mjs`: 실제 Chromium에서 새 loop와 runSyncTest metrics API PASS. 독립 두 context의 실제 RTCPeerConnection 240 tick에서 oracle/replay 및 양쪽 최종 hash 1728421543 일치, browser error 0, rollback depth 12.
- 새 API는 이 worktree의 적용 후보이며 공개 URL 배포 여부는 별도입니다. 랠리 실제 게임·UI 검증은 소비자 통합 작업에서 수행합니다. 동기 poll/step 한 번의 중간 취소나 물리 모바일/외부 NAT 두 기기 성능을 검증한 결과가 아닙니다.


### 비동기 Synctest 보완

동기식 32 tick×checkDistance 6 진단이 랠리 실제 브라우저에서 약 1초 동안 JS를 점유해 Core interruption을 일으킨 후보는 최종 PASS로 보지 않습니다. 공통 `runSyncTestAsync`를 추가해 SDK가 각 기존 SynctestSession.advance 전/후 event loop에 제어를 양보하도록 수정했습니다. 라이브 Adapter 대신 동일 게임의 독립 진단 Adapter를 써야 한다는 사용 계약을 README에 명시했습니다. async 결과와 실패 metrics는 동기 API와 같으며 abort는 원래 snapshot을 복원하고 reason을 전합니다.
- 비동기 보완 후 전체 자동 검사 **93개 PASS**, strict TypeScript PASS. 실제 브라우저 default yield 중 interval heartbeat가 계속 실행됐으며 동기/비동기 결과 hash와 초기 상태 복원이 일치했습니다. 이어서 실제 RTC 240 tick oracle/replay hash 1728421543 일치 PASS.


### 확정 입력 prefix와 비용 측정 보완

`exportSyncTestFrames({maxFrames})`가 첫 확정 기록을 최대 256개만 독립 복사하도록 추가했습니다. 긴 전체 replay를 복사 후 slice하지 않으며 선택되지 않은 frame의 inputs getter를 실행하면 throw하는 검사로 범위 밖 복사를 하지 않는 것을 확인했습니다. 잘린 기록 뒤 frame은 생성하지 않고 initialTick 0을 제공합니다. Synctest 시간은 mandatory forward restore가 성공하거나 throw해도 포함하도록 옮겼습니다. batch 초기 save/final restore와 async yield 대기는 범위 밖입니다. 비동기 양보는 **tick 경계**에서 하며 한 advance 안의 checkDistance 재실행은 여전히 동기입니다.
- 보완 최종 검사: 전체 자동 **96개 PASS**, strict TypeScript PASS, 실제 브라우저 bounded prefix 독립 복사와 async heartbeat PASS, 두 RTC 240 tick 최종 hash 1728421543 일치 PASS. 원래 동기 진단 후보의 1초 interruption 결과는 이 보완의 최종 PASS 범위에 포함하지 않습니다.


## 2026-10-03 동기 롤백·복구

롤백/복구 재실행의 호출별 분할과 createLoop의 12ms 등 시간 예산 게이트를 제거했습니다. 이전 현재 틱까지 같은 호출에서 재계산하며, 예측 윈도우와 패킷 청크·메모리 상한은 유지합니다. 시뮬레이션은 DOM/렌더링과 분리하고 어댑터 재실행 플래그로 표현 부수 효과를 분리하는 계약을 유지합니다. 앞서 실험한 명령 배치 주기/개수 및 재송신 후보는 이번 변경에 포함하지 않습니다.

24틱보다 깊은 롤백을 단일 poll에서, 40틱 복구를 마지막 스냅샷 청크 수신 호출에서 완료하고 최종 상태/해시가 일치하는 회귀 검사를 추가했습니다. 손상 스냅샷과 어댑터 예외는 원래 상태와 이력을 보존합니다. poll이 15ms 이상 걸려도 정상 틱이 진행하고 리플레이 결과가 일치합니다. strict TypeScript 검사를 통과했습니다. 실제 Edge RTC 두 피어 240틱 hash 1728421543 일치, 최대 깊이12 재계산과 브라우저 오류0을 확인했습니다.

동기 재실행은 완료할 때까지 호출을 점유합니다. CPU 총비용 개선이나 긴 작업 제거를 주장하지 않으며, 비용은 메트릭으로 관찰합니다. runSyncTestAsync의 명시적 비동기 진단 실행과 일반 wall-clock 따라잡기 상한은 라이브 경기의 롤백 분할과 별개입니다.
