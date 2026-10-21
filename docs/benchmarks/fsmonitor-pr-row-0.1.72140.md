# fsmonitor와 PR Graph 행 이동 수정 — 0.1.72140

기준 소스는 `e0da1d03df04faf3cf1ad2a7f032e08a924d0d09`다. 원래의 전체 Git 작업 속도·Graph 최신화·안정성·자원 절감 목표는 계속 진행 중이다. 이번 변경은 반복되는 macOS fsmonitor IPC 장애와 **Jump to Pull Request Row** 오류를 해결하는 범위다.

## 수정한 동작

- 쓰기 완료가 실패한 감시자 cooldown을 지우지 않는다. 준비에 성공한 소유 감시자도 5초 뒤 실제 IPC 응답을 재확인하고, 나중에 멈추면 소유 controller만 종료한다. 예상하지 못한 종료와 응답 실패에는 60초 cooldown을 둔다.
- index를 변경하는 Native 작업과 `diff --cached/--staged`는 builtin fsmonitor를 명령 범위에서 우회한다. daemon 시작·IPC 검사를 선행하지 않으며 사용자 hook과 저장소 설정은 보존한다.
- PR 이동은 대상 행을 강조하고 Graph에 키보드 포커스를 준다. 좁은 창의 overlay drawer는 닫아 행이 가려지지 않게 하고, 넓은 창의 side pane은 유지한다.
- 아직 로드하지 않은 PR 커밋을 찾을 때 후보 전체에 대해 topo 이력을 한 번만 읽는다. 후보 우선순위를 유지하며 실제 표시할 bounded window만 읽는다.
- 전체 브랜치 보기에서 후보가 ref 이력에 없으면 로컬 object를 한 번에 확인한다. 브랜치 삭제 뒤 남은 커밋도 표시하며 lazy fetch나 ref/index/config 쓰기를 하지 않는다. 명시적 브랜치 필터는 넘어가지 않는다.
- 로딩·실패·재시도를 영어/한국어로 표시한다. 새 이동과 취소는 해당 요청의 Git 읽기만 중단한다. 늦은 응답을 무시하고 metadata 갱신 뒤에는 강조만 복원해 사용자 스크롤·포커스를 다시 움직이지 않는다.

## 기능 검증

| 항목 | 결과 |
| --- | --- |
| fsmonitor의 세 가지 신규 재현 | 이전 25 통과·3 실패 → 수정 후 28 통과 |
| Native PR squash/replay와 Undo | 초기 Undo 2 실패를 cached diff 우회로 해결, 최종 3 통과 |
| 관련 Node 검사 | 서로 다른 82개 최종 소스 검사 통과, 남은 실패·취소·skip 0 |
| PR 이동·목록·상세·Graph 행 브라우저 검사 | 28 통과 |
| 실제 Graph HTML/CSP → 등록된 메시지 callback → Native Git → DOM | 390/768/1440px 모두 통과 |
| 타입 검사 | `npm run check-types` 통과 |
| lint | 기존 프로젝트에 eslint 설치/선언이 없어 `npm run lint` 실행 불가(exit 127) |

첫 81개 Node 실행 중 프로세스 검사 2개는 sandbox의 `spawn EPERM`으로 실패했다. 허용된 실행에서 5개 모두 통과했고, 최종 PR 후보·오류·요청 취소와 프로세스 검사 11개, 최종 PR hash 매칭 7개도 통과했다. 그 외 fsmonitor 관련 64개 검사와 해당 소스는 변경하지 않았다. 실패 기록은 제거하지 않았다.

Native 검사에서 80개 결측 후보와 실제 후보를 함께 주어도 `rev-list` 1회와 `log` 1회만 실행한다. ref 이력 밖의 로컬 커밋은 `rev-list`·`cat-file`·`log` 각 1회로 표시하며 HEAD·refs·index·config가 이전 값과 동일하다. 빈/명시적 필터, 비commit·결측 객체, 사전 취소와 이전 요청의 늦은 완료도 검사했다.

실제 Graph callback 검사는 임시 저장소의 ref 이력 밖 commit을 일반 PR 버튼 클릭으로 연다. Native `rev-list --parents`와 ref 기대값을 DOM/패널 결과와 비교한다. 최초 이동만 window 요청 1회를 보내고, 이후 같은 행 이동은 추가 요청이 없다. GitHub 목록 응답만 fixture로 대체하며 네트워크 속도 검사는 아니다. 처음 열려 있던 좁은 drawer는 Escape로 닫은 뒤 PR 목록을 여는 정상 절차를 사용했다. force-click이나 backend 메시지 직접 주입은 하지 않았다.

## 화면·접근성 검증

`ui-design-workflow`에 따라 기존 VS Code 토큰·Codicon·밀도를 유지했다. 390×844, 768×1024, 1440×900에서 일반 클릭과 Enter/Space, 이동 성공, 대기 중 metadata 갱신, 오류·키보드 재시도, merge 결과 우선순위, 저장소 교체, 이전 응답 무효화를 검사했다. 밝음·어두움·고대비, reduced motion과 PR 패널 axe 검사도 통과했다. 화면 검사와 기능 검사를 분리해 안정된 성공·로딩·한국어 오류 및 production CSP 캡처를 직접 확인했다. 실제 터치 기기는 검사하지 않았다.

Impeccable 기술 감사는 이 변경 범위에서 18/20(접근성 3, 성능 4, 반응형 3, 테마 4, 구현 일관성 4)이다. 새 차단 문제는 없다. detector는 기존 PR 상세 제목의 15px 글꼴이 문서 ramp 밖이라는 advisory 한 건을 냈다. 기존 표현을 유지하기 위해 이번 이동 수정에서 바꾸지 않았다. 기존 `.impeccable/design.json` sidecar도 오래된 상태이며 별도 `impeccable document` 작업으로 갱신할 수 있다.

## 범위와 한계

이번에는 전체 작업 지연·CPU·RSS의 전반적 개선을 주장하지 않는다. 실제 저장소 로그와 프로세스 형태는 읽기만 했다. Git/macOS 자체의 감시자 구현을 고친 것은 아니며 앱의 불필요한 시작·IPC 대기를 줄이고 소유 감시자 장애를 우회·정리한다. 5초 건강 캐시 중 감시자가 멈출 가능성과 기존 read timeout은 남아 있다.

Marketplace 상태 조회, foreground Extension Development Host, OS 포커스 변경과 강제 reload는 하지 않았다. Captain 등 실제 저장소, 외부 감시자, 사용자 stash·복구 ref·보존 PR worktree는 변경하지 않았다.

같은 이름의 JSON에 소스·증거 SHA-256과 원시 로그 경로가 있다. callback 검사의 일반 renderer 시간 필드는 이미 로드한 window 재사용 시 의미가 없어 기능 결과에서 제외했다. 원본도 별도로 보존하며 성능 측정값으로 사용하지 않는다.
