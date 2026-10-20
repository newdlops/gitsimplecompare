# 0.1.72121 작업 성능·정확성 감사와 interactive rebase 경로 공유

전체 목표는 아직 진행 중이다. 모든 서비스의 대기시간이 줄었다고 결론 내리지 않는다.
이번 변경은 interactive Start와 기존 scoped branch/PR 작업의 경로 조회 중복을 줄이고,
경로 교체 시 다른 저장소에 큐를 쓰지 않도록 보호한다. 실제 상태 파일과 메시지는 매번 새로 읽는다.

## 누적 비교: 0.1.72112 → 0.1.72120

기준 commit은 `b9d8ed66f58156095e094f2ec1d5e4ac4d07cd9b`, 비교 commit은
`9f6ef90280e8351dc8bd1a01ef25c7b23a04b196`이다. 각 3회, 같은 계측 코드와
파일 1,000개·기본 커밋 1,000개·side branch 100개·공통 upstream 8개 fixture를 사용했다.
실행 순서는 기준1 → 비교1 → 비교2 → 기준2 → 기준3 → 비교3이다. 동시에 다른 성능 검사를 실행하지 않았다.
원격은 로컬 bare repository이고 실제 GitHub 전송 속도를 측정하지 않는다. 외부 머신 부하는 통제하지 않았다.

원래 기준 0.1.72110 (`0ae1783f46fe24900439e70d9b8873685d32162a`)은 production CSP 오류로
renderer 검사를 통과하지 못했다. 오류를 무시하거나 과거 source를 고치지 않고 화면 시간 비교에서 제외했다.
현재 기준은 CSP 수정과 포커스 간섭 제거가 이미 들어간 버전이다. 실패 기록 경로는 JSON에 남겼다.
원래 기준을 쓴 별도의 host-only 과거 비교는 이 화면 시간 비교와 합치지 않는다.

아래 값은 각 실행의 18개 시나리오 합계를 구한 뒤 세 실행의 중앙값을 비교한 것이다.
개별 사용자 작업의 보장 시간이나 전체 OS 자원 사용량을 뜻하지 않는다.

| 지표 | 기준 | 비교 | 변화 |
|---|---:|---:|---:|
| 직접 Git 실행 수 | 471 | 280 | -40.6% |
| 서비스 구간 합계 | 55,522ms | 54,276ms | -2.2% |
| 서비스 시작 → 최종 화면 합계 | 101,721ms | 78,726ms | -22.6% |
| benchmark Node CPU 시간 합계 | 4,262ms | 2,891ms | -32.2% |

Node CPU에는 Playwright transport와 RSS/idle 관측이 포함되며 Git·helper·Chromium CPU는 포함되지 않는다.
최대 동시 소유 registry slot은 기준 `[7,8,7]`, 비교 `[4,4,4]`였다. Git 내부 자식 전체의 수가 아니다.
최대 Node peak RSS 증가는 기준 `[63,72,22]`, 비교 `[64,24,19]`MiB로 편차가 크다.
캐시 상한·취소 정리와 별개로 확장 전체 메모리 감소나 상한을 보장하지 않는다.

### 작업별 중앙값

서비스 시간과 첫/최종 표시를 분리한다. 화면 시간은 서비스 실행 시작부터 잰 값이고 단위는 ms다.
동일 상태가 이미 화면에 있으면 그 증거를 확인한 경우에만 없는 frame 시간을 0으로 취급한다.

