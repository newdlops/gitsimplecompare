# 브랜치 머지·리베이스의 복구 조회 통합 — 2026-10-30

이 문서는 2차 변경의 기록이다. 이후의 worktree 적용 범위 확대와 interactive rebase
계획 최적화는 [최종 후속 보고서](branch-optimization-20261030.md)에 있다.

브랜치와 PR의 공통 Undo 기록에서 snapshot commit과 현재 HEAD·브랜치·Git 디렉터리를
한 `rev-parse`로 읽도록 바꿨다. 각 쓰기 경계에서 새로 조회하며 결과를 캐시하지 않는다.
깨끗한 squash와 rebase의 Git 호출을 각각 1회, 로컬 변경이 있는 rebase는 2회 줄였다.
Undo 계획 준비와 승인된 Undo 실행도 각각 1회 줄었다.

[앞선 worktree 최적화](branch-operations-20261030.md)는 1만 파일 dirty squash에서
약 69.7%의 시간 단축을 측정했다. 이번 후속 변경은 공통 조회 비용을 줄이는 작업이며,
일반 머지·리베이스의 일관된 실행 시간 단축을 입증했다고 주장하지 않는다.

## 동작과 보호 조건

- Native Git이 snapshot을 `^{commit}`으로 검증하고, 저장된 시작 OID와 일치하는지 확인한다.
  snapshot 교체·삭제·잘못된 타입·조회 실패는 복구 기록을 보존한 채 중단한다.
- 복구 JSON의 ref는 확장 전용 namespace와 안전한 문자로 제한한다.
  revision 표현이나 옵션을 snapshot으로 받아들이지 않는다.
- 기록의 Git 디렉터리와 현재 checkout의 디렉터리를 비교한다. 같은 브랜치·OID를 가진
  다른 저장소로 `.git`이 연결되어도 capture와 prepare가 새 디렉터리를 소유하지 않는다.
- 기존 expected HEAD, 브랜치, index, rebase/cherry-pick 세대 검증은 유지한다.
  완료 직전의 외부 커밋을 이 작업의 Undo 결과로 기록하지 않는다.
- 기존 checkout API의 반환 형식을 유지한다. linked worktree, Unicode 브랜치,
  개행·공백 경로, CRLF 출력, SHA-256, detached HEAD와 HEAD라는 태그를 검증한다.

## 교차 측정

[원시 보고서](branch-recovery-paired-20261030.json)는 두 모듈의 변경 전 원문·전후 SHA-256,
두 번들의 SHA-256과 공통 제품 소스 530개 파일의 지문을 포함한다. 비교 번들은
`repositoryIdentity.ts`와 `operationUndoStore.ts`만 다르다. 두 모듈의 변경 전 원문이
`7911b3c`의 파일과 같은지도 확인했다. 나머지 코드는 앞선 worktree/index 최적화를
포함한 동일한 작업 트리다. 따라서 최초 기준 버전 전체와의 비교는 아니다.

시나리오별로 기본 파일 1,000개와 보조 파일이 있는 동일 임시 저장소를 사용했다.
각 source를 1회 워밍업한 뒤 ABBA를 3번 반복해 source당 6개 표본을 얻었다.
짝수 중앙값은 가운데 두 값의 평균이다. 저장소 준비와 Native 사후 검증 시간은 제외한다.
각 표본은 실제 서비스의 작업, Undo 준비, Undo 실행을 각각 측정한다.
Undo가 원래 HEAD와 로컬 편집을 복원하므로 다음 표본의 입력 상태가 같다.

| 작업 | Git 호출 변경 전 → 후 | 시간 중앙값 변경 전 → 후(ms) |
| --- | ---: | ---: |
| 깨끗한 squash | 13 → 12 | 444.1 → 443.1 |
| 로컬 변경 포함 squash | 21 → 20 | 4,490.8 → 2,707.2 |
| 깨끗한 rebase | 15 → 14 | 768.7 → 854.3 |
| 로컬 변경 포함 rebase | 25 → 23 | 4,643.1 → 4,284.1 |
| Undo 준비, 네 시나리오 모두 | 6 → 5 | 시나리오별 원문 참조 |
| 승인된 Undo 실행, 네 시나리오 모두 | 22 → 21 | 시나리오별 원문 참조 |

호출 수는 각 source의 모든 6개 표본에서 동일했다. 시간 변동은 크다. 예를 들어
변경 전 dirty squash는 약 2.6~13.0초에 걸쳤고, 깨끗한 rebase와 일부 Undo는
변경 후 중앙값이 더 느렸다. 외부 머신 부하는 통제하지 않았으므로 위 시간 차이를
조회 통합만의 효과나 일반적인 체감 속도 개선으로 해석하지 않는다.

48개 측정 표본과 8개 워밍업에서 최종 tree·HEAD·정확한 부모, 로컬 편집·untracked 파일,
빈 index, stash 정리, 설정 불변, 임시 worktree 정리, Undo 복원과 snapshot 제거를 확인했다.
VS Code UI·네트워크 시간은 포함하지 않는다. 기록된 CPU는 Node 프로세스만의 값이며,
Git/OS CPU나 전체 메모리 개선은 측정하지 않았다.

```sh
GSC_BENCH_RECOVERY_BASELINE=docs/benchmarks/branch-recovery-paired-20261030.json \
  node scripts/benchmark-branch-recovery.mjs /tmp/branch-recovery-rerun.json
```

위 명령은 보고서에 보존한 두 파일의 원문을 같은 harness에 연결한다.
나머지 제품 소스가 달라지면 지문도 달라지므로 현재 보고서와 별도 실행으로 비교해야 한다.

## 회귀 검증

조회·경로·리베이스 실행·push 검증 35개와 후속 복구 회귀 128개가 모두 통과했다.
두 실행에서 중복한 사례를 제외하면 17개 파일의 161개 사례다. 후속 실행에는
capture뿐 아니라 prepare 도중 Git 디렉터리가 교체되는 추가 사례도 포함한다.
외부 커밋, 새 충돌/rebase, 오래된 Undo 계획, staged 변경, PR replay/revert,
복구 실패와 linked worktree의 소유 범위를 실제 임시 저장소에서 확인했다.

`npm run check-types`, `npm run compile`, `git diff --check`가 통과했다.
기존 ESLint 의존성·설정 부재로 lint는 사용할 수 없다. 앞선 실행의 exit 127을
그대로 기록했으며 이번에는 재실행하지 않았다. 최종 소스 지문이 측정 당시와 같은지도
확인했다. 명령 대상·결과·checksum은 [검증 기록](branch-recovery-verification-20261030.json)에 있다.
