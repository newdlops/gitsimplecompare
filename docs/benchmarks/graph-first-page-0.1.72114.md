# 0.1.72114 Graph 첫 조회·활동 기록 검증

기준은 0.1.72113(`e3d97a9882e5f71d1198740cf34d52a1a53e09b1`)이다.
동일한 harness를 기준 commit과 작업 트리 source에 연결했다. 버전 변경 전 측정했으므로
작업 트리 결과의 manifest version도 0.1.72113이다. source 종류·commit·번들 해시로
두 구현을 구분한다. 원본 표본은 [JSON](./graph-first-page-0.1.72114.json)에 보존했다.

## 완료된 임시 경로가 누적되는 세션

실제 `GitProcessRegistry`에 완료된 경로 10,000개와 아직 열린 monitor 4개를 등록했다.
ChildProcess는 PID·타이머·신호가 없는 fixture다. 실제 Git/OS 자식은 생성하지 않았다.
워밍업 1회 뒤 각 5회, 회당 활동 시각 조회 80번의 중앙값을 기록했다. 힙은 명시적 GC
전후의 보관량 차이이며, 전체 확장·Git·시스템 메모리나 CPU 수치가 아니다.

| 항목 | 이전 | 개선 |
| --- | ---: | ---: |
| 보관 경로 | 10,004 | 516 |
| 보관 힙 차이 | 6,457,424 bytes | 451,048 bytes |
| 조회 경과 시간 중앙값 | 293.597ms | 0.274ms |
| 조회 Node CPU 중앙값 | 303.543ms | 0.787ms |

최근 완료 경로 512개 외에 실제 close되지 않은 읽기·쓰기·직접 소유 monitor 경로는
제한 밖에서 보호한다. 활동 조회는 과거 경로 전체를 다시 훑지 않는다. 심볼릭 링크로
실행한 monitor의 원래 경로와 최초 canonical 경로 활동 증거도 유지한다. 사용 기록이
만료된 경로는 알 수 없음으로 취급하며, 이 변경이 프로세스를 종료하거나 ref를 바꾸지 않는다.

재현: `node scripts/benchmark-git-activity.mjs <result.json>`.
기준 구현은 `GSC_BENCH_SOURCE_REF=e3d97a9882e5f71d1198740cf34d52a1a53e09b1`을 지정한다.

## 첫 Graph 이력과 브랜치 조회의 대기 겹치기

기존 native branch snapshot 한 번과 첫 topo log 한 번을 같은 Graph 세대에서 함께
시작한다. log 출력은 아직 화면이나 containment index에 넣지 않는다. 새 branch 목록과
HEAD 이름·OID 및 로드 범위의 로컬 ref가 일치할 때만 채택한다. batch tracking, detached
HEAD, 불확실한 이력, 필터가 지정된 경우는 기존 경로를 유지한다.

숨김·저장소 교체·다른 조회·metadata 실패는 해당 선행 읽기만 취소하고 실제 완료를
기다린다. 변경된 checkout/ref/범위는 결과를 버리고 확정된 범위를 읽는다. 동일 범위의
timeout은 같은 log를 재시도하지 않고 원래 오류로 전파한다. 처음 발견한 손상 ref는
기존의 정상 ref 한정 조회로 복구하며, 이미 알려진 손상 ref에는 선행 조회를 시작하지 않는다.

## 실제 Git 작업과 production Graph 화면

파일 1,000개·기본 commit 1,000개·곁가지 300개의 임시 저장소와 로컬 bare 원격을 썼다.
monitor 정책을 켜고 production HTML/CSP/JS를 headless Chromium에 연결했다. 다른 CPU
검사와 겹치지 않게 전후 실행했다. 각 작업은 한 번씩 측정했으며, 머신 부하와 프로세스
시작 지연은 통제하지 않았다. 네트워크 전송 지연은 포함하지 않는다.

Graph 갱신은 작업 완료부터 host의 최신 graph 게시까지, 화면 반영은 renderer의 실제
frame 응답까지의 시간이다. 총 Git 수에는 비동기 status/config 등 보조 조회가 포함된다.

| 작업 | 작업 ms | Graph 갱신 ms | 화면 반영 ms | 총 Git 수 |
| --- | ---: | ---: | ---: | ---: |
| push | 2473 → 3965 | 441 → 399 | 569 → 585 | 26 → 26 |
| pull | 1195 → 1078 | 730 → 441 | 815 → 571 | 17 → 16 |
| fetch | 465 → 536 | 417 → 601 | 559 → 747 | 9 → 9 |
| rebase | 2035 → 1594 | 605 → 441 | 694 → 566 | 29 → 29 |
| 브랜치 squash merge | 2241 → 2408 | 505 → 512 | 595 → 663 | 30 → 30 |
| PR squash cherry-pick | 2991 → 2493 | 542 → 425 | 658 → 550 | 35 → 37 |
| PR cherry-pick | 2491 → 3179 | 412 → 354 | 500 → 431 | 40 → 39 |
| cherry-pick | 87 → 77 | 439 → 415 | 524 → 484 | 14 → 14 |
| checkout | 275 → 328 | 349 → 453 | 478 → 578 | 11 → 11 |

