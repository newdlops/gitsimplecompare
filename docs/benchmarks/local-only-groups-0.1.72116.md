# 0.1.72116 local-only 범위·파싱 최적화 검증

기준은 0.1.72115 제품에 측정 harness 수정이 포함된
`a1ff4808cbf802deabc2ae655bccc70927c0f7cf`다.
제품 변경은 `src/git/gitLocalOnlyBranches.ts` 한 모듈이다.
Graph HTML·CSS·frontend JS는 변경하지 않았다.

## 변경과 안전 경계

동일한 upstream OID 집합을 가진 브랜치의 정확한 범위를 한 번 읽는다.
tip별 membership을 부모 방향으로 전파하므로 합집합에 속한 커밋을 모든 브랜치에
잘못 표시하지 않는다. 기준점이 다른 그룹은 분리하고 결과 이름은 원래 브랜치 순서를 유지한다.

기존 작은 목록 한도 16개와 동시 실행 한도 4개를 유지했다. 예상 ahead 합이 50,000을
넘거나 유효하지 않으면 그룹을 나눈다. 16개 초과 목록은 한 그룹으로 좁힐 수 있을 때만
범위 조회를 쓰고, 그 외에는 기존 한 번짜리 전체 DAG 조회를 유지한다.
따라서 큰 목록의 Git 프로세스 수를 늘리는 병렬화는 추가하지 않았다.

파서는 실제로 켜진 membership 비트만 읽고, 연속한 같은 mask의 해독 결과를 재사용한다.
각 커밋의 이름 배열은 독립적이다. topo-order에서 이미 처리한 자식 상태는 부모에 전파한
뒤 해제한다. 새 영속 캐시·타이머·의존성은 추가하지 않았다.

첫 실패는 새 그룹 시작을 중단하고 활성 sibling을 취소한다. 모두 종료한 뒤 원래 오류를
전파하며, 부분 결과는 완료 캐시에 넣지 않는다. 이미 취소된 요청은 Git을 시작하지 않는다.
그룹 수·동시 실행 수·실패·취소는 기존 OUTPUT 채널에 기록한다.

## 같은 프로세스의 교대 비교

Node v22.22.2에서 기준과 최종 source를 별도 모듈로 읽고 같은 Native 실행기를 주입했다.
같은 immutable fixture에 워밍업 각 1회, 전후 순서를 번갈아 각 5회 측정했다.
GC는 측정 구간 밖에서 실행했다. 과거 이력 1,000개·공유 범위 64개와 1개 또는 2개 upstream을
사용했다. 아래는 중앙값이다. Native 전체 부모 목록에 대한 브랜치별 독립 DFS 차집합을
정답으로 사용했고, 정답 계산은 측정 구간에서 제외했다.

| 브랜치 / 기준점 수 | 경과 ms | Node CPU ms | Git 수 | 최대 동시 Git | 출력 행 수 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 16 / 1 | 325.058 → 139.771 | 34.260 → 5.721 | 17 → 2 | 4 → 1 | 1056 → 81 |
| 16 / 2 | 297.159 → 130.362 | 29.477 → 7.259 | 17 → 3 | 4 → 2 | 1056 → 146 |
| 160 / 1 | 45.136 → 41.190 | 11.878 → 9.911 | 2 → 2 | 1 → 1 | 1226 → 225 |
| 160 / 2 | 57.801 → 55.953 | 10.113 → 8.818 | 2 → 2 | 1 → 1 | 1226 → 1226 |

최종 source SHA-256은
`7952d6d6037b1178357daab9e2863489d4b4e5b186da9ee547199af54b3b4081`다.
교대 비교·비공개 snapshot replay의 최종 source hash가 이 값과 모두 같다.
단독 실행 재현은 `node scripts/benchmark-local-only-groups.mjs <result.json>`이며,
기준에는 `GSC_BENCH_SOURCE_REF=a1ff480`을 지정한다. 단독 실행은 교대 비교와
스케줄링이 다르므로 표의 숫자와 같아질 것을 보장하지 않는다.

