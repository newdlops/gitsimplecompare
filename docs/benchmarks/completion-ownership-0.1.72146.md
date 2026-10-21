# 완료 결과 소유권과 PR 이동 검증 — 0.1.72146

기준은 `38ac9fc64394b83e69bea8fa3b1b97c7a74eac63`(0.1.72145)다.
전체 Git 작업 지연·Graph 최신화·안정성·자원 목표의 진행 결과이며, 전체 목표 완료를 뜻하지 않는다.

## 런타임 변경

완료를 기록하는 동안 외부 커밋이 생기면 새 HEAD를 작업 결과로 채택하던 경합을 수정한다.
PR·branch squash·rebase의 완료 기록에 이미 확인한 결과 HEAD를 전달하고,
Undo 상태를 읽은 HEAD가 다르면 기록을 거부한다. 외부 커밋·로컬 편집·stash·snapshot을 보존한다.
PR worktree 복구 결과에도 같은 계약을 적용한다.

커밋별 적용·revert 큐는 마지막 적용 직후의 `operationHead`를 유지한다.
stash 복원 전과 완료 pending 정리 전에 현재 checkout을 새로 검증한다.
검증에 실패하면 pending을 먼저 지우거나 외부 HEAD를 결과로 반환하지 않는다.
중복 완료 HEAD 조회 하나를 줄이면서 기존 사전 검사·각 commit의 branch guard는 유지한다.
이번 런타임 변경은 UI source나 status/index cache를 변경하지 않는다.

## PR Graph 행 이동

0.1.72144에서 수정한 첫 경량 목록의 빈 OID·미수신 PR 객체 경로를 유지한다.
클릭한 PR의 ref만 조회하고 All branches에서는 일치 remote에서 필요한 객체만 가져온다.
명시적 branch filter, 취소, latest-wins와 재시도 처리는 유지한다.

현재 source의 production HTML/CSP/JS에서 실제 목록 버튼 → 등록된 Graph callback →
Native 객체 fetch → 최종 DOM을 다시 확인했다. 390×844, 768×1024, 1440×900에서
선택 행의 노출·강조와 Graph 키보드 포커스를 확인하고 안정된 screenshot을 직접 검토했다.
첫 클릭만 window/API 요청을 보내며 이후 두 클릭은 같은 행을 재사용한다.
HEAD·named refs·index·config·기존 FETCH_HEAD는 전후가 같다.
이는 새 UI 디자인이나 실제 GitHub 네트워크 지연 측정이 아니다.

## 현재 후보 검사

관련 Node 검사 **84건**과 타입 검사·공백 검사가 통과했다.
기존 코드의 재현 실행은 5건 중 2건이 기대한 거부 없이 실패했고, 수정 후 모두 통과한다.
추가 경합 검사는 PR squash/replay/revert 4경로, clean/dirty branch squash와 native rebase,
deferred 완료 기록 전후 외부 커밋, stash 적용 전 거부와 pending 보존을 다룬다.
기존 Undo·continue·abort·worktree 충돌 복구·atomic snapshot 검사도 통과했다.

```text
GSC_NODE_TEST_CONCURRENCY=1 node scripts/run-node-tests.mjs \
  test/completedOperationOwnership.test.ts test/pullRequestSnapshotAtomic.test.ts \
  test/branchOperationSafety.test.ts test/branchRebaseCompletion.test.ts \
  test/pullRequestWorktreeRecovery.test.ts
GSC_NODE_TEST_CONCURRENCY=1 node scripts/run-node-tests.mjs \
  test/pullRequestGraphJump.test.ts test/graphCommitWindowCandidates.test.ts \
  test/deferredCommitCompletion.test.ts test/benchmarkOverrides.test.ts
npm run check-types
```

파일 1,000개·commit 1,000개·branch 100개·공유 upstream 8개의 독립 fixture에서
현재 후보의 Git 작업 **18개 변형**이 Native HEAD·부모·refs·local-only와 production DOM에 일치했다.
initial, 일반/tracked push, pull/fetch의 신규·알려진·무변경 이력, rebase,
squash/no-ff merge, PR squash/replay, cherry-pick, loaded/unloaded checkout이다.
일부 작업 뒤 HEAD가 loaded page 밖에 있는 기존 동작도 Native page와 대조한다.
모든 HEAD로 자동 이동하거나 모든 HEAD 행이 보인다는 검사는 아니다.

이전/현재 후보의 실제 PR 버튼 B/A/A/B **8회**도 Native tree·부모·refs·최종 DOM에 일치했다.
각 source/작업당 표본은 2개다. 전체 명령 수에는 Graph 후속 조회가 포함된다.

