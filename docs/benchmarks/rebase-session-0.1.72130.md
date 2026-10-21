# Rebase 복구 상태 저장 — 0.1.72130

같은 호출 안에서 Git이 해석한 private 상태 경로와 검증한 directory 위치만 공유한다. HEAD/ref/index/config와 native rebase 세대는 새로 확인한다. 확인 대화상자나 다음 동작까지 경로 scope를 유지하지 않는다.

| Native 조회 대상 | 이전 → 현재 프로세스 |
| --- | ---: |
| Checkpoint | 3 → 2 |
| 파일 정보가 준비된 시작 세션 | 6 → 5 |
| 완료 결과 기록 | 4 → 2 |
| 정지 결과 기록 | 6 → 3 |
| edit 세션 복원 | 13 → 12 |
| 충돌 세션 복원 | 11 → 10 |

기존 코드에서 linked metadata 교체 후 다른 저장소에 상태를 쓰는 문제, 임시 파일 기록 뒤 교체를 감지하지 않는 문제, 쓰기/rename 실패 뒤 파일이 남는 문제와 같은 HEAD의 다른 브랜치로 바뀐 계획 저장을 격리 Native 저장소에서 재현했다. 새 코드는 고유 임시 파일을 배타적으로 만들고, 게시 직전 연결을 다시 확인하고 실패 시 자신이 소유한 파일만 정리한다. V1 JSON, 원래 커밋 본문과 파일 목록을 보존한다. 같은 저장소의 동시 세션 갱신을 직렬화하는 CAS는 이번 범위에 포함되지 않는다.

## 실제 버튼 비교

0.1.72129와 후보 source를 before/after/after/before/before/after 순서로 직렬 실행했다. 파일 1,000개, 배경 커밋 1,000개, 로컬 브랜치 100개와 공유 upstream 80개를 사용한다. 각 source의 기본 editor 경로를 유지했다. 버전별 세 표본의 중앙값이다.

| 대상 | 이전 | 현재 |
| --- | ---: | ---: |
| 실제 버튼 → 최종 Graph(ms) | 2035 | 2178 |
| 등록 callback 처리(ms) | 1832 | 1942 |
| 전체 버튼 경로 Git 프로세스(개) | 35 | 31 |
| 관찰 Node CPU(ms) | 181 | 212 |

모든 표본의 Native HEAD/tree/메시지와 최종 Graph의 refs/부모/local-only 표시 및 정리된 작업트리가 일치했다. 실제 production HTML/CSP/JS 버튼과 등록 callback을 통과하지만 VS Code 창/transport/picker는 대역이고 확인 응답은 즉시 반환한다. 전경 창이나 OS 포커스는 사용하지 않았다.

표본 수가 작고 실행 환경의 변동이 있어 모든 작업이나 사용자 저장소의 체감 속도로 일반화하지 않는다. 느린 표본도 JSON에 남긴다. Node CPU는 관찰 프로세스와 Playwright transport 범위이며 Git/editor/Chromium/OS의 전체 CPU·메모리 절감 수치가 아니다.

## 회귀 검증

고유 항목 61개가 통과했다. 첫 그룹 51개가 통과했고 추가 그룹의 복원 조회 수 기대값 두 개가 감소한 실제 값과 달라 실패했다. 정확한 새 수와 private 경로 분리를 검사하도록 고쳐 두 복원 테스트를 다시 통과했다. 기존 사용자 편집/충돌/복구 검사는 유지했다. 타입 검사도 통과했다.

정상/linked worktree, 호출 사이 scope 해제, 실제 edit pause 연결, 조회 직후와 임시 기록 직후의 metadata 교체, 쓰기/rename 오류, 다른 호출이 소유한 임시 파일 충돌, 동일 HEAD의 브랜치 교체 및 staged/unstaged/untracked 복구를 확인했다. push/pull/fetch/rebase/merge/PR/cherry-pick/checkout과 최신 Graph·자원 전체 목표는 계속 진행 중이다.