초기 단독 측정도 보존했다. 마지막 mask 재사용 전의 160개/1개 기준점 결과는
46.6→135.0ms, 160개/2개 기준점은 242.0→263.0ms로 느렸다.
이를 최종 개선으로 보고하지 않는다. 공통 upstream 브랜치가 16개인 초기 작업 행렬과 8개인 후보,
중간 parser 후보도 JSON의 intermediateStages에 구분했다.
공통 upstream 브랜치 8개인 초기 후보 실행 일부는 짧은 Native 검사와 겹쳤으므로 주 증거에서 제외했다.

## captain snapshot의 읽기 전용 replay

captain에서 Native Git 읽기 4회로 수집한 브랜치 161개·plan 117개·출력 565행 snapshot을
사용했다. 수집 시 optional locks와 lazy fetch를 끄고 사용자 브랜치·index·설정·stash를
변경하지 않았다. 최종 replay는 저장된 같은 snapshot을 사용해 captain Git 읽기가 0회였다.
비공개 이름·OID·subject·경로와 원본 출력은 저장소에 커밋하지 않는다.

워밍업 뒤 전후 교대 5회 중앙값에서 경과 시간은 **3.829→0.937ms**,
호출 Node CPU는 **5.753→1.729ms**였다. 빠른 경로의 결과 digest와 mismatch 수는 같았다.
별도 계측에서 reachability Map의 최대 항목 수는 **670→118**,
반환 시 잔여 상태는 **670→105**였다. 이 항목 수는 heap/RSS bytes가 아니다.
이 replay는 파싱 비교이며 Git 실행·VS Code·사용자 작업 완료 시간을 포함하지 않는다.
독립 Native 정답 검증은 앞의 fixture 검사와 별도로 수행했다.

## 실제 Git 작업과 최종 Graph frame

파일 1,000개·기본 commit 1,000개·곁가지 300개·공통 main upstream 8개를 사용했다.
원격은 로컬 bare이며 monitor 정책을 켰다. 기준과 최종 source의 각 항목은 한 번 표본이다.
회귀 검사나 다른 benchmark와 겹치지 않게 최종 실행했다.

첫 화면은 작업 종료 이후 첫 history frame ACK, 최종 화면은 정확한 최종 게시의
traceId·kind·sentAt에 대응하는 frame ACK다. 늦은 local-only 표시를 첫 화면 완료로
오인하지 않는다. 후속 완료는 작업 시작부터 Graph 보조 조회가 유휴 상태가 될 때까지다.
단위는 ms이며 아래 값은 기준 → 최종이다.

| 작업 | 작업 자체 | 첫 화면 | 최종 화면 | 후속 완료 | Graph Git 수 | 최대 동시 Git |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| push | 4987 → 3211 | 795 → 498 | 1555 → 619 | 6551 → 3941 | 14 → 7 | 5 → 2 |
| fetch-new-history | 952 → 560 | 1061 → 824 | 2376 → 1156 | 3715 → 1943 | 19 → 11 | 7 → 4 |
| pull | 4133 → 928 | 705 → 493 | 705 → 493 | 5432 → 1662 | 14 → 7 | 5 → 2 |
| fetch | 1323 → 370 | 1029 → 553 | 2112 → 783 | 3436 → 1163 | 15 → 7 | 5 → 2 |
| rebase | 2580 → 1925 | 922 → 790 | 3758 → 1111 | 6338 → 3245 | 21 → 11 | 8 → 4 |
| merge | 4155 → 1920 | 970 → 523 | 2408 → 1082 | 6975 → 3228 | 20 → 12 | 7 → 4 |
| merge-no-ff | 891 → 239 | 1195 → 715 | 3395 → 1038 | 4470 → 1584 | 20 → 12 | 7 → 4 |
| pr-squash-cherry-pick | 5211 → 3141 | 1078 → 602 | 2674 → 981 | 8084 → 4720 | 19 → 12 | 7 → 4 |
| pr-cherry-pick | 4745 → 2441 | 1513 → 451 | 3349 → 888 | 8346 → 3335 | 20 → 10 | 7 → 4 |
| cherry-pick | 178 → 24 | 1121 → 557 | 3599 → 866 | 4413 → 1184 | 20 → 12 | 7 → 4 |
| checkout | 1028 → 268 | 1843 → 558 | 1843 → 558 | 3913 → 1097 | 15 → 7 | 5 → 2 |

