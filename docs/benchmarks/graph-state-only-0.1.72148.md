# 동일 모델의 Graph 상태 갱신 — 0.1.72148

기준은 `f7ee62c2740ab64e6541b39517cfd189fa3f9b58`(0.1.72147)다.
전체 Git 작업·Graph 최신화·안정성·자원 최적화 목표의 진행 결과이며,
이번 변경으로 전체 목표가 완료됐다고 판단하지 않는다.

## 확인한 중복 작업

실제 PR 버튼 → 등록 callback → Native Git → production Graph 경로를 추적했다.
300행의 첫 snapshot 뒤 local-only 표시 9행이 바뀌고, 마지막 working-tree 결과는
행과 간선을 하나도 바꾸지 않으면서 pending 상태만 해제했다.
기존 클라이언트는 마지막 메시지에서도 전체 모델 배열을 복사하고 Graph·PR·rebase·reflog의
데이터 수신 경로를 다시 실행했다. 수정 전 브라우저 검사 4건이 이 중복을 재현했다.

## 변경과 보존 경계

`graphDataUpdates.js`에서 기존 revision·배열 경계 검증 뒤 빈 delta를 상태 메시지로 변환한다.
모델이 비어 있지 않고, reset이 아니며, colorScope와 laneCount가 같고,
행·간선의 추가와 수정이 모두 없고 resync 대기 중이 아닐 때만 적용한다.
revision은 전진시키되 기존 모델 배열과 DOM을 유지한다.
실제 데이터 변경, 저장소 색상 변경, reset과 빈 화면은 원래 렌더 경로를 사용한다.

`graph.js`는 상태·오류·pending 표시와 기존 두 animation-frame 뒤의 최종 paint ACK를 유지한다.
`newer` 방향의 동일 모델 갱신에서는 모든 행을 스캔하지 않고 같은 scroll 좌표를 복원한다.
선택·포커스·키보드 입력을 유지하며 끝에 도달했을 때의 자동 추가 로드도 실행한다.
백엔드 Git 조회, host 게시 수, 안전 사전 검사와 recovery 경로는 바꾸지 않았다.
성능 수치를 줄이기 위해 최종 상태나 ACK를 생략하지 않는다.

PR 행 이동 수정도 유지했다. 첫 목록에 OID가 없으면 클릭한 PR 한 건을 조회하며,
일치 remote에서 필요한 객체만 받아 실제 커밋 창으로 이동한다.
관련 Native Git 10건을 현재 소스에서 다시 실행해 refs·FETCH_HEAD·index·config·로컬 수정 보존,
최신 head, merge 결과, fork/upstream, 필터, 취소와 등록 callback을 확인했다.
원래 수정의 상세 동작은 `docs/pr-row-jump-verification-0.1.72144.md`에 있다.

## 기능과 화면 검사

서로 다른 Node 검사 **59건**, 브라우저 검사 **64건**, 타입 검사가 통과했다.
브라우저 합계는 최초 49건과 상태 spec의 추가 자동 로드 1건,
reference/width/row-sync 11건, PR jump 3건이며 중복 실행은 더하지 않았다.

새 상태 spec은 390×844, 768×1024, 1440×900에서 loading → 완료 → 오류,
같은 행/SVG 보존, scroll·선택·포커스, revision 전진과 후속 실제 metadata 적용을 검사한다.
reset·scope·lane·빈 화면 fallback, 잘못된 revision의 단일 resync,
오래된 ACK 무효화와 끝 행의 자동 로드도 확인한다.
80개 PR 목록에서는 Chromium CPU 6배 제한 아래 동일 모델 갱신의 PR DOM mutation이 0이며
기존 검색 입력과 키보드 포커스가 유지됐다.

```text
GSC_NODE_TEST_CONCURRENCY=1 node scripts/run-node-tests.mjs \
  test/graphIncrementalLayout.test.ts test/graphRenderColorReuse.test.ts \
  test/graphOperationLifecycle.test.ts test/graphRefreshResourceSafety.test.ts \
  test/graphActionRefresh.test.ts test/graphCheckoutRefresh.test.ts \
  test/graphDirectRefreshResume.test.ts test/graphInitialLoading.test.ts
GSC_NODE_TEST_CONCURRENCY=1 node scripts/run-node-tests.mjs test/pullRequestGraphJump.test.ts
node_modules/.bin/playwright test test/webview/graphStateOnly.spec.ts --project=chromium --workers=1
npm run check-types
```

기존 VS Code 토큰·Codicon·밀도를 유지하고 `ui-design-workflow`를 적용했다.
새 상태 화면 6장과 Native 작업 뒤 세 크기의 화면을 직접 확인했다.
light 390 / high-contrast 768 / dark 1440의 기존 PR 목록 화면도 직접 확인했으며,
동일 테마의 axe 결과는 위반 0건이다. 상태·PR 목록·참조·checkout·초기 로딩·성능 spec을
함께 실행했다. eslint는 프로젝트 의존성에 없는 기존 상태여서 검사에 포함하지 않았다.

