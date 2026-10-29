# 브랜치 squash·리베이스 계획 최적화 — 2026-10-30

이 문서는 해당 최적화 단계의 기록이다. 이후의 쓰기 경계·실패 복구·변경 없는 작업 처리는
[브랜치 안정화 보고서](branch-stability-20261030.md)에 있다. 아래 지문과 측정값은 이 단계의 소스 기준이다.

최종 작업 트리에서는 브랜치 squash의 compact worktree 적용 하한을 5,000항목에서
1,000항목으로 넓혔다. PR replay의 하한과 공통 안전 조건은 유지했다. 또한 interactive
rebase 계획이 이미 읽은 선형 범위로 onto 포함 여부를 판단하고 중복 브랜치·범위 조회를
생략하도록 바꿨다. 두 변경 모두 Native Git의 병합·재작성 엔진을 그대로 사용한다.

최종 제품 소스 지문은 530개 파일의
`af80ee38017575bdcc4ad1517e72e5792a3e7bcdcd2249faaf321744a35d0574`다.
아래 두 비교는 이 같은 제품 소스에서 각각의 변경 모듈만 이전 내용으로 되돌린 번들과
현재 번들을 비교한다. 각 보고서에 변경 전 원문과 전후 checksum, 번들 checksum을
보존한다. 저장소 최초 기준 버전 전체와의 누적 비교나 설치된 확장의 측정은 아니다.

## 중간 크기 저장소의 dirty squash

원본 index의 크기 힌트뿐 아니라 새 worktree의 실제 index 항목 수도 1,000 이상이어야
한다. 50,000항목·경로 출력 한도, submodule, hook, filter, merge driver, 조건부 설정,
특수 index와 사용자 Git 환경의 기존 제한은 유지한다. PR replay는 계속 5,000 이상이다.
충돌이면 생략한 파일을 펼쳐 복구할 수 있게 하고, 원본 staged/unstaged/untracked 파일과
실패한 복구용 worktree를 보존한다.

같은 fixture에서 전후 각각 워밍업 1회 후 ABBA를 3번 반복했다. 각 source당 6개 표본이다.
기본 파일 수 외에 사용자 편집과 분기 변경을 위한 보조 파일이 있다. 작업 전체의 Native
완료, Undo 준비와 실행을 각각 측정하고, Undo로 다음 표본의 원래 HEAD와 편집을 복원했다.

| 기본 파일 수 | 작업 중앙값 변경 전 → 후(ms) | Git 호출 전 → 후 | 해석 |
| --- | ---: | ---: | --- |
| 100 | 982.3 → 950.9 | 20 → 20 | 전체 checkout 유지, 대조 사례 |
| 1,000 | 1,454.4 → 1,112.8 | 20 → 27 | 약 23.5% 단축 |
| 2,500 | 2,557.8 → 1,033.4 | 20 → 27 | 약 59.6% 단축 |
| 10,000 | 1,287.5 → 1,125.3 | 27 → 27 | 기존 compact 경로 유지, 대조 사례 |

worktree 생성·제거 Git 시간의 합계 중앙값은 1천 파일에서 614.5→88.5ms,
2,500파일에서 1,416→78.5ms였다. 설정·index 검증에 필요한 호출이 7개 늘지만
전체 파일 생성·삭제 I/O를 줄인다. Node CPU 중앙값은 각각 52.3→80.5ms,
53.7→67.5ms로 증가했다. Native Git/OS CPU는 포함하지 않으므로 전체 CPU 감소를 주장하지 않는다.

독립된 [예비 측정](branch-worktree-threshold-pilot-20261030.json)에서도 1천 파일은
1,362.9→767.1ms, 2,500파일은 2,096.1→1,011.4ms였다. 최종 실행의 느린 값도 보존했다.
동작이 같은 100/10,000파일 대조 사례에서도 시간이 움직였으므로 외부 머신 부하와
작은 표본의 영향을 고려해야 한다. 범위 밖 크기나 hook/filter가 필요한 저장소에 이 비율을 적용하지 않는다.
[최종 원시 표본](branch-worktree-threshold-final-20261030.json)

48개 측정과 8개 워밍업 모두 Native tree·정확한 부모·HEAD, index와 로컬 편집,
untracked 파일, config, stash 정리, worktree 정리, Undo와 snapshot 제거를 확인했다.

## Interactive rebase 계획 준비

- 최초 checkout에서 읽은 브랜치를 재사용하고, 커밋 범위를 같은 전체 HEAD OID로 고정한다.
  준비 중 HEAD가 다른 커밋으로 갔다 돌아와도 다른 이력의 파일 목록을 섞지 않는다.
- 각 항목의 유일한 부모가 바로 앞 항목이며 첫 부모가 base인 경우만 선형으로 판단한다.
  root 계획은 첫 항목에 부모가 없어야 한다. merge DAG에서는 기존 Native 조상 판정을 유지한다.
