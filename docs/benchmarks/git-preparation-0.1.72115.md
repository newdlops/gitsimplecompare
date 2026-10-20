# 0.1.72115 Git 준비·후속 상태 조회 검증

기준은 0.1.72114(`cefa3d48748f3be77097abd6747288f1f5e6b1b9`)이다.
같은 harness를 기준 commit과 작업 트리 source에 연결했다. 기준·1차 측정은 버전 변경 전에,
metadata 증거 보강 뒤의 최종 측정은 0.1.72115에서 진행했다. source 종류·commit·번들
SHA-256으로 구현을 구분하며 아래 세 값은 **기준 → 1차 개선 → 최종 보강** 순서다.

## 반복 준비 조회

파일 1,000개·outgoing commit 한 개와 정상 upstream이 있는 임시 저장소를 사용했다.
원격은 로컬 bare 저장소이며 `core.fsmonitor=false`다. 워밍업 1회 뒤 각 5회 표본의
중앙값을 기록했다. 다른 회귀 검사와 겹치지 않게 전후를 순서대로 실행했다.

| 측정 | 경과 시간 ms | 호출 Node CPU ms | Git 프로세스 수 |
| --- | ---: | ---: | ---: |
| push 계획 | 1785.735 → 1417.695 → 637.942 | 13.675 → 10.115 → 8.924 | 4 → 3 → 3 |
| 반복 status | 957.886 → 261.481 → 444.786 | 6.654 → 5.024 → 7.511 | 2 → 1 → 1 |

push 계획은 현재 checkout과 upstream commit을 한 native 조회로 읽는다. branch/ref의
현재 OID와 설정은 계속 새로 검증한다. upstream 부재·모호한 HEAD는 기존 checkout
조회로 돌아가며, timeout·프로세스 접근 오류를 해당 fallback으로 재시도하지 않는다.
실제 단일 outgoing commit push 검사는 계획부터 전송까지 Git 15→13회를 확인했다.

status는 Git이 검증한 index **위치** 한 개만 각 private status index 수명에 보관한다.
원본 index 내용·작업트리 결과는 매번 읽는다. 각 표본 전에 파일을 바꾸고 교대로 staging한
결과가 native 전체 status와 같았으며, 모든 원본 index bytes도 보존됐다. `.git`·commondir·
실행 경로·Git 환경이 바뀌면 위치를 다시 읽고, 결과 게시 전에도 metadata를 대조한다.
증거가 없으면 private index를 사용하지 않는 native 전체 status로 돌아가므로 위 한 프로세스 수치는 정상 metadata의
반복 조회에 해당한다. 공유 status 소비자/캐시의 기존 저장소 수명 제한을 유지한다.

최종 status의 Node CPU 중앙값은 첫 개선 측정보다 증가했다. 모든 실행에서 CPU가
줄었다고 주장하지 않으며, Git 실행 수 감소와 경과 시간을 별도로 평가한다.

Node CPU는 서비스 호출 조립·파일 읽기·파싱 비용만 포함한다. Git·브라우저·전체 확장이나
시스템의 CPU/메모리 수치가 아니다. 경과 시간은 머신 부하와 프로세스 시작 지연의 영향을
받으므로 위 개선율을 다른 저장소·네트워크에 일반화하지 않는다.

재현: `node scripts/benchmark-git-preparation.mjs <result.json>`.
기준 source는 `GSC_BENCH_SOURCE_REF=cefa3d48748f3be77097abd6747288f1f5e6b1b9`을 지정한다.

## 브랜치·PR 시작 검사

branch merge/rebase 및 PR 실행은 checkout과 unmerged index 확인을 함께 시작한다.
두 읽기가 모두 끝난 뒤에만 준비 결과를 사용한다. 기존 native 작업·detached HEAD·충돌
검사와 실제 쓰기 직전의 branch/HEAD 안전 검사를 유지한다. 시작 시 unmerged 조회 오류는
빈 목록으로 바꾸지 않으며, target의 timeout·프로세스 접근 오류도 원래 원인으로 전파한다.
PR의 충돌 stage 조회는 공통 `listUnmergedFiles`를 사용해 불필요한 fsmonitor 준비를 건너뛴다.

## 검증 기준

- push: 계획 확인 후 branch·HEAD·설정 변경 및 lease 보호를 유지한다. source와 destination을
  고정하고 전송 직전 재검증을 생략하지 않는다.
