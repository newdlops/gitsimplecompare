# 준비된 index의 commit 비용 — 0.1.72147

기준은 `36c2da573a69dd3bdac1bb8ae2f8ca375e6fe13b`(0.1.72146)다.
전체 Git 작업·Graph 최신화·안정성·자원 목표의 진행 결과다.
이번 변경만으로 전체 목표가 완료됐다고 판단하지 않는다.

## 확인한 병목

대형 PR squash의 실제 버튼 진단에서 Native commit 대기가 가장 컸다.
checkout 없이 index에 최종 tree만 설치한 임시 worktree에서 Git은 파일이 없으므로
parallel preload 두 번 뒤에도 각 entry를 최종 refresh에서 다시 확인했다.
Native TRACE2의 squash commit 구간은 30,314회씩 세 번, 총 90,942회의 lstat를 보고했다.
버리는 commit 성공 요약도 diffstat/rename 계산을 실행했다.

별도 partial-clone 재현에서는 squash와 squash revert 각각 성공 요약만을 위한
추가 promisor fetch 한 번이 발생했다. 기존 코드에서 두 회귀 검사 모두 실패했다.
이는 외부 GitHub 통신이 아니라 테스트가 소유한 file URL 서버와 실제 Native Git이다.

## 변경과 안전 경계

PR squash/revert, PR 충돌 복구 commit과 branch squash의 공통 실행을
`src/git/preparedIndexCommit.ts`로 모았다. 원래 메시지, `--no-verify`, editor/HUSKY 정책,
recovery의 `--allow-empty`와 Git 서명 설정은 유지한다.
`--quiet`로 사용하지 않는 Native 성공 요약을 생략한다.

계산된 tree를 checkout 없는 임시 worktree에 설치한 경우에만 명령 범위에서
`core.preloadIndex=false`를 적용한다. Native 최종 refresh/lstat는 실행하며,
일반 checkout에서는 기존 preload 설정을 그대로 따른다. config 파일은 변경하지 않는다.
완료 뒤 Output에 `prepared index commit completed`와 checkout·빈 commit 여부·시간을 남긴다.

사전 검사, source 범위, 결과 tree, branch/HEAD, index lock, Undo, stash와 snapshot 보호는
변경하지 않았다. 특히 0.1.72146의 결과 HEAD 소유권 검사를 그대로 유지한다.
기존 post-commit hook의 tree 교체 거부, message hook 오류와 signing 오류도 유지한다.

## 검사

관련 Node **104개**와 타입 검사가 통과했다.
새 partial-clone 검사는 추가 fetch 0회, 원래 결측 blob 4개 유지,
pack/config 바이트 보존과 Native 최종 refresh의 lstat 실행을 확인한다.
이 검사는 Native no-lazy-fetch 확인을 위해 Git 2.45 이상을 요구하며 현재 실행은 skip 0건이다.
설정 격리·버전 조건을 추가한 뒤 같은 두 검사를 다시 통과했다.

별도 Native 검사에서 prepare-commit-msg의 메시지 수정과 post-commit hook이 실행됐고,
필수 signing 실패가 출력으로 전파되면서 HEAD·staged 결과·파일·config가 보존됐다.
기존 modify/delete, merge 이력, legacy fallback, staged addition/sparse,
동시 편집·외부 commit, Undo와 다중 충돌 재개·빈 resolution 검사도 통과했다.

```text
GSC_NODE_TEST_CONCURRENCY=1 node scripts/run-node-tests.mjs \
  test/isolatedSquashCommit.test.ts test/pullRequestSquashMerge.test.ts \
  test/pullRequestSquashHistory.test.ts test/pullRequestResultReset.test.ts \
  test/completedOperationOwnership.test.ts
GSC_NODE_TEST_CONCURRENCY=1 node scripts/run-node-tests.mjs \
  test/preparedIndexCommit.test.ts test/branchOperationSafety.test.ts \
  test/pullRequestWorktreeRecovery.test.ts test/pullRequestUndoSafety.test.ts
npm run check-types
```

