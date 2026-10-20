# 0.1.72124 interactive rebase의 sequence editor 시작 비용

Graph에서 실제로 실행하는 `RebaseService.start`의 todo 복사를 시스템 `cp`로 처리해
Node/Electron editor 시작을 한 번 줄였다. macOS/Linux의 번들 helper 내용이 확인된 경우에만
적용하며, 독립 호출은 기본적으로 기존 Node editor를 쓴다. 사용자 지정 메시지·Continue 큐의
형식과 처리는 0.1.72123 그대로다.

## Git 직접 실행 시간

기준은 `f8083e0bc66ca4a3467499b3e640bd6d447c2e09`(0.1.72123)다.
같은 현재 harness를 기준 source에도 복사해 기준1 → 후보1 → 후보2 → 기준2 순으로 실행했다.
각 실행은 새 임시 저장소이며 파일 1,000개·base 이력 1,000커밋·독립 변경 6개를 만든다.
모드·버전당 표본은 6개이고 아래는 중앙값이다. fixture 생성과 준비·결과 검증은 시간 구간 밖이다.
인위적인 지연은 없으며 다른 머신 부하는 통제하지 않았다. 기능 검사는 측정과 겹치지 않았다.

| 작업 | Start 완료 ms: 이전 → 후보 | 변화 | 직접 Git 호출 | 최신 checkout 검증 |
|---|---:|---:|---:|---:|
| 사용자 메시지·squash/fixup | 10,496.5 → 8,638.5 | 17.7% 단축 | 8 → 8 | 2 → 2 |
| 커밋 순서 변경 | 4,161.0 → 2,741.5 | 34.1% 단축 | 8 → 8 | 2 → 2 |

메시지 작업의 전체 범위는 이전 7,404–11,992ms, 후보 6,108–11,142ms다.
재정렬은 이전 2,180–4,486ms, 후보 2,392–3,398ms로 분산이 있다.
이는 서비스 Start의 실행·완료 범위다. 확인 모달, 실제 VS Code 버튼에서 Graph 반영까지의 시간,
`captain` 저장소나 GitHub API·PR 작업의 측정이 아니다. [전체 표본과 source 해시](rebase-native-0.1.72124.json)의
`directTiming`에 원본을 보존한다.

## CPU·메모리 계측은 별도 실행

자식 CPU/RSS는 macOS `/usr/bin/time -lp` wrapper와 Git Trace2를 켜고 따로 측정했다.
새 wrapper의 첫 실행 검증은 공통 warmup에서 제외했다. Node CPU는 benchmark 부모 프로세스만,
Native CPU는 host Git과 기다린 자손을 포함한다. 둘의 합은 계측한 프로세스의 합이며 전체 OS CPU가 아니다.
표의 CPU 합계는 표본별 부모·자식 CPU를 합한 뒤 구한 중앙값이다.
Native CPU의 원본 정밀도는 명령별 0.01초다. RSS는 `time`이 보고한 단일 명령 최대값이며
모든 동시 프로세스 메모리의 합이나 VS Code 전체 메모리가 아니다.

| 작업 | 계측 CPU 합계 ms: 이전 → 후보 | 단일 명령 최대 RSS MiB: 이전 → 후보 | Node editor 실행 |
|---|---:|---:|---:|
| 사용자 메시지·squash/fixup | 482.0 → 465.0 | 40.73 → 40.73 | 4 → 3 |
| 커밋 순서 변경 | 204.5 → 217.5 | 40.23 → 12.55 | 1 → 0 |

재정렬의 단일 명령 최대 RSS 중앙값은 68.8% 감소했다. 사용자 메시지 helper는 유지하므로
그 작업의 최대 RSS 감소는 없다. CPU는 모든 모드에서 줄지 않았고 표본·정밀도·부하 변동이 있어
일관된 CPU 절감으로 결론내리지 않는다. 부모 Node CPU와 자식 CPU도 JSON에서 따로 볼 수 있다.