- pull/fetch/checkout: native transfer/switch 횟수와 사용자 변경 보존을 확인한다. 모든 작업의
  후속 상태 조회에서 같은 index 위치 재사용을 적용한다.
- merge/rebase/PR: 완료·충돌·Undo·stash 및 다른 worktree의 소유권 보존을 확인한다. 실패한
  사전 읽기 뒤에는 snapshot/ref 쓰기를 시작하지 않고 이미 시작한 다른 읽기의 종료도 기다린다.
- Graph: 실제 Git 작업 뒤 production HTML/CSP/JS의 HEAD·부모·refs와 native 새 조회를 대조한다.
  표시용 상태 캐시에 과거 index/작업트리 결과를 고정하지 않는다.
- 자원: 준비와 상태 조회의 Git 실행 수를 줄이고, 경로 한 개 외의 새 무제한 캐시나 자동
  유지보수 작업을 추가하지 않는다. 상태 조회만으로 실제 index나 사용자 Git 설정을 변경하지 않는다.

## Git 작업과 Graph

파일 1,000개·기본 commit 1,000개·곁가지 300개와 로컬 bare 원격을 사용했다.
monitor 정책을 켜고 production HTML/CSP/JS를 headless Chromium에 연결했다.
다른 회귀 검사나 성능 측정과 겹치지 않게 실행했다. 각 항목은 기준 1회와 작업 트리
1차·최종 각 1회 표본이며 세 실행을 모두 보존했다.
Graph 갱신과 화면 반영은 Git 작업 완료부터 각각 host 갱신 호출 완료와 실제 renderer
frame 응답까지의 시간이다. 후속 완료는 작업 시작부터 가상 상태·보조 Git 조회가
유휴 상태가 될 때까지의 총시간이다.

| 작업 | 작업 ms | Graph 갱신 ms | 화면 반영 ms | 후속 완료 ms | 총 Git 수 |
| --- | ---: | ---: | ---: | ---: | ---: |
| push | 3603 → 5175 → 3377 | 606 → 965 → 382 | 769 → 1104 → 547 | 4665 → 6697 → 4052 | 26 → 25 → 25 |
| fetch-new-history | 998 → 951 → 1144 | 990 → 612 → 848 | 1198 → 731 → 1018 | 3359 → 2214 → 3576 | 13 → 12 → 11 |
| pull | 963 → 1618 → 1903 | 381 → 825 → 453 | 519 → 1045 → 627 | 1719 → 2876 → 3307 | 11 → 10 → 10 |
| fetch | 532 → 771 → 321 | 469 → 683 → 399 | 654 → 876 → 524 | 1692 → 2049 → 1062 | 9 → 8 → 8 |
| rebase | 3750 → 5290 → 3533 | 1201 → 1105 → 727 | 1465 → 1292 → 868 | 7620 → 7384 → 5539 | 29 → 27 → 28 |
| merge | 4005 → 3771 → 3457 | 966 → 814 → 528 | 1193 → 1037 → 650 | 7567 → 5598 → 4720 | 30 → 28 → 29 |
| merge-no-ff | 448 → 410 → 239 | 902 → 721 → 445 | 1112 → 895 → 558 | 3008 → 2486 → 1715 | 14 → 13 → 13 |
| pr-squash-cherry-pick | 4422 → 2579 → 4556 | 559 → 516 → 454 | 716 → 601 → 579 | 6342 → 3656 → 6150 | 37 → 34 → 36 |
| pr-cherry-pick | 4850 → 4344 → 2840 | 988 → 715 → 429 | 1197 → 924 → 592 | 7893 → 6164 → 4168 | 39 → 37 → 38 |
| cherry-pick | 132 → 33 → 38 | 969 → 568 → 731 | 1163 → 682 → 881 | 2701 → 1565 → 1764 | 14 → 13 → 13 |
| checkout | 386 → 988 → 908 | 819 → 1020 → 975 | 1029 → 1328 → 1160 | 2023 → 2874 → 2735 | 11 → 10 → 10 |