최종 후보의 **18개** Git 작업 변형이 Native HEAD·부모·refs·local-only와
production HTML/CSP/JS 최종 DOM에 일치했다. initial, 일반/tracked push,
pull/fetch 신규·알려진·무변경 이력, rebase, squash/no-ff merge, PR squash/replay,
cherry-pick, loaded/unloaded checkout이다. 페이지 밖 HEAD로 자동 이동하는 검사는 아니다.

## 실제 규모 버튼 비교

읽기 전용 Captain snapshot(30,311파일·72,720commit·164branch)을 독립 소유 fixture에
재현했다. 실제 PR 버튼 → 등록된 callback → Native Git → 최종 Graph를 사용했다.
GitHub metadata·VS Code transport/window/picker만 fixture로 대체했다.
비계측 시간 B/A/A/B와 별도 CPU 계측 B/A/A/B의 **16개** 버튼 동작이 모두 Native/DOM과 일치했다.
source/작업/mode당 표본은 2개이며 변경하지 않은 replay를 대조군으로 유지했다.

| 비계측 중앙값(ms) | 이전 | 수정 |
| --- | ---: | ---: |
| Squash Native commit | 304.5 | 73.5 |
| Squash handler | 774.5 | 640.5 |
| Squash 최종 frame | 1169 | 1179.5 |
| Squash 완전 settle | 1320 | 1330 |
| Replay 대조군 최종 frame | 1990 | 1806.5 |

Native commit 구간은 줄었지만 squash 최종 frame은 거의 같았다.
대조군도 변하므로 이번 표본만으로 전체 버튼 또는 모든 작업의 속도 개선을 주장하지 않는다.
Git 실행 수는 squash 32회, replay 30회로 이전/수정에서 같다.

| 별도 계측 구간 CPU 중앙값(ms) | 이전 | 수정 |
| --- | ---: | ---: |
| Squash Node/Playwright | 452.504 | 376.501 |
| Squash 종료·wait된 native 자식 | 3255.940 | 963.220 |
| Squash Chromium | 295.554 | 212.355 |
| Squash 합계 | 4003.999 | 1552.076 |
| Replay 대조군 합계 | 3420.146 | 3515.873 |

각 구성요소의 중앙값 합은 합계의 중앙값과 다를 수 있다.
계측 구간은 클릭 직전부터 마지막 frame ACK와 settle까지이며 fixture 준비·probe 빌드·
Native 사후 oracle·screenshot은 제외한다. Chromium 시작 PID 누락·역행·종류 변경 없이 완전했다.
Chrome root는 counter 뒤 종료해 waited 자식 CPU와 중복 합산하지 않는다.
이는 명령별 Git CPU attribution이나 전체 앱 CPU의 절대값이 아니다.
계측 실행의 시간을 비계측 지연 비교에 사용하지 않는다.

별도 TRACE2 진단의 lstat는 **90,942→30,314회**이며 최종 refresh 30,314회는 유지됐다.
진단 Native commit 시간 244.110→91.852ms는 observer 비용을 포함하므로 위 비계측 표와 섞지 않는다.
이 수치는 Native 검사 횟수이며 물리 디스크 읽기 횟수를 뜻하지 않는다.

## 한계와 보존

Node await 직후 heap/RSS는 retained heap·전체 메모리·peak 감소의 증거가 아니다.
개별 지연의 편차와 replay의 반대 CPU 결과를 그대로 보존한다.
실제 사용자 저장소, stash·snapshot·보존 PR worktree는 변경하거나 정리하지 않았다.
계측기는 설치 확장에 포함하지 않으며, UI source는 변경하지 않았다.
foreground Host, OS 포커스 전환, 강제 reload, 별도 Marketplace 상태 점검은 하지 않았다.
모든 source와 원시 결과 hash·개별 표본은 같은 이름의 JSON에 있다.
