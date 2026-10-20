# 0.1.72117 중복 staging·변경 판정 제거 검증

기준은 0.1.72116 commit `11049b391e6a846ab697dd7301a44bd05a2d881c`다.
제품 변경은 Git 모듈 세 개이며 Graph HTML·CSS·frontend JS는 바꾸지 않았다.
**staged 판정과 branch squash의 제한된 경로를 채택했다. 전체 Graph 지연 개선은 입증하지 못했다.**

## 동작과 보호 경계

PR의 pending-change 조회는 index부터 확인하고 staged 변경이 있으면 작업 파일 재조회를
생략한다. 두 변경이 상쇄돼 HEAD와 작업 파일이 같아도 staged 변경은 보존한다.
일반 merge-tree fast path는 이미 이 판정을 건너뛰므로 이 조회 개선을 모든 PR 실행의
개선율로 바꾸어 해석하지 않는다. replay fallback의 `hasPendingChangesIn`과 공통 공개 판정이 대상이다.

index 비교는 fsmonitor를 끄고 외부 diff·textconv를 실행하지 않는다.
차이의 exit 1만 true로 바꾸고 timeout·권한·손상 index 오류는 그대로 전파한다.
staged gitlink는 표시용 ignore 설정으로 숨기지 않는다.
옵션의 의미는 [Git diff 문서](https://git-scm.com/docs/git-diff)에서 확인했다.

branch squash는 Native merge가 만든 index를 그대로 commit한다.
작업 파일을 다시 stage하는 `git add -A`를 현재·임시 worktree 양쪽에서 제거했다.
merge 직후 생긴 다른 tracked/untracked 편집이 commit에 섞이지 않는다.
[Git merge 문서](https://git-scm.com/docs/git-merge)는 squash 결과에 index가 포함됨을 설명하며,
실제 rename·추가 파일의 최종 tree를 Native 원본과 대조했다.

현재 HEAD/브랜치 검증, 충돌 검사, snapshot·Undo·stash와 결과 적용 보호는 유지했다.
새 cache·타이머·의존성은 추가하지 않았다.

## 같은 프로세스의 교대 비교

Node v22.22.2, tracked 파일 1,000개의 같은 fixture에서 두 source를 별도 모듈로 읽었다.
각 1회 워밍업 뒤 전후 순서를 바꿔 5회씩 실행했다. GC는 측정 밖에서 실행했다.
branch squash는 매번 원래 HEAD로 돌아가고 새 monitor 정책으로 시작했다.
따라서 이 표의 cold service Git 수와 뒤 Graph 행렬의 warm service 수는 1회 차이가 있다.

읽기는 Native status와 같은 결과이며 index bytes가 보존됐다.
쓰기인 branch squash는 Native source tree와 결과 tree가 같은지 확인했다.
JSON의 해당 행 indexPreserved=false는 읽기 전용 불변 검사가 적용되지 않는다는 뜻이다.

| 경로 | 경과 ms 중앙값 | 호출 Node CPU ms 중앙값 | Git 수 중앙값 |
| --- | ---: | ---: | ---: |
| staged | 248.333 → 122.928 | 5.507 → 3.023 | 2 → 1 |
| unstaged | 384.926 → 347.506 | 4.547 → 5.067 | 2 → 2 |
| clean | 597.987 → 493.444 | 5.852 → 6.444 | 2 → 2 |
| cancelling | 228.267 → 110.722 | 5.033 → 2.898 | 2 → 1 |
| branch-squash | 4412.425 → 3955.450 | 60.509 → 54.904 | 18 → 16 |

staged와 상쇄 상태는 조회 수가 2→1이며 호출 Node CPU도 감소했다.
branch squash의 Git 수는 모든 측정에서 18→16이었다.
이 경로에서 중복 add 1회와 monitor 설정 준비 1회가 없어졌고, status 한 번은
index-only diff로 바뀌었다. 최종 tree는 같았다.
unstaged·clean은 Native 조회 두 번을 유지하며, 호출 Node CPU 중앙값은 각각
약 0.52ms·0.59ms 증가했다. 모든 경로의 CPU가 줄었다고 주장하지 않는다.
Node CPU는 Native Git·브라우저·전체 확장의 CPU를 포함하지 않는다.

최종 제품 세 파일의 SHA-256이 교대 측정 source와 같은 것을 확인했다. 값은 JSON에 있다.
교대 비교의 루프를 CLI로 옮겨 `scripts/benchmark-tracked-changes-paired.mjs`로 보존했다.
표의 원본은 매개변수화 전 진단 드라이버의 5회 결과이며, 보존한 CLI는 별도 staged 1회
smoke로 source 선택·출력·정리 경로를 확인했다.

재현: `GSC_BENCH_SOURCE_REF=11049b3 node --expose-gc scripts/benchmark-tracked-changes-paired.mjs <result.json>`.
기본 각 5회이며 홀수 `GSC_BENCH_SAMPLES`와 `GSC_BENCH_MODES`로 일부 경로를 선택할 수 있다.

## 순차 표본과 실제 Git·Graph

초기 독립 프로세스의 각 5회 비교도 JSON에 보존했다.
staged는 372.215→212.728ms였으나 clean은 302.398→750.755ms로 느렸다.
후속 단일 작업 행렬에서도 아래와 같이 느린 경우가 있어 같은 fixture의 교대 비교를 추가했다.
이전 표본을 지우거나 전체 속도 향상으로 보고하지 않는다.

파일 1,000개·기본 commit 1,000개·곁가지 300개·main upstream 브랜치 8개, 로컬 bare
원격과 monitor 정책을 사용했다. 회귀 검사와 다른 benchmark가 끝난 뒤 순차 실행했다.
각 행은 기준·최종 각 1회다. 단위는 ms, 값은 기준 → 최종이다.
행렬의 merge는 branch squash이며 merge-no-ff는 Native 일반 merge다.

| 작업 | 작업 자체 | 첫 Graph frame | 최종 Graph frame | 작업 Git 수 | 호출 Node CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| push | 5986 → 5723 | 693 → 1197 | 1039 → 1494 | 19 → 19 | 229 → 240 |
| fetch-new-history | 992 → 1675 | 1117 → 1279 | 1980 → 1626 | 1 → 1 | 166 → 193 |
| pull | 1582 → 2635 | 687 → 1593 | 687 → 1593 | 4 → 4 | 124 → 217 |
| fetch | 473 → 685 | 577 → 1249 | 703 → 2216 | 1 → 1 | 108 → 189 |
| rebase | 4789 → 7327 | 814 → 1575 | 1212 → 2764 | 16 → 16 | 221 → 383 |
| merge | 2785 → 8715 | 909 → 2007 | 1323 → 2490 | 17 → 15 | 179 → 407 |
| merge-no-ff | 583 → 516 | 1111 → 2348 | 1503 → 3235 | 1 → 1 | 217 → 231 |
| pr-squash-cherry-pick | 5791 → 5398 | 963 → 1409 | 1696 → 1769 | 24 → 24 | 292 → 284 |
| pr-cherry-pick | 18414 → 4425 | 2260 → 890 | 5438 → 1432 | 26 → 26 | 666 → 336 |
| cherry-pick | 661 → 616 | 1324 → 956 | 2769 → 1503 | 1 → 1 | 272 → 240 |
| checkout | 1541 → 384 | 890 → 614 | 890 → 614 | 3 → 3 | 140 → 176 |

모든 11개 작업이 성공했고 Native 새 조회의 HEAD·부모·refs와 host 결과가 같았다.
실제 300행 DOM의 HEAD·refs·local-only 표시는 host와 일치했다.
최종 frame은 정확한 게시 traceId·kind·sentAt의 ACK를 사용해 첫 history frame과 구분했다.
최대 동시 Git은 양쪽 모두 4개였다. 전체/Graph Git 수와 후속 완료 시간도 JSON에 있다.

단일 merge 표본은 작업 2.79→8.72초로 느렸다. 수정하지 않은 pull/fetch 등에도 증가가
관측됐으므로 이 행렬로 인과적 속도 개선율을 산출하지 않는다.
후속 교대 서비스 비교의 4.41→3.96초를 Graph 완료 시간으로 바꾸어 보고하지 않는다.
이번 변경만으로 전체 UI 지연 목표를 달성했다는 증거는 없다.

## 검사 결과와 한계

- 처음 작은 묶음은 16개 통과·1개 실패였다. 테스트가 worktree add를 git add로
  잘못 분류한 기대값을 command 위치로 고쳐 재검증했다.
- 긴 관련 묶음은 **66개 완료 후 900,000ms 제한으로 종료**됐다. 기록된 기능 실패는 0개지만
  전체 통과는 아니다. 이 묶음은 최종 staged-only/submodule 보강 전 source였다.
- 최종 source에서 미완료 PR 복구 4개와 변경 판정·branch 검사 19개를 worker 1개로
  선별 실행해 **23개 통과, 실패·취소·skip 0개**를 확인했다.
  단계별 고유 완료 항목은 87개이며, 이를 모두 최종 source의 전체 suite 통과로 해석하지 않는다.
- staged/unstaged 상쇄·untracked·rename·binary·intent-to-add·gitlink·외부 diff·textconv,
  monitor 준비 생략·ETIMEDOUT·EACCES·손상 index와 index 불변을 확인했다.
  현재/임시 worktree의 Native tree와 뒤늦은 사용자 편집 보존도 확인했다.
- TypeScript와 production bundle을 통과했다. 390·768·1440px headless 화면을 각각 직접 열어
  확인했고 정상 commit click·Escape도 통과했다. 기존 좁은 폭의 가로 스크롤을 유지했다.
- OS 포커스 이동, visible Extension Host, 강제 reload, 전체 저장소 suite, ESLint,
  새 Axe/밝은 테마 감사, 실제 터치 장치 및 Marketplace 상태 점검은 실행하지 않았다.
- VSIX는 **980,772 bytes**이며 SHA-256은
  `0ffa5d6a432dcb6c2af13779a26b17b5efdc6fdf92e4e27c9caf48b86f9b9b65`다.
  bundle SHA-256은 `13284b55779304ae3772b6fb078bb26ec4d031810cd5e29beeea44408e942f8a`다.
  media·dist·l10n·NLS 124개가 원본과 같고 개발 파일이 제외됐다.
  stash 내용 조회 명령 두 개도 manifest에 유지돼 있다.

전체 push·pull·fetch·rebase·merge·PR·checkout 속도와 Graph 최신화, 안정성·자원 절감 목표는
진행 중이다. 다음에는 첫 frame이 로컬 브랜치 metadata를 기다리는 구간을 검토한다.
원본 표본·source provenance·단계별 검사 이름은 [JSON](tracked-changes-0.1.72117.json)에 있다.