모든 11개 경우에서 새 native Git 조회의 HEAD·부모·refs와 host 이력이 같았고,
실제 300행 DOM의 HEAD 배지·refs도 일치했다. 최대 동시 Git 실행은
4 → 4 → 4개였다. 총 Git 수에는 status/config 등 비동기 보조 조회도 포함한다.
cache 만료 시점과 native 프로세스 지연에 따라 일부 값이 달라지므로, 한 표본에서
모든 작업이 빨라졌다고 일반화하지 않는다.

행렬의 push는 upstream이 없는 첫 게시다. 정상 upstream의 준비 최적화는 앞의
반복 측정과 별도 단일 커밋 push 검사로 검증했다. 새 object fetch를 pull보다 먼저
실행하므로 pull 항목은 이미 알려진 원격 이력을 사용한다. 별도 동기화 검사에서도
pull/fetch의 단일 native 전송과 사용자 변경 보존을 확인했다.

재현: `GSC_BENCH_BRANCHES=300 GSC_BENCH_MONITOR_POLICY=1 GSC_BENCH_LIVE_RENDERER=1 GSC_BENCH_OPERATIONS=push,fetch-new-history,pull,fetch,rebase,merge,merge-no-ff,pr-squash-cherry-pick,pr-cherry-pick,cherry-pick,checkout node scripts/benchmark-git-operations.mjs <result.json>`.

## 최종 확인

- 관련 고유 검사 155개 통과. push 50개, 상태 32개 범위를 확인하고, 확장한
  checkout/index 경로 14개 및 시작 검사·충돌 stage 15개를 최종 실행했다. 중복 검사는
  고유 합계에서 제외했다. 복구·동기화 63개와 metadata 증거 보강 뒤 경로/상태 10개도
  완료했다. 첫 상태 묶음의 2개 기대값은
  macOS 경로 별칭을 실제 Git 반환 경로와 대조하도록 고친 뒤 재검증했다. 첫 묶음을
  전체 통과로 보고하지 않는다. 각 실행 수와 통과 이름은 JSON에 보존했다.
- timeout/EACCES 주입 시 다른 준비 읽기가 종료되고 snapshot/ref 쓰기 없이 원래 오류를
  반환했다. HEAD·index는 보존됐다. 이미 진행 중인 Git 작업이 있으면 기존 오류 우선순위를 유지했다.
- HEAD/upstream은 SHA-1·SHA-256, linked worktree, detached, HEAD tag 충돌 및 개행·끝 공백
  경로에서 확인했다. index 위치는 commits/staging, gitfile 교체, Git 환경 변경, 증거 부재,
  실패/취소를 확인했다. sparse/split/linked index, cold scan과 세션 캐시 검사도 완료했다.
- TypeScript와 diff whitespace 검사를 통과했다. frontend 자산은 바꾸지 않았으며, 실제
  Git 작업 후 390·768·1440px 화면과 commit 선택을 headless로 확인했다. 기존 좁은 폭의
  가로 스크롤을 유지했다. 새 밝은 테마/Axe 감사와 visible Extension Host 검사는 하지 않았다.
  OS 창·포커스 이동, 전체 저장소 테스트, ESLint, Marketplace 상태 점검도 실행하지 않았다.
- Production bundle·VSIX 생성 후 런타임 파일 124개의 원본 일치를 확인했다. VSIX는
  979,780 bytes이며 SHA-256은
  `6c166e56769c0c6c80a1b73166f3bb3446997d235e35168793e6f7e395a22c4e`다.
  개발 source·test·scripts·docs는 패키지에서 제외했다.

## 계속할 작업

첫 전체 실행에서 후속 완료 시간은 push·pull·fetch·checkout에서 증가했다. 최종 실행도
한 번 표본이므로 항목별 지연 개선을 보편적인 결과로 확정하지 않는다. 준비 조회의
중복 제거와 5회 표본 개선을 전체 작업의 보편적 속도 향상으로 바꾸어 보고하지 않는다.
전체 속도 목표는 진행 중이다. 다음에는 개별 Git 실행 지연과 Graph fingerprint 이후
로컬 branch metadata를 기다리는 순차 구간을 분리해 확인한다.

전후 원본과 provenance는 [JSON](./git-preparation-0.1.72115.json)에 있다.
이전 Graph 조회 중첩·활동 기록 비용은 [0.1.72114 검증](./graph-first-page-0.1.72114.md),
ref transaction·Undo는 [0.1.72113 검증](./snapshot-transactions-0.1.72113.md)에 별도로 있다.