## 실제 규모 비교

읽기 전용 Captain snapshot(30,311파일·72,720commit·164branch)을 별도 소유 fixture에
재현했다. 각 실행의 첫 PR 목록과 실제 DOM에 **80개 PR 카드**가 있는지 측정 전에 확인했다.
첫 PR은 실제 3commit 작업 대상이며 나머지 metadata는 fixture의 실제 Native branch/OID를 쓴다.
GitHub 응답과 VS Code transport/window/picker만 대체하고 실제 버튼·서비스·Git·Graph를 연결했다.

진단 smoke 2건, 비계측 B/A/A/B 8건과 별도 CPU 계측 B/A/A/B 8건이 통과했다.
각 source/작업/mode의 표본은 **2개**다. fixture 준비·probe 빌드·Native 사후 oracle·screenshot은
측정 구간에서 제외했고, 비교 중 source hash가 같은지 전후로 검사했다.

| 비계측 중앙값(ms) | 이전 | 수정 |
| --- | ---: | ---: |
| PR squash 최종 frame | 776.5 | 765 |
| PR replay 최종 frame | 1573 | 1536.5 |
| PR squash 마지막 render | 2 | 2 |
| PR replay 마지막 render | 2 | 2 |

최종 표시 시간의 변화는 작고 마지막 render 중앙값은 그대로다.
중복 데이터 처리가 제거됐다는 구조적 결과와 별개로, 이 표본에서 전체 체감 속도 개선이나
모든 작업의 지연 감소를 입증했다고 판단하지 않는다. Git 실행 수는 squash 32회, replay 30회로 같다.
진단 smoke에서도 initial/local-only/working-tree의 host 메시지 3개는 전후에 모두 유지됐다.

| 별도 계측 CPU 중앙값(ms) | 이전 | 수정 |
| --- | ---: | ---: |
| PR squash Node/Playwright | 359.326 | 341.866 |
| PR squash 종료·wait된 Native 자식 | 888.379 | 874.202 |
| PR squash Chromium | 328.173 | 305.151 |
| PR squash 합계 | 1575.877 | 1521.220 |
| PR replay Node/Playwright | 309.500 | 235.195 |
| PR replay 종료·wait된 Native 자식 | 3028.543 | 2900.141 |
| PR replay Chromium | 420.412 | 318.398 |
| PR replay 합계 | 3758.453 | 3453.733 |

각 구성요소 중앙값의 합은 합계의 중앙값과 다를 수 있다.
측정 범위는 클릭 직전부터 최종 ACK와 settle까지의 Node/Playwright,
종료·wait된 Native 자식, 완전하고 안정된 PID의 Chromium CPU다.
Chrome root를 counter 뒤 종료해 waited 자식 CPU와 중복 합산하지 않는다.
전체 VS Code CPU의 절대값이나 명령별 Git CPU attribution은 아니다.
CPU 계측 실행의 시간을 비계측 지연 근거로 섞지 않는다.

## 공통 작업 검증과 반대 결과

별도 중형 fixture(1,000파일·1,000commit·100branch·8공유 upstream)의 이전/수정 **18개 변형씩**도
Native HEAD·부모·refs·remote tag·local-only와 production 최종 DOM에 일치했다.
initial, 일반/tracked push, pull/fetch의 신규·알려진·무변경 이력, rebase,
squash/no-ff merge, PR squash/replay, cherry-pick, loaded/unloaded checkout을 포함한다.
checkout의 대상 branch/tree fingerprint도 전후에 같았다.
전체 Native/DOM 검사는 총 **54건**, 현재 후보는 27건이다.

이 단일 matrix 비교의 scoped CPU 합계는 **6234.165→6752.105ms로 증가**했다.
Node 1183.198→1334.415, Native 자식 2836.837→3100.466,
Chromium 2214.130→2317.224ms다. Git 실행 수는 양쪽 252회다.
이 반대 결과를 제외하지 않으며, 대형 PR 표본의 CPU 감소를 모든 작업으로 일반화하지 않는다.

## 한계와 다음 범위

Node await 직후 heap/RSS는 retained heap·전체 메모리·peak 감소의 증거가 아니다.
모델 배열 복사를 생략한 사실을 전체 메모리 최소화의 실측 결과로 해석하지 않는다.
남은 큰 대기인 post-action Graph의 Native fingerprint·branch/local-only·status 조회는 별도 범위다.
사전 검사, 결과 HEAD 소유권, Undo·stash·snapshot 보호와 기존 PR 이동 경로를 유지한다.

실제 Captain 저장소, 사용자 stash·snapshot·보존 PR worktree는 변경하지 않았다.
계측기는 설치 확장에 포함하지 않는다. foreground Host, OS 포커스 전환,
강제 reload와 별도 Marketplace 상태 점검은 실행하지 않았다.
소스·원시 결과·화면·검사 로그의 hash와 개별 표본은 같은 이름의 JSON에 보관한다.