- 같은 범위의 전체 onto OID는 존재/포함 조회를 생략한다. 축약 OID나 다른 ref는 Native로
  정규화한다. 외부 onto, 빈 upstream 범위, 잘못된 선택과 최종 checkout 변경 검증을 유지한다.
- upstream 범위의 커밋 수를 따로 세지 않고 실제 읽은 목록으로 빈 범위를 확인한다.
  부모 조회 실패를 root 선택으로 오인하던 경로도 중단하도록 했다.

기본 1천 파일·1천 공통 커밋 뒤의 6개 또는 60개 독립 변경을 사용했다. 같은 fixture에서
source당 워밍업 1회와 ABBA 3회(각 6표본)를 실행했다. 전체 계획과 파일 목록을 반환하는
`prepareCurrentBranchPlan`만 측정했으며, 재작성 시간이나 화면 렌더링 시간은 아니다.

| 계획 | 중앙값 변경 전 → 후(ms) | Git 호출 전 → 후 | 단축 |
| --- | ---: | ---: | ---: |
| 선택한 6커밋의 순서 변경 | 432.9 → 301.1 | 11 → 7 | 30.4% |
| upstream 기준 6커밋 | 520.3 → 293.0 | 11 → 6 | 43.7% |
| 다른 분기로 옮길 6커밋 | 506.6 → 362.9 | 11 → 8 | 28.4% |
| 선택한 60커밋의 순서 변경 | 428.8 → 267.6 | 11 → 7 | 37.6% |

48개 측정과 8개 워밍업에서 전후 전체 plan 객체가 같고, Native OID·fixture의 파일 내용과
일치했다. index/config는 바이트 단위로 같았다. 측정 뒤 각 source의 실제 `Start`로
네 계획을 모두 실행한 8건에서도 tree·부모·메시지 순서·clean 상태가 일치했다.
[리베이스 원시 표본](rebase-plan-range-reuse-20261030.json)

## 재현과 이전 단계

```sh
GSC_BENCH_RECOVERY_BASELINE=docs/benchmarks/branch-worktree-threshold-final-20261030.json \
GSC_BENCH_RECOVERY_FILES=src/git/replayWorktree.ts,src/git/replayWorktreePolicy.ts \
GSC_BENCH_RECOVERY_COUNTS=100,1000,2500,10000 \
  node scripts/benchmark-branch-recovery.mjs /tmp/branch-worktree-rerun.json

GSC_BENCH_PLAN_BASELINE=docs/benchmarks/rebase-plan-range-reuse-20261030.json \
  node scripts/benchmark-rebase-plan.mjs /tmp/rebase-plan-rerun.json
```

두 benchmark의 저장소 생성·Native 사후 검증·정리는 측정에서 제외한다.
사용자 저장소나 외부 원격에 쓰지 않는다. OS 파일 cache가 따뜻한 로컬 합성 입력이며,
VS Code 창·네트워크·전체 CPU·RSS 성능은 검증 범위에 포함하지 않는다.

[1차 대형 squash/index 보존](branch-operations-20261030.md)과
[2차 공통 Undo 조회 통합](branch-recovery-20261030.md)의 변경도 현재 작업 트리에 유지한다.
이전 보고서의 크기 하한·소스 지문·측정값은 해당 단계의 기록이다.

## 최종 검증

제품 소스 변경 이후 집중 검증 42건과 최종 회귀 검증 173건이 모두 통과했다.
두 실행은 `branchSquashWorktree`를 중복 포함하므로 합계를 고유 테스트 수로 쓰지 않는다.
총 19개 테스트 파일에서 다음 경계를 확인했다.

- 1천 항목의 실제 index 경계, 1천/5천 파일 squash의 정확한 Native tree와 부모,
  staged/unstaged/untracked 보존, 충돌 파일 복원, 실패한 worktree 보존.
- hook/filter/merge driver·조건부 hook 설정의 전체 checkout 유지와 기존 PR replay 동작.
- 선형/merge DAG/root/upstream/외부 onto, 축약 OID, SHA-256, Unicode 브랜치,
  준비 중 브랜치 전환·HEAD 왕복과 부모 조회 실패의 안전한 처리.
- rebase 시작·재개·완료, 브랜치 동기화, Undo 소유권, PR 복구와 재시도.

`npm run check-types`, `npm run compile`, `git diff --check`도 통과했다.
ESLint 의존성·설정이 없어 기존 lint 실행은 exit 127이었으며 이번 단계에서 반복하지 않았다.
UI 변경이 없는 서비스 최적화로, VS Code 실제 화면이나 설치된 확장의 체감 성능은 측정하지 않았다.

최종 제품 소스 530개와 두 benchmark 지문이 일치하고, 각 overlay의 변경 전 원문과
변경 후 파일 checksum을 다시 대조했다. 변경한 제품 모듈은 모두 600줄 이하다.
정확한 테스트 파일·표본 수·checksum은 [검증 기록](branch-optimization-verification-20261030.json)에 보존했다.