모든 11개 경로에서 새 Native 조회의 HEAD·부모·refs와 host 이력이 같았고,
실제 300행 DOM의 refs·HEAD 배지·local-only 표시도 host 결과와 일치했다.
공통 upstream의 feature 표시가 실제로 존재하는지도 검사했다.
첫 HEAD가 페이지 밖에 있는 경우에는 잘못된 HEAD 배지가 없는 것을 확인한다.

이 실행의 최대 동시 Git 수는 8→4였다. 모든 행의 전체 Git 수와 호출 Node CPU,
개별 command 시간은 JSON에 있다. Node CPU는 Native Git·브라우저·전체 확장 CPU를
포함하지 않는다. 한 번 표본의 경과 시간은 머신 부하·프로세스 시작 지연의 영향을
받으므로 작업 자체의 큰 차이를 이 parser 변경만의 효과로 해석하지 않는다.

재현 환경: `GSC_BENCH_BRANCHES=300 GSC_BENCH_SHARED_UPSTREAM_BRANCHES=8`,
`GSC_BENCH_MONITOR_POLICY=1 GSC_BENCH_LIVE_RENDERER=1`.
`GSC_BENCH_OPERATIONS=push,fetch-new-history,pull,fetch,rebase,merge,merge-no-ff,pr-squash-cherry-pick,pr-cherry-pick,cherry-pick,checkout`을 지정해
`node scripts/benchmark-git-operations.mjs <result.json>`을 실행한다.
새 object fetch는 pull보다 먼저 실행한다.

## 검사·배포 범위

- 관련 고유 검사 **94개** 통과, 실패·skip 0개. Native oracle 5개와 실제 소유 child의
  취소/exit 42 종료 검사 2개를 포함한다. 반환 시 child PID가 남지 않는 것을 확인했다.
  서로 다른 기준점·같은 tip·큰 출력 guard·배열 독립성·실패 후 cache 재시도를 검사했다.
- TypeScript, production bundle, diff whitespace 검사를 통과했다.
- production HTML/CSP/JS를 headless Chromium에서 실행했다. 390·768·1440px 이미지를
  각각 직접 열어 확인했으며 각 폭의 정상 commit click과 Escape도 통과했다.
  기존 좁은 폭의 가로 스크롤을 유지했다.
- visible Extension Host, OS 창·포커스 이동, 강제 reload, 전체 저장소 테스트,
  ESLint, 새 Axe/밝은 테마 감사, 물리적 터치와 Marketplace 상태 점검은 실행하지 않았다.
- VSIX는 **980,477 bytes**다. SHA-256은
  `e000375ae6f3fbb2ea09b8f82a30b5bd9413e8aeb38d6f72ada4651325f2fa09`,
  bundle SHA-256은 `0e5c241e8974018011c55ea7b3c7c37967aa08e066060fd2391bfca45c5fd968`다.
  media·dist·l10n·NLS 124개 파일이 원본과 같고 개발 source·test·scripts·docs가
  제외된 것을 확인했다. stash 내용 조회 명령 2개도 manifest에 유지돼 있다.

## 남은 목표

같은 upstream의 반복 계산과 파싱 자원 비용을 줄인 결과다.
전체 작업·환경에서 첫 화면과 Native 준비 지연이 충분히 개선됐다고 확정하지 않는다.
이전 병렬 준비 후보는 여전히 배포 제외 상태이며
[그 평가 기록](graph-branch-preparation-evaluation-2026-10-20.md)을 유지했다.
전체 속도·안정성·자원 절감 목표는 진행 중이다.

전후 표본·중간 후보·계측 범위는 [JSON](local-only-groups-0.1.72116.json)에 있다.
