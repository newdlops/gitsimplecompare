# 브랜치 작업 안정화와 최적화 — 2026-10-30

브랜치 squash·rebase·Undo의 작업 경계를 보강했다. Native Git의 merge/commit/rebase와
index lock은 유지하고, 실제 결과로 증명할 수 있는 중복 조회만 줄였다.
이번 단계의 기준은 [이전 최적화 단계](branch-optimization-20261030.md)의 작업 트리다.
최초 Git HEAD 전체와의 누적 비교는 아니다.

## 수정한 경계

1. clean squash의 merge가 끝난 뒤 자동 commit 직전에 브랜치와 HEAD를 새로 검증한다.
   그 사이 외부 checkout이나 별도 commit이 생기면 squash index를 그대로 두고 중단한다.
2. 결과 OID와 부모를 한 조회로 읽어 시작 HEAD 바로 위의 단일 commit만 squash 결과로
   인정한다. 이후 외부 commit이나 두 부모를 가진 merge를 Undo 대상으로 채택하지 않는다.
   이 검증으로 isolated squash의 별도 조상 조회와 중복 checkout 조회를 제거했다.
   원본 결과 반영 직전의 두 검사는 실제 index lock 안에 그대로 남는다.
3. 임시 worktree의 index 조회·commit·snapshot·결과 반영·복구 기록이 실패하면 준비한
   파일과 commit을 보존하고 경로를 안내한다. compact 파일은 펼쳐 수동 복구할 수 있게 하며,
   펼치기까지 실패해도 worktree와 skip 상태를 남겨 재시도한다.
4. 같은 commit끼리의 squash는 readiness와 source 확인, 총 Git 조회 3회로 끝낸다.
   같은 source 재병합이나 이미 포함된 조상으로부터 변경이 생기지 않는 경우에도 이전 Undo를
   덮어쓰지 않는다. 시작 OID의 보호 ref는 먼저 만들고, 실제 변경이 확인된 뒤 새 Undo를 연결한다.
   변경이 없으면 새 ref만 기대 OID를 확인해 삭제한다.
5. rebase의 로컬 변경을 stash에 넣기 직전에도 원래 checkout을 확인한다. 준비 중 다른
   브랜치로 전환되면 그 브랜치의 staged/unstaged/untracked 파일을 stash로 옮기지 않는다.
6. interactive rebase의 upstream은 준비 시 고정한 브랜치 이름으로 조회한다. HEAD가 다른
   브랜치로 갔다 돌아오는 경우에도 다른 브랜치의 upstream 설정을 섞지 않는다.
7. 실패한 squash의 복구 소유권을 기록하지 못하면 다른 Git 충돌을 정상적인 작업 결과로
   반환하지 않는다. 조회 오류도 충돌이 없는 것으로 바꾸지 않는다.

동일 commit 생략, 결과 거부, 복구 worktree 보존은 `Git Simple Compare` OUTPUT에 기록한다.
새 결과 판정은 `git/branchSquashResult.ts`에 분리했다. 이번 제품 변경 세 파일은 모두 600줄 이하다.

## 기능 검증

이전 소스에서 서로 다른 9개 재현 사례가 실패했다. 첫 실행은 16건 중 기존 10건 통과·새 6건 실패,
두 번째 실행은 8건 모두 실패했으며 앞 실행과 5건이 중복된다. 실제 Native checkout/commit/stash와
파일·index·ref 비교로 잘못된 변경 또는 복구 손실을 확인했다.

수정 후 최종 소스에서 21개 파일의 189건이 통과했다. 집중 검증 47건과 회귀 검증 142건은
테스트 파일이 중복되지 않는다.

| 확인할 동작 | 증거 |
| --- | --- |
| 자동 commit 전 외부 checkout/commit 차단, 결과의 직접 부모 검증 | `branchSquashCompletionSafety.test.ts` |
| 변경 없는 같은 tip·같은 source·조상 squash 뒤 이전 Undo 유지 | 위 파일의 clean/dirty 6가지 경우, ref·index·Undo 계획 비교 |
| compact 결과 실패 보존·파일 복원·복원 실패 후 재시도 | `branchSquashWorktree.test.ts`의 commit/snapshot/index 조회/materialization 실패 |
| SHA-256와 log 표시 설정, 정상 tree·부모·메시지, staged/unstaged/untracked 보존 | 위 두 파일 및 `branchSquashIndex.test.ts`, `branchOperationSafety.test.ts` |
| stash 전 checkout 변경 차단, 원래 branch upstream으로 계획 생성 | `branchSquashCompletionSafety.test.ts`, `rebasePlanRangeReuse.test.ts` |
| rebase 시작·충돌·완료·재개, readiness 오류와 promisor 순서 | `branchRebase*`, `operationReadiness`, `rebaseStartScope`, `rebaseSessionScope` 검증 |
| Undo 소유권, index lock 안의 ref 재검증, checkout·push·pull·fetch | `completedOperationOwnership`, `operationResultReset`, `operationMetadata*`, `operationSnapshotIdentity`, `branchSync*` 검증 |

