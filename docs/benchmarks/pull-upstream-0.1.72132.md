# Pull upstream gate — 0.1.72132

정상 upstream이 있는 pull의 준비 단계는 후보 원격 branch와 ahead/behind 수치를 필요로 하지 않는다. Native rev-parse --verify --quiet --symbolic-full-name @{upstream} 한 번으로 현재 ref를 확인하고, 미설정/gone일 때만 기존 전체 설정 화면을 읽는다. 실제 PullService의 새 checkout·작업 상태·설정 확인과 충돌/stash 복구는 그대로 유지한다. 전역 캐시나 watcher의 오래된 상태를 사용하지 않는다.

원격 alias 2,117개인 Native 재현에서 gate는 Git 5회 → 1회, 출력 37,033 bytes → 256 bytes 미만이다. 로컬 upstream(remote=.), detached, unborn, gone을 구별하고, 손상된 설정이나 저장소 오류는 설정 부재로 바꾸지 않고 전파한다. known-absence 분류의 Native 오류 문구는 이 조회에만 LC_ALL=C를 적용한다.

## 실제 버튼 비교

기준 7e4ba5ee2422c53e9c156159859209c837048213 대 작업 트리. 파일 1,000개·히스토리 1,000개·side branch 100개, 외부 네트워크 없는 local bare 원격을 사용했다. 같은 harness로 before/after/after/before/before/after를 직렬 실행해 각 source 3회를 비교했다. 실제 제품 HTML/CSP/JS의 Pull 버튼과 등록된 callback을 거치며, 준비와 초기 PR/stack hydration은 측정 밖이다. 클릭부터 최종 일치 publication의 renderer ACK까지 확인한다.

| 지표 | 기준 전체 표본 | 후보 전체 표본 | 중앙값 |
| --- | --- | --- | --- |
| handler ms | 754, 557, 2266 | 1998, 139, 206 | 754 → 206 |
| 최종 Graph ms | 1522, 912, 2944 | 2773, 317, 444 | 1522 → 444 |
| host Git 호출 | 16, 16, 16 | 12, 12, 12 | 16 → 12 |
| 관측 Node CPU ms | 153, 162, 191 | 155, 96, 127 | 162 → 127 |

느린 후보 2,773ms와 기준 2,944ms를 포함해 표본을 모두 보존한다. Node CPU는 benchmark와 Playwright transport만 포함하며 Native Git·Chromium·hook·OS CPU/RSS를 포함하지 않는다. 실제 Captain/GitHub 성능이나 전체 OS 자원 절약을 주장하지 않는다. Git 호출은 확장 실행기의 host 호출 수이며 Native 자식 프로세스 수와 다르다.

## 계측의 초기 조회 겹침 수정

첫 여섯 표본에서는 기존 settle가 Graph와 marker만 기다리고 ready에서 비동기로 시작한 PR/stack busy를 기다리지 않았다. 일부 클릭 구간에 해당 초기 조회 다섯 개가 겹쳤다. 그 시리즈의 최종 Graph 중앙값은 913 → 944ms, Node CPU는 137 → 174ms로 더 나빴다. 기록을 남기고 headline 표본에 합치지 않았다.

harness가 실제 graph-pr-list busy의 마지막 완료를 확인하도록 고친 뒤 같은 도구를 두 source에 적용해 다시 여섯 번 비교했다. 수정 뒤 Native 호출은 기준 16회/후보 12회로 각각 세 표본 모두 일치했다. 제품의 초기 PR 병렬 처리나 표시 시점을 바꾸지 않았다.

## 검증

- 서로 다른 Node 검증 24개 성공. 기존 pull 복구/충돌/stash ownership 12개와 새 gate/설정 흐름 12개다. 첫 그룹 20개와 최종 gate 그룹 12개에는 중복 8개가 있다. 이전 source의 Native 재현은 5회 조회 때문에 먼저 실패했다.
- index/config/HEAD·선택하지 않은 작업 내용 보존, linked worktree, 새 설정 변경 감지, gone 시 기존 전체 선택지와 취소, 실제 pull의 재검증, 저장소/설정 오류 전파를 확인했다. types 통과.
- 수정 전 계측 6개와 수정 후 비교 6개, 추가 push/fetch/interactive-rebase 버튼 3개 모두 실제 Native HEAD/ref/parent/local-only와 최종 표시가 일치했다. 오류를 toast로 숨긴 결과는 성공으로 세지 않는다.
- 제품 HTML/CSS/컨트롤은 변경하지 않았다. headless renderer로 기능을 확인했으며 Native VS Code 창·선택기 transport는 mock이다. 포커스 변경, 강제 reload, Marketplace 상태 점검을 하지 않았다.

원본 표본과 source·증거 SHA-256은 [JSON](pull-upstream-0.1.72132.json)에 있다. 전체 push/pull/fetch/rebase/merge/PR squash·cherry-pick/checkout 및 Graph 최신성·안정성·최소 자원 목표는 계속 진행 상태다.