기본 fetch는 앞선 pull에서 이미 읽은 이력을 재사용한다. 따라서 별도 새 fixture에서
아직 로컬에 없는 object를 fetch하는 경우와 일반 merge commit도 전후 측정했다.

| 추가 작업 | 작업 ms | Graph 갱신 ms | 화면 반영 ms | 총 Git 수 |
| --- | ---: | ---: | ---: | ---: |
| 새 이력 fetch | 762 → 565 | 619 → 429 | 703 → 550 | 14 → 13 |
| 일반 merge (`--no-ff`) | 463 → 243 | 652 → 573 | 753 → 716 | 13 → 13 |

모든 11개 경우에서 새 native Git 조회의 HEAD·부모·refs와 host 이력이 같았고,
실제 300행 DOM의 HEAD 배지·refs도 일치했다. 새 페이지가 필요한 정상 경우의 Graph
log는 전후 모두 한 번이었다. 최대 동시 Git 실행은 두 구현 모두 4개였다. 기본 9종의
작업 단계 Git 수는 각각 동일했다. 보조 조회의 cache 만료·status 시점 때문에 총수는
달라질 수 있다. 모든 작업이 빨라졌다는 결론이나 일반적인 개선율은 주장하지 않는다.

재현: `GSC_BENCH_BRANCHES=300 GSC_BENCH_MONITOR_POLICY=1 GSC_BENCH_LIVE_RENDERER=1 node scripts/benchmark-git-operations.mjs <result.json>`.
추가 경우는 `GSC_BENCH_OPERATIONS=fetch-new-history,merge-no-ff`를 지정한다.

## 안정성·화면 감사

- Graph 회귀 검사 82개 통과. 선행 조회 15개와 실제 Git/GraphPanel 검사 2개의 최종
  묶음도 통과했다. 15개는 82개 묶음과 중복된다. 변경된 HEAD·같은 OID의 다른 branch·
  움직인 local tip·필터·서비스 객체 교체·숨김·timeout·손상 ref를 확인했다. 실제 Git
  containment 결과도 같고 채택 페이지에서 추가 `--contains` 조회는 없었다.
- 프로세스 수명·취소·종료 확인·소유 monitor·활동 기록 검사 37개 통과. sandbox에서
  프로세스 그룹 검사가 제한된 첫 시도는 성공으로 세지 않았고, 필요한 권한으로 같은
  묶음을 다시 실행해 완료했다. 중단된 fixture의 검증된 소유 자식만 회수했다.
- Headless 브라우저 5개 검사 통과. 390·768·1440px에서 로딩 중 commit 선택, 늦은
  working-tree 행 삽입 후 스크롤 anchor 유지, pagination과 오류 표시를 확인했다.
  health notice의 Axe, live announcement, 키보드 focus 및 forced colors도 확인했다.
- 실제 Git 작업 후 production Graph를 세 viewport에서 촬영해 직접 확인했다. 기존의
  조밀한 VS Code 화면과 좁은 폭의 가로 스크롤을 유지했다. HTML/CSS/버튼은 추가하지 않았다.
  OS 창을 열거나 포커스를 이동하지 않았다. visible Extension Host 검증은 하지 않았다.
- Impeccable detector를 변경한 webview TypeScript 3개에 한 번 실행했고 결과는 `[]`였다.
  이 결과만으로 전체 UI 접근성이나 시각 품질을 보증하지 않는다. 수동 범위 감사에서
  P0/P1 문제는 발견하지 않았다. 판단 점수는 접근성 4/5, 성능 4/5, 반응형 4/5,
  테마 3/5, 기존 디자인 일관성 5/5다. 밝은 테마와 전체 확장 스크린리더 감사는 이번에
  반복하지 않았다. 기존 `.impeccable/design.json`과 `DESIGN.md`의 갱신 시점 차이(P3)는
  제품 변경과 관계없는 문서 정비로 남겼다.
- TypeScript와 `git diff --check` 통과. 전체 저장소 테스트, ESLint, Marketplace 상태
  점검은 수행하지 않았다.
- Production bundle·VSIX 생성 후 런타임 파일 124개의 원본 일치를 확인했다. VSIX는
  978,488 bytes이며 SHA-256은
  `e3ee4a3c6f92f5561f3f083f62cc90eee238dc811f9f42cf9052f3b97e1ad3ba`다.
  개발 source·test·scripts·docs는 패키지에서 제외했다.

이전 ref transaction·Undo 안정성 개선은 [0.1.72113 검증](./snapshot-transactions-0.1.72113.md),
Graph 알림 비용과 포커스 간섭 제거는 [0.1.72112 검증](./graph-refresh-0.1.72112.md)에 있다.
