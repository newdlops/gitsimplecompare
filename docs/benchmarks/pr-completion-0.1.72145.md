# PR 완료 처리 비용 — 0.1.72145

기준은 `89f819706da219944035d69aa7431844eca84eb2`다. PR Graph 행 이동 수정 0.1.72144 위에서 커밋별 적용·revert 큐의 완료 비용을 줄인다. 원래의 전체 Git 작업 지연·Graph 최신화·안정성·자원 목표는 계속 진행 중이다.

## 변경과 경계

완료 결과는 이미 최종 HEAD를 가지고 있으므로, 결과 변환에서 읽고 버리던 HEAD 조회를 생략한다. 충돌·stash 복원 충돌은 여전히 현재 HEAD를 새로 읽는다. 복원할 stash가 없으면 restore HEAD 조회·상태 파일 재기록을 생략하고 기존 pending 상태만 정리한다. stash가 있으면 Native apply 직전의 HEAD와 복구 기록을 유지한다.

두 번의 새 Native PR 사전 검사, 각 commit의 현재 브랜치/HEAD 검증, 작업 소유권과 Undo·snapshot·stash 보존은 유지한다. 상태 조회와 index cache 관련 6개 파일은 기준 commit과 바이트가 같다. UI 코드는 변경하지 않았다.

## 검증

관련 Node **42개**, 타입 검사와 공백 검사가 통과했다. 실제 Git으로 clean 적용, 성공 stash 복원, stash 충돌의 restore HEAD·로컬 바이트·stash·snapshot 보존, 기존 PR Undo/continue/abort/외부 작업·저장소 경로 교체 보호를 검사했다. 별도 짧은 자식과 wait된 손자 CPU·살아 있는 자식 제외도 대조했다.

이전/수정에서 각각 18개 변형, 총 **36개**가 독립 Native HEAD·refs·부모·local-only 및 production HTML/CSP/JS 최종 DOM 대조를 통과했다. initial, 일반·tracked push, pull/fetch의 새/알려진/무변경 이력, rebase, merge/no-ff, PR squash·커밋별 적용, cherry-pick, loaded/unloaded checkout이다. 페이지 밖 checkout은 기존 300행과 HEAD 배지 부재가 Native의 현재 loaded page와 일치함을 확인하며, 새 HEAD로 자동 이동하는 검사는 아니다. PR 버튼은 모두 결과 HEAD가 적재되고 표시된다. 파일 1,000개·commit 1,000개·branch 100개·공유 upstream 8개의 기능 회귀 검사이며 모든 작업의 개선율을 주장하는 자료는 아니다. 원시 느려진 경우도 JSON에 포함한다.

## 실제 규모 PR 버튼

읽기 전용 Captain snapshot의 파일 **30,311개·commit 72,720개·branch 164개**를 독립 소유 fixture에 재현했다. 사용자 저장소는 바꾸지 않았다. production 버튼 → 등록된 extension callback → Native Git → 최종 DOM을 확인했다. GitHub 목록 metadata와 VS Code transport/window/picker만 fixture로 대체한다. 모든 source는 같은 harness를 사용한다.

비계측 실행 B/A/A/B와 별도의 CPU 계측 B/A/A/B, 총 **16개** PR 버튼 동작이 Native tree·부모·작업트리·최종 refs/HEAD/local-only와 일치했다. 표본 수는 source/작업/mode당 2개다. squash는 이 런타임 수정을 타지 않는 대조군이며 환경 변동도 보여준다.

| 중앙값, source/작업당 2개 | 이전 | 수정 |
| --- | ---: | ---: |
| Squash 대조군 최종 frame(ms) | 9163.500 | 9700.500 |
| Squash 대조군 완전 settle(ms) | 9310.500 | 9850.000 |
| Squash 대조군 Git 실행 수 | 32.000 | 32.000 |
| 커밋별 PR 적용 최종 frame(ms) | 12875.000 | 12533.500 |
| 커밋별 PR 적용 완전 settle(ms) | 13025.500 | 12682.000 |
| 커밋별 PR 적용 Git 실행 수 | 34.500 | 31.000 |

| 별도 계측 구간 CPU 중앙값(ms) | 이전 | 수정 |
| --- | ---: | ---: |
| Squash 대조군 Node | 764.506 | 485.509 |
| Squash 대조군 종료·wait된 native 자식 | 3205.931 | 2992.556 |
| Squash 대조군 Chromium | 631.528 | 568.535 |
| Squash 대조군 합계 | 4601.965 | 4046.600 |
| 커밋별 PR 적용 Node | 612.755 | 487.879 |
| 커밋별 PR 적용 종료·wait된 native 자식 | 3163.757 | 3107.535 |
| 커밋별 PR 적용 Chromium | 757.209 | 633.337 |
| 커밋별 PR 적용 합계 | 4533.721 | 4228.751 |

## 계측 범위

CPU 계측은 클릭 직전부터 handler·상태 조회·마지막 frame ACK와 settle이 끝난 시점까지의 counter window다. fixture 생성, C probe 빌드, 독립 Native 사후 oracle, screenshot은 제외한다. 비계측 시간과 계측 시간을 섞지 않는다. Git 실행 파일이나 Git 환경을 wrapper로 바꾸지 않는다.

벤치마크에서만 Node-API의 POSIX `getrusage(RUSAGE_CHILDREN)`를 읽어 짧게 종료된 native 자식과 wait된 후손 CPU를 포함한다. 이는 명령별 Git CPU가 아니라 OS가 Node에 누적한 자식 합계다. Node 수치에는 Playwright transport가 포함된다. Chromium은 CDP PID별 누적 CPU를 대조하고 시작 PID 누락·역행·종류 변경이 있으면 합계를 불완전으로 처리한다. 모든 비교 표본에서 이 검사를 통과했다. Chrome root는 종료 counter 뒤에 정리하므로 같은 CPU를 자식 합계에 중복하지 않는다. probe 자체 비용은 남는다.

JSON의 heap/RSS는 Node await 직후 차이이며 retained heap·프로세스 전체 RSS·peak를 뜻하지 않는다. PR CPU 중앙값은 낮아졌지만 개별 반대 결과와 변경하지 않은 squash의 편차도 크다. 전체 메모리 감소나 모든 작업에서 CPU 절감이 입증됐다고 주장하지 않는다. probe와 C source는 VSIX에 포함하지 않는다.

## 제외한 실험

이미 준비된 Native UNTR index를 별도 read-only 사본으로 빌리는 사전 검사 실험은 배포에서 제외했다. 같은 수의 미추적 항목 교체 후 디렉터리 mtime을 복원하는 검사에서, 원래 Native 경로는 변경을 찾았지만 실험은 clean을 반환했다. 초기 통과/실패 로그·후보 source·불리한 CPU 수치를 함께 보관했다. 원래 사전 검사로 완전히 복구했고, 검증된 완료 후 조회 축소만 배포한다. `/private/tmp/gsc-goal45-rejected-private-change-layout/manifest.json`에 후보 파일 SHA-256이 있다.

모든 원시 결과·실패·소스 SHA-256과 개별 작업 수치는 같은 이름의 JSON에 있다. Marketplace 별도 상태 조회, foreground Host, OS 포커스 전환, 강제 reload는 하지 않았다. 기존 eslint 미설치/미선언 상태는 변경하지 않았다. 실제 Captain의 index·refs·파일·config, 사용자 stash·복구 snapshot·보존 PR worktree는 수정하거나 삭제하지 않았다.