| 현재 변경 비교, 중앙값 | 이전 | 현재 |
| --- | ---: | ---: |
| PR squash Git 실행 수 | 30 | 30 |
| 커밋별 PR 적용 Git 실행 수 | 29 | 28 |
| PR squash 최종 frame(ms) | 433.5 | 2217.5 |
| 커밋별 PR 적용 최종 frame(ms) | 2062 | 680.5 |

시간 편차와 반대 결과가 커 이 표로 보편적인 실행 시간 개선을 주장하지 않는다.
커밋별 적용의 `rev-parse` 감소는 두 표본 모두 12→11회로 확인했다.

## 전체 작업 자원 계측 확장

동일 observer를 정상 renderer 기준 `b9d8ed66f58156095e094f2ec1d5e4ac4d07cd9b`(0.1.72112)와
현재 변경 전 0.1.72145에 연결한 누적 비교다. **이번 0.1.72146만의 효과가 아니다.**
CPU 계측 B/A/A/B와 별도 비계측 시간 B/A/A/B의 144개 개별 결과가 Native/DOM 검사를 통과했다.
이전 loaded checkout은 source별 목록 순서로 대상을 골랐으므로 비교 합계에서 제외한다.
따라서 아래 medium 합계는 실행별 동일한 나머지 **17개** 작업이며 source별 표본은 2개다.

| 누적 비교 | 이전 | 0.1.72145 |
| --- | ---: | ---: |
| 별도 계측 구간 CPU 합계 중앙값(ms) | 11397.814 | 8390.524 |
| 비계측 서비스→최종 frame 합계 중앙값(ms) | 16997 | 12587 |
| 비계측 Git 실행 수 합계 중앙값 | 447.5 | 246.5 |

읽기 전용 Captain snapshot(30,311파일·72,720commit·164branch)을 독립 소유 fixture에
재현한 비교에서도 현재 18개, 이전 17개가 개별 Native/DOM 검사를 통과했다.
이전 새 branch push는 이미 receiver main에 있는 조상을 순차 publish하는 경로로 진행되어
수분 뒤 prefix 334개에서 소유 실행만 중단했다. 완료 시간이나 CPU 값을 만들어 넣지 않았다.
이는 모든 object bytes가 재전송됐다는 뜻은 아니다.
후속 이전 작업은 측정 밖 Native push로 같은 ref/upstream 상태를 만든다.
이 준비를 앱 push 성공으로 집계하지 않는다.

이 push와 비교 대상이 달랐던 loaded checkout을 뺀 공통 16개 작업에서,
계측 CPU 합계는 63236.336→38020.425ms, 서비스→최종 frame 합계는 66715→55489ms다.
서비스 자체 합계는 26435→34395ms로 느려졌다. 원시 반대 결과도 보존한다.
현재 쪽 새 branch push 서비스는 5962ms에 완료했지만 이전의 유한한 완료 표본은 없다.

별도 교대 실행의 두 번째 sequence는 앞선 fixture commit의 생성 시각으로 OID가 달라져
checkout 입력 fingerprint 검증에서 중단됐다. 완성된 paired 개선율로 집계하지 않는다.
현재 harness는 branch 이름을 정렬하고, 측정 전에 branch+Native tree를 fingerprint한다.

## 관측 경계와 보존

CPU는 서비스/클릭 직전부터 마지막 production frame ACK와 settle까지의 counter window다.
Node/Playwright transport·종료해 wait된 native 자식·동일 PID Chromium의 CPU를 포함한다.
fixture 준비·probe 빌드·Native 사후 oracle·screenshot은 제외한다.
Chromium PID 누락·역행·종류 변경은 불완전으로 처리하며 이 결과들은 모두 완전하다.
CPU 계측 실행의 시간을 비계측 속도 자료로 섞지 않는다.

기존 Node `mock.restoreAll()`은 호출 인자를 유지했다. 실제 `--expose-gc`·WeakRef 검사로
이를 구분하고 benchmark만 호출 기록 없는 함수 교체기로 전환했다.
따라서 이전 observer의 heap/RSS 증가를 생산 코드의 메모리 누수로 해석하지 않는다.
현재 await 직후 Node heap/RSS도 retained heap·전체 프로세스 메모리·peak 증거가 아니다.
계측 helper·C probe는 설치 확장에 포함하지 않는다.

OS 포커스 전환, foreground Host, 강제 reload, 별도 Marketplace 상태 점검은 수행하지 않았다.
Captain의 파일·index·refs·config, 사용자 stash·snapshot·보존 PR worktree는 바꾸지 않았다.
eslint는 기존 의존성 미선언 상태를 유지한다. 모든 source·원시 결과 hash는 같은 이름의 JSON에 있다.
개별 지연과 전체 메모리 최소화는 추가 근거가 필요하므로 원래 전체 목표는 진행 상태다.
