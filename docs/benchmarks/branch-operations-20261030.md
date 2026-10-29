# 브랜치 스쿼시·리베이스 최적화 — 2026-10-30

아래는 compact worktree와 index 보존을 적용한 1차 측정이다. 이후 공통 Undo 조회를
통합한 변경과 교차 측정은 [후속 보고서](branch-recovery-20261030.md)에 별도로 기록했다.

로컬 수정이 있는 1만 파일 저장소의 스쿼시 머지는 최종 측정에서 중앙값
3,595.5ms → 1,090.7ms로 약 69.7% 단축됐다. 리베이스는 보존한 로컬 변경을
복원할 때 중복 HEAD 조회 하나를 제거했다. 일반 머지·리베이스의 실행 시간이나
전체 CPU·메모리가 줄었다는 주장은 하지 않는다.

## 변경과 보호 조건

- 브랜치 squash의 격리 worktree도 기존 PR replay의 index 준비를 재사용한다.
  일반 index의 5,000~50,000개 항목에서만 전체 checkout을 생략하고,
  실제 병합·커밋은 Native `merge --squash`와 `commit`으로 수행한다.
- 훅·외부 필터·merge driver·특수 index 등 기존 정책이 지원하지 않는 조건은
  전체 checkout을 사용한다. 새 detached worktree의 조건부 설정도 다시 확인한다.
  브랜치 merge의 상대 hook 경로는 전체 분기 이력을 마지막 patch로 추정하지 않는다.
- 충돌 시 생략한 파일을 펼쳐 복구 경로를 제공한다. 충돌 검사나 파일 복원 실패,
  worktree 잠금 오류가 있어도 등록된 복구 작업트리를 파일시스템 강제 삭제로 없애지 않는다.
- 병합 대상은 처음 확인한 로컬 브랜치 OID로 고정한다. 준비 중 ref가 이동하거나
  같은 이름의 tag가 있어도 다른 커밋을 병합하지 않는다.
- 격리 결과를 반영할 때 실제 index lock 아래에서 staged 추가·수정·삭제·rename·mode를
  보존한다. PR도 같은 구현을 사용한다. 경로는 원본 바이트를 유지하며, 겹침 검사는
  모든 경로 조합 대신 경로와 상위 디렉터리 집합을 사용한다.
- 리베이스 완료 후 브랜치+HEAD 검증을 유지하고, 방금 검증한 HEAD를 stash 복원 기록에
  재사용한다. 외부 commit/checkout 감지와 중복 stash 적용 방지는 그대로 검증한다.

원래 staged 변경이 이제 결과 반영 후에도 남으므로 기존 Undo의 staged 변경 보호가
적용된다. Undo가 이를 지우지 않고 중단하는지, 사용자가 명시적으로 unstage한 뒤에는
로컬 파일을 보존하면서 Undo할 수 있는지도 확인했다.

## 측정 범위와 결과

기준 source는 `7911b3c84c8d3f1e5b6178c0811650995f756f05`, 1차 최종 source는
[검증 기록](branch-operation-verification-20261030.json)의 파일 checksum을 가진 작업 트리다.
동일 harness를 source별로 번들해 별도 프로세스에서 직렬 실행했다. 각 시나리오는
독립된 임시 저장소의 워밍업 1회와 측정 3회를 사용한다. 100 또는 10,000개의 기본
파일에 보조 파일을 더하며, 사용자 저장소·외부 원격에는 쓰지 않는다.

fixture 준비와 최종 Native 검증은 시간에서 제외한다. 서비스의 준비·Git 실행·복구
기록·임시 worktree 정리는 포함한다. VS Code 전송·렌더링 시간은 포함하지 않는다.
모든 표본에서 최종 tree, 부모/조상, HEAD, 로컬 파일, index, stash, config와 임시
worktree 정리를 검증했다.

| 시나리오 | 기준 → 최종 중앙값(ms) | Git 호출 기준 → 최종 |
| --- | ---: | ---: |
| 100파일·로컬 수정·squash | 512.7 → 521.7 | 17 → 21 |
| 1만 파일·로컬 수정·squash | 3,595.5 → 1,090.7 | 17 → 28 |
| 1만 파일·깨끗한 squash | 368.4 → 1,014.4 | 13 → 13 |
| 1만 파일·로컬 수정·rebase | 1,005.3 → 1,102.2 | 26 → 25 |

대형 dirty squash의 worktree 생성·제거 Git 구간 중앙값은 2,824ms → 58ms다.
생략된 파일의 부재를 실제 commit 직전에 확인하고, 최종 tree가 Native 결과와 같은지도
확인했다. 보호 검사가 추가되어 Git 호출과 Node CPU는 늘었다. 이 시나리오의 Node CPU
중앙값은 35.5ms → 95.2ms이며 Native Git/OS CPU를 포함하지 않는다.

원시 표본: [기준](branch-squash-baseline-20261030.json),
[초기 후보](branch-squash-current-20261030.json),
[최종 후보](branch-squash-final-20261030.json).
초기 후보의 대형 dirty squash는 623.1ms였다. 느린 최종 표본도 그대로 보존한다.
외부 머신 부하를 통제하지 않은 작은 표본이며, 다른 경로의 시간 개선은 입증하지 못했다.

깨끗한 squash의 큰 시간 변동은 별도로 분리 확인했다. 현재 source·동일 저장소에서
기존 branch 인자 control과 고정 OID를 ABBA 순서로 각각 6회 실행했다. 상위 중앙값은
451.5ms와 473.3ms, Git 호출은 양쪽 모두 13회였다. 입력 변경만으로 전체 비교에서의
약 3배 차이가 재현되지는 않았다. 이는 같은 source의 입력 control이며 이전 버전
전체나 실제 앱의 성능 비교를 대체하지 않는다.
[입력 control 원본](branch-squash-clean-control-20261030.json)

```sh
GSC_BENCH_SOURCE_REF=7911b3c node scripts/benchmark-branch-squash.mjs /tmp/branch-before.json
node scripts/benchmark-branch-squash.mjs /tmp/branch-after.json
GSC_BENCH_INPUT_CONTROL=1 node scripts/benchmark-branch-squash.mjs /tmp/branch-clean-input.json
```

## 회귀 검증

25개 파일의 244개 사례를 실행했다. 기존 PR Undo 테스트 두 개는 결과 반영 과정에서
staging이 사라지는 동작을 전제로 해 실패했다. staging 보존, Undo 거부 전후의 상태
불변, 명시적 unstage 후 Undo를 검사하도록 수정했다. 마지막 변경과 추가 사례를
포함한 5개 파일 52개 사례는 모두 통과했다. 중복을 제외한 검증 범위는 26개 파일,
247개 사례다. 명령 대상·실행 결과·최종 source checksum은
[검증 기록](branch-operation-verification-20261030.json)에 있다.

`npm run check-types`, `npm run compile`, `git diff --check`는 통과했다.
`npm run lint`는 기존 저장소에 ESLint 의존성과 설정이 없어 `eslint: command not found`
(exit 127)로 실행되지 않았다. 브라우저 시각 검사나 설치된 확장 성능은 측정하지 않았다.