정확한 파일 목록과 실행별 결과는 [검증 기록](branch-stability-verification-20261030.json)에 있다.
타입 검사, compile, `git diff --check`가 통과했다. 기존 ESLint 의존성·설정 부재(exit 127)는
이번 작업 범위에서 변경하지 않았으며 lint를 재실행하지 않았다.

## 성능 비교 방법

`branchOperationService.ts`만 작업 시작 시 사본으로 바꾼 번들과 현재 번들을 비교했다.
새 `branchSquashResult.ts`는 현재 서비스에서만 참조된다. 각 사례는 같은 1천 기본 파일 fixture에서
source당 워밍업 1회 후 ABBA 3회를 실행했다. Native 작업 전체와 Undo 준비·실행을 분리 측정한다.
모든 표본에서 정확한 tree·부모·HEAD, index/로컬 편집·untracked 파일·config·stash·worktree 정리와
Undo/snapshot 제거를 확인한다. 준비와 결과 검증은 측정 시간에서 제외한다.

48개 측정과 8개 워밍업이 모두 완료됐다. Git 호출 수는 모든 표본에서 아래 값과 같았다.

| 작업 | Git 호출 전 → 후 | 작업 시간 중앙값 전 → 후(ms) | 변경 이유 |
| --- | ---: | ---: | --- |
| clean squash | 12 → 13 | 552.7 → 574.8 | 자동 commit 직전의 새 checkout 검증 |
| dirty squash | 27 → 25 | 1,160.3 → 1,118.0 | 직접 부모 검증과 결과 OID 조회를 결합, 중복 조회 제거 |
| clean rebase | 14 → 14 | 687.3 → 597.6 | 실행 경로가 같은 대조 사례 |
| dirty rebase | 23 → 24 | 1,765.6 → 1,270.3 | stash 직전의 새 checkout 검증 |

dirty squash 중앙값은 약 3.6% 낮지만, 표본 구간이 겹치고 같은 경로인 clean rebase도
크게 움직였다. dirty rebase는 호출이 늘었는데도 시간의 중앙값이 낮아졌다. 이 결과를
일관된 전체 실행 시간 개선으로 해석하지 않는다. 재현 가능한 성과는 불필요한 Native 호출
2회 제거와 no-change 작업의 조기 종료이며, 안전 검사 1회 추가 비용도 그대로 보존했다.
Undo 준비는 모두 5회, Undo 실행은 모두 21회로 유지됐다.

변경 없는 동일 tip squash는 별도 회귀 검증에서 Git 조회 3회와 쓰기·worktree 생성 부재를 확인했다.
이전 dirty 동일 tip 재현에서는 8회였다. 그 외 no-change 경로는 Native merge의 판단을 유지한다.

원시 표본과 변경 전 원문·소스/번들 checksum은 [전후 비교 자료](branch-stability-paired-20261030.json)에 있다.
현재 제품 소스 531개의 지문은
`f6906a2b032344a57e5e7a82d5ee033b39af9111d4890358c90e8bc3152e5db7`이며,
benchmark 전후 지문 및 변경 후 overlay checksum과 일치한다.

```sh
GSC_BENCH_RECOVERY_BASELINE=docs/benchmarks/branch-stability-paired-20261030.json \
GSC_BENCH_RECOVERY_FILES=src/git/branchOperationService.ts \
  node scripts/benchmark-branch-recovery.mjs /tmp/branch-stability-rerun.json
```

이 측정은 파일 cache가 따뜻한 로컬 합성 저장소에 한정한다. VS Code 화면, 설치된 확장,
외부 네트워크, Native Git/OS CPU와 RSS 성능은 측정하지 않았다. Node CPU 원시값은 별도로 보존한다.
새 검사는 쓰기 경계에서 Native 상태를 다시 읽으며, 모든 외부 writer에 대한 저장소 전체의
원자적 트랜잭션을 주장하지 않는다.