| 시나리오 | 서비스 | 첫 표시까지 | 최종 표시까지 | 직접 Git 실행 |
|---|---:|---:|---:|---:|
| initial | 0 → 0 | 1228 → 668 | 3969 → 1736 | 22 → 12 |
| push | 5437 → 7327 | 5828 → 7833 | 6722 → 8404 | 33 → 25 |
| push-tracked | 5112 → 5568 | 5750 → 6272 | 7103 → 7192 | 31 → 21 |
| pull-new-history | 2849 → 3026 | 3638 → 4169 | 5585 → 4791 | 23 → 13 |
| fetch-new-history | 1352 → 1404 | 1891 → 2186 | 3405 → 2891 | 20 → 10 |
| pull | 3480 → 3306 | 4356 → 4192 | 4356 → 4192 | 18 → 10 |
| fetch | 810 → 1151 | 1430 → 1628 | 3338 → 1995 | 16 → 7 |
| rebase | 5114 → 5857 | 5695 → 6750 | 7687 → 7577 | 37 → 25 |
| merge | 5887 → 3893 | 6561 → 4642 | 9349 → 5574 | 37 → 24 |
| merge-no-ff | 544 → 651 | 1509 → 1690 | 3723 → 2865 | 21 → 10 |
| pr-squash-cherry-pick | 8635 → 9381 | 9883 → 10447 | 12125 → 11567 | 48 → 33 |
| pr-cherry-pick | 6506 → 7244 | 7354 → 7947 | 10424 → 9012 | 49 → 35 |
| cherry-pick | 272 → 192 | 1150 → 928 | 3384 → 1846 | 21 → 10 |
| checkout | 624 → 732 | 1015 → 1262 | 1015 → 1262 | 18 → 9 |
| checkout-unloaded | 927 → 685 | 1942 → 1197 | 4042 → 2233 | 23 → 12 |
| pull-known-history | 3118 → 2342 | 4004 → 2902 | 4004 → 2902 | 18 → 10 |
| fetch-known-history | 711 → 1236 | 1187 → 1701 | 2671 → 2273 | 17 → 7 |
| fetch-no-change | 1035 → 634 | 1611 → 1044 | 1611 → 1044 | 17 → 7 |

push·tracked push의 서비스 시간과 loaded checkout의 최종 시간 등은 더 길었다.
기준/비교의 18개 서비스 구간 합계 원본은 각각 `[62506,55214,55522]`, `[110218,38188,54276]`ms다.
느린 비교1도 포함했으며 결과가 좋을 때까지 다시 실행하거나 유리한 표본만 고르지 않았다.
호출 수 감소를 대기시간 단축으로 바꾸어 해석하지 않는다.

모든 108개 시나리오에서 실제 Git의 HEAD·부모·ref와 production HTML/CSP/JS의 현재 브랜치·local-only가 일치했다.
처음 받는 pull/fetch 이력과 페이지 밖 checkout은 log 한 번, loaded checkout은 추가 log 0번을 확인했다.
변경 없는 fetch에서는 이미 맞는 화면임을 별도로 확인했다. 최신 metadata를 포함한 최종 frame까지 대조했다.

## 0.1.72121 interactive Start의 별도 비교

같은 이전 commit `9f6ef902...`과 작업 트리에 동일한 새 계측 코드를 연결했다.
파일 1,000개·기본 커밋 1,000개와 독립 변경 6개의 실제 Native rebase를 사용했다.
이전1 → 후보1 → 후보2 → 이전2 순서의 각 block에서 두 계획을 번갈아 세 번씩 실행했다.
각 계획/버전당 6개, 총 24개 표본이며 인위적인 Git 지연은 넣지 않았다.
시간에는 실제 Start와 editor helper를 포함하고 준비된 checkout 조회·fixture 생성·결과 검증과 Graph는 제외한다.

| 지표 | 이전 | 후보 |
|---|---:|---:|
| 직접 Git 실행 | 11 | 8 |
| 디렉터리만 확인하는 Git 실행 | 3 | 1 |
| private 상태 경로 확인 | 2 | 1 |
| 최신 checkout 안전 확인 | 2 | 2 |
| 메시지 변경/squash 시간 중앙값 | 4,891.5ms | 5,326ms |
| 순서 변경 시간 중앙값 | 4,710ms | 4,163ms |
| 메시지 변경/squash Node CPU 중앙값 | 37ms | 38.5ms |
| 순서 변경 Node CPU 중앙값 | 36ms | 40ms |

