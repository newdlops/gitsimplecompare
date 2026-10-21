# PR people and selected discard — 0.1.72131

PR 목록·상세·hover에 저자와 리뷰 요청/승인/변경 요청 상태를 표시한다. 기존 VS Code 테마·Codicon·키보드 흐름을 유지하며, 미조회·조회 실패·완료한 빈 목록·상한 초과를 구별한다. 저자는 첫 요약에 포함하고, 리뷰어 연결은 기존 20개 metadata 묶음에서만 각 8개까지 읽는다. 80개 PR fixture의 요청 수는 기존 5개로 유지하며 개별 PR 추가 요청이나 외부 avatar 요청은 없다. 기존 metadata 요청의 응답 payload는 증가한다.

선택 discard는 일반 파일을 index로, 충돌 파일을 확인한 HEAD로 복원한다. HEAD에 없는 충돌 경로는 삭제로 해소한다. 확인 이후 달라진 충돌 stage·새 Native 작업을 쓰기 직전에 다시 검사한다. 다른 staged/unstaged/미추적 파일, HEAD/ref, merge/rebase/cherry-pick 상태는 보존한다. 확인창 문구로 충돌 해소 의미를 알리며, 선택 경로 밖 삭제는 거부한다.

## 실제 Native 비교

기준 cb34abe238182b789dc437ab219810991db2a870 대 작업 트리. Git 2.53.0, 파일 1,000개·히스토리 1,000개·side branch 100개, 별도 미추적 파일 20,000개. 동일 harness를 before/after/after/before로 직렬 실행했다. 각 source 2회이며 준비·사후 정확성 검증을 제외한 GitService.discard 서비스 호출만 계측한다. 확인창부터 UI 갱신까지의 측정은 아니다.

| 경우 | 기준 ms (전체 표본) | 후보 ms (전체 표본) | 중앙값 ms |
| --- | --- | --- | --- |
| 추적 파일 하나 버리기 | 861, 386 | 405, 256 | 623.5 → 330.5 |
| 선택 미추적 파일 500개 삭제 | 167, 303 | 172, 104 | 235 → 138 |

작은 선택의 분류 응답은 488890 → 0 bytes, Git 프로세스는 2 → 2다. Node CPU 중앙값은 17.5 → 7ms다. 대량 삭제는 Git 프로세스 1 → 1, 최대 동시 삭제 1 → 8이다. 대량의 분류 응답은 502280 → 543280 bytes, Node CPU 중앙값은 79.5 → 139.5ms로 **증가**했다. 선택하지 않은 20,000개 파일과 index/HEAD가 네 실행 모두 보존됐다. 전체 CPU/RSS 또는 실제 Captain의 속도 향상을 주장하지 않는다.

## 검증과 수정 이력

- 서로 다른 Node 검증 52개가 통과했다. 최종 discard/명령 12개, PR/명령 22개, bulk 경로 7개 그룹은 모두 성공했다. 준비 조회 실패의 알림·무변경 처리도 명령 3개 그룹에서 확인했다. 중복 이름은 합계에서 한 번만 센다. 기존 Git 명령 안전성 12개도 첫 후보 그룹에서 통과했다.
- 0.1.72130 대비 재현은 2개 성공/7개 예상 실패다. 첫 후보는 17개 성공/4개 실패였다. HEAD에 없는 충돌 파일에 Native restore가 실패하는 실제 문제 3개와 문구 assertion 1개를 수정했다. HEAD 경로 조회 이후 새로 stage한 해결 내용을 덮어쓰는 별도 재현도 먼저 실패시킨 뒤 쓰기 직전 검사를 추가해 통과시켰다.
- merge/rebase/cherry-pick의 수정/삭제 충돌, linked worktree, 선택하지 않은 conflict stage, staged 보존, 확인 취소, 확인 후 추적 전환, 같은 HEAD에서 abort/restart, literal·tab·개행 이름, 저장소 외부 경로 거부를 검증했다. 300개 추적 경로의 stdin discard도 통과했다.
- 실제 headless Chromium의 기존 9개 목록 검증과 새 people 3개가 통과했다. 최종 줄바꿈 수정 뒤 people 3개를 다시 통과시켰다. 390×844·768×1024·1440×900의 안정된 screenshot을 직접 확인했다. 80개 목록, 긴 이름, 한/영 문구, reviewer 검색, 키보드 상세 열기/돌아오기, 페이지 오류·수평 overflow·추가 refresh 요청 없음이 포함된다.
- typecheck 성공. 공개 GitHub 저장소에 대한 읽기 전용 GraphQL 요청으로 reviewer 연결 schema를 확인했다. Native VS Code 확인창의 실제 시각 검증은 하지 않았으며, 실제 Git과 mock 확인창으로 동작을 검증했다. 포커스 변경·강제 reload·Marketplace 상태 조회는 하지 않았다.

## 다른 작업의 진단

push/pull/fetch/interactive-rebase 실제 버튼 네 흐름의 최종 Native 상태를 확인하고 선택적 계측으로 Git/FS 대기를 나눠 관찰했다. Native 대기 합집합은 각각 887.6/1155/708.5/2068.3ms, 관측 FS 대기는 8.4/8.8/9.5/78.1ms였다. async FS wrapper의 관찰 비용이 있어 비교 속도 자료로 사용하지 않는다. 작은 filesystem 미세 최적화보다 Native 작업 대기가 큰 관측이다.

ref-format 실험은 제품에 적용하지 않았다. 조건부 format도 전체 short-ref 조회 7,038회를 유지했고, 분리한 두 query는 509회로 줄었으나 전체 시간이 일관되게 줄지 않았다. Native 이름의 모호성 처리와 두 query 사이 상태 일치 검증이 해결되지 않아 기존 Graph ref 조회를 유지한다.

원본 표본·쿼리 수·소스 해시·검증 이름·개인 경로의 증거 SHA-256은 [JSON](discard-pr-0.1.72131.json)에 기록한다. 실제 사용자 저장소, stash, 복구 snapshot, 보존된 PR worktree는 변경하지 않았다. 전체 최적화 목표는 계속 진행 상태다.