계측 실행의 Start 중앙값은 메시지 작업 18,073 → 19,817ms, 재정렬 15,057.5 → 16,289.5ms였다.
wrapper·Trace2의 실행 경로와 실행 시점에 따른 변동이 있어 직접 실행과 결과 방향도 달랐다.
이 값은 숨기지 않고 `summary`와 `runs`에 보존하되 완료 시간 성과에는 사용하지 않는다.
CPU/RSS 측정도 버전·모드당 6개 표본이다. 그 첫 기준 표본과 후보 사이에는 최종 기능 검사가 있었으며
계측과 겹치지는 않았다. Graph·Chromium은 이 자원 계측에 포함하지 않는다.

## 안전성과 확인한 범위

- 알려진 helper의 SHA-256과 실행 가능한 `cp`를 확인한다. 사용자 지정/누락된 helper,
  Windows와 지원되지 않는 환경은 기존 명령 형식을 유지한다.
- 경로는 shell 리터럴로 인용한다. 따옴표·달러·backtick·개행·한글 경로의 todo bytes를 확인했다.
  `cp`가 directory target을 성공으로 오인하지 않게 일반 파일만 복사하며, 실패는 원본 helper로 위임한다.
- 계획·checkout·HEAD의 두 최신 검증, merge 계획 거부, native 충돌과 autostash 처리는 유지한다.
  각 측정에서 최종 tree·커밋 제목/순서·깨끗한 작업트리·큐 정리·소유 프로세스 해제를 확인했다.
  별도 메시지 기능 검사에서는 본문을 포함한 전체 메시지도 확인했다.
- 최종 변경 경로의 Node 검사 26개와 타입 검사를 통과했다. 일반/linked worktree, SHA-256,
  pause/Continue 중 메시지 변경, 외부 HEAD 추가, metadata 교체, helper 실패를 포함한다.
  앞선 관련 검사에서는 파일 이동·바이너리·rename·autostash 복원 충돌·작업 소유권도 확인했다.
  ESLint 실행 파일과 설정이 없어 lint는 실행하지 않았다.
- headless Chromium에서 rebase 완료·중단·복원 충돌·재시작 메시지와 버튼 동작을
  390/768/1440px에서 6개 검사했다. 390px 완료와 1440px 복원 충돌 스크린샷을 직접 확인했다.
  실제 Git 검사와 webview 메시지 fixture는 별도이며 사용자 창 포커스나 강제 reload는 사용하지 않았다.

## 제외한 실험과 재현

작은 메시지 큐까지 shell로 소비하던 후보는 계측 환경에서 CPU·메모리는 줄었지만
메시지 작업의 완료 중앙값이 늘었다. 이 후보의 직접 실행 시간은 측정하지 않았으므로 실사용 지연을
단정하지 않는다. 해당 구현·상태 flag·전용 shell 파일 생성은 최종 제품에서 제거했다.
초기 수집기·pilot의 경로/제외 사유와 해당 후보의 전체 원본은 JSON의 `excluded`에 남기고
최종 비교와 합치지 않았다. 버퍼링·리소스 종류가 다른 push 측정과도 합산하지 않는다.

직접 실행은 `GSC_BENCH_REBASE_PROFILE=0 node scripts/benchmark-rebase-start.mjs /tmp/after.json`이다.
기준에는 `GSC_BENCH_SOURCE_REF=f8083e0bc66ca4a3467499b3e640bd6d447c2e09`를 추가한다.
macOS 자식 계측은 `GSC_BENCH_REBASE_PROFILE=1`이며 커널 rusage 조회 권한이 필요하다.
표본 수는 `GSC_BENCH_REBASE_SAMPLES=3`이 기본이다. 외부 저장소는 입력받지 않는다.

첫 이력 walk, 알 수 없는 published tip, 실제 버튼→Graph 전체 대기, 대형 실제 저장소와 PR 작업은
추가 검증 대상이다. 이번 결과로 [전체 최적화 목표](operation-audit-0.1.72121.md)를 완료 처리하지 않는다.