직접 Git 자식 수는 27.3% 줄었지만 대기시간은 혼합 결과이고 Node CPU는 줄지 않았다.
메시지 변경/squash는 약 8.9% 길고 순서 변경은 약 11.6% 짧았다.
Native/helper CPU를 측정하지 않았으므로 전체 CPU 절감도 주장하지 않는다.
이 변경을 interactive rebase의 보편적 대기시간 개선 증거로 사용하지 않는다.

24개 모두 최종 tree·메시지·작업트리 청결·큐 삭제·소유 프로세스 종료가 일치했다.
Start scope는 경로만 보관하며 종료 뒤 해제한다. scoped operation detection도 마커 파일을 매번 다시 읽는다.
scope 밖 Continue는 경로와 큐 내용을 새로 읽고, metadata/실행 환경 교체는 캐시 접근 전에 중단한다.
큐 준비 실패나 metadata 교체로 cleanup이 중단돼도 이 호출의 todo/rewrite 임시 파일은 회수한다.

## 최종 source의 회귀 검사

고유 Node 검사 **283개 통과**, 미해결 실패·취소·skip 0개. 타입 검사도 통과했다.

최초 묶음은 280개 통과·3개 실패였다. Graph Native 검사는 getCommitPage 호출을 0회로 세어 실패했다.
조기 페이지 채택은 readUnindexedCommitPageSnapshot을 사용해 그 메서드를 거치지 않는다.
검사를 실제 공통 실행기의 git log 완료 수로 수정해 같은 조회 수·Git 상태·status 대기 검증을 다시 통과했다.
나머지 두 검사는 ls-files 앞의 -c 옵션 때문에 index 오류 주입이 실행되지 않았다.
실제 Git 하위 명령 위치를 찾아 주입하고, 첫/마지막 index 경계에서 오류가 실제로 주입됐다는 검사도 추가했다.
제품 fallback이나 기대 조회 수는 완화하지 않았다. 최초 실패와 수정 후 두 파일 재검사 결과를 JSON에 함께 남겼다.
정상/linked worktree의 연속 Start, 실제 Native Start/Abort 직후 마커 변화, 실행 직전 외부 커밋과
metadata 교체를 확인했다. staged·unstaged·untracked 변경, force lease, PR 최종 delta,
충돌 Continue/Undo, stash·snapshot 소유권과 다른 브랜치 보호를 포함한다.

최종 0.1.72121 source에서도 18개 시나리오의 실제 Git과 production HTML/CSP/JS가 일치했다.
이 최종 기능 대조는 파일 128개·기본 커밋 400개·side branch 40개를 사용했고 Node 검사와 겹쳤다.
그 시간·CPU/RSS는 성능 비교에 사용하지 않는다.
사용자 창 포커스나 전경 Extension Host가 필요하지 않다.
강제 reload와 Marketplace 상태 조회는 수행하지 않았다.

## 재현과 남은 범위

`node scripts/benchmark-rebase-start.mjs <output.json>`으로 interactive 비교를 실행하고,
이전 source에는 `GSC_BENCH_SOURCE_REF=9f6ef902...`의 전체 commit을 지정한다.
전체 작업은 `scripts/benchmark-git-operations.mjs`와 JSON의 fixture·operation 목록으로 재현한다.
Git 설정·훅·서명과 원격을 격리하며 사용자 저장소를 benchmark 입력으로 받지 않는다.

[원본 표본·source SHA-256·검사 결과](operation-audit-0.1.72121.json)에 불리한 표본도 모두 보존한다.
18개 서비스 전부와 interactive message/squash 대기시간의 반복 가능한 개선은 아직 입증되지 않았다.
전체 최적화 목표를 이번 부분 성과만으로 완료 처리하지 않는다.
