# Push 준비 단계의 promisor 다운로드 제거 — 0.1.72127

부분 clone의 원격 게시 이력을 확인할 때 `cat-file --batch-check`가 모르는
commit을 자동 fetch하는 문제를 실제 Git에서 재현했다. 로컬 존재 확인 batch에
`GIT_NO_LAZY_FETCH=1`을 지정해 결측 tip을 그대로 제외하고 추가 다운로드를 막았다.
실제 push와 필요한 객체 조회에는 이 옵션을 확장하지 않는다.

| Native Git 검증 | 수정 전 | 수정 후 |
| --- | ---: | ---: |
| streamed metadata 조회의 추가 fetch | 1 | 0 |
| buffered metadata 조회의 추가 fetch | 1 | 0 |
| 모르는 commit이 로컬에 다운로드됨 | 두 경로 모두 발생 | 두 경로 모두 없음 |

원격은 모두 소유한 임시 local bare 저장소다. Trace2의 실제 자식 `fetch`를
세었고, 모르는 객체의 존재와 pack 목록을 확인했다. 수정 후 HEAD·index·설정도
그대로 유지된다. 원본 호출자의 DAG 환경·취소 신호·제한 시간을 복사하며 입력
옵션을 변경하지 않는지 streamed/buffered 경로에서 각각 확인한다.

최종 관련 Node 테스트는 **30개 통과, 실패·취소·건너뜀 0개**다. 새 Native
재현 테스트 두 개는 수정 전 모두 실패했고 수정 후 모두 통과했다. 기존 push의
50MiB 게시 이력, 실제 push URL 분리, 빈 목적지 lease, 설정·HEAD 변경 감지도
같은 실행에 포함했다. 타입 검사와 최종 18개 Native Git/production renderer
시나리오도 통과했다. 최종 화면의 HEAD·refs·부모·local-only metadata를 새
Native 조회와 비교하며 marker 오류가 삼켜져도 성공으로 처리하지 않는다.

검증 Git은 macOS의 Git 2.53.0이다. Native 회귀 테스트는 2.45 미만에서
건너뛰도록 명시했고, 이전 Git의 동작이나 외부 서버 전송 시간 개선은 주장하지
않는다. Git 공식 문서의 [no-lazy-fetch 환경 변수](https://git-scm.com/docs/git)를
사용하며 사용자 저장소 설정을 기록하지 않는다.

이전 버전과 최신 성능 비교의 전체 표본은
[18개 작업·4개 버튼 보고서](full-operation-audit-0.1.72126.md)에 있다.
그 비교는 0.1.72112 → 0.1.72126의 누적 변경을 측정한 것으로, 이번
한 가지 수정의 실행 시간 개선으로 환산하지 않는다. 전체 목표는 계속 진행 중이다.
