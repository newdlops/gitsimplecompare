# PR 행 이동 검증 — 0.1.72162

기준 버전은 0.1.72161, 커밋은 `05d9fa99f881300de122eff92ac4be1c08b6070f`다.
사용자가 보고한 증상은 PR 목록의 행 이동 버튼을 눌러도 반응이 없는 것이다.
소유한 임시 저장소에서 다음 실패 조건을 실제로 재현했다.

checkout 이후 도달 가능한 이력이 같으면 Graph는 행을 재사용하고 다음 페이지
조회에 정렬 재검증을 예약한다. 그 사이 PR 점프가 Native Git에서 새로운 구간을
읽어도 이 예약이 남았다. 새 구간의 렌더링이 자동 `loadMore`를 보내면 이전 예약이
실행돼 이력 맨 앞을 다시 읽었고, 방금 찾은 PR 행이 사라졌다.

이제 현재 세대의 commit window를 실제 채택한 시점에만 이전 정렬 예약을 해제한다.
실패·취소·오래된 결과는 기존 그래프의 예약을 유지한다. 기존 Graph/PR 스타일,
버튼·번역, branch 필터, Native Git 조회와 작업 파일 보존 경로를 사용한다.
추가 캐시·타이머·백그라운드 Git 조회는 만들지 않는다. OUTPUT의 기존
`graph commit window sent`와 `graph page load started` 로그에서 구간을 확인할 수 있다.

## 검증 결과

- Native Git으로 1,800개 커밋을 만들고 실제 checkout 후 갱신 경로와 등록된
  패널 메시지 callback을 실행했다. 수정 전 newer/older pagination 두 경우 모두
  성공한 점프의 대상 행을 잃었다. 수정 후 대상 보존과 Native topo-order의 연속성,
  중복·누락 없음, 실패한 점프의 기존 상태 보존을 확인했다.
- 관련 Native Git·패널·조회 수명 검사 58개와 TypeScript 검사를 통과했다.
  기존 branch 필터·단건 PR 객체 가져오기·잘못된 ref 복구·취소 검사도 포함한다.
- production HTML/CSP/JS와 실제 GraphPanel을 연결한 headless Chromium에서
  Checkout Branch 메뉴 → PR 이동 버튼에 Enter → 자동 pagination을 수행했다.
  390×844, 768×1024, 1440×900 모두 수정 전에는 범위가 0으로 돌아가며 대상이
  사라졌고, 수정 후에는 범위 420을 유지하며 대상 행이 실제 viewport에 남았다.
  원본 HEAD·refs·index·config·작업 파일을 바이트로 대조했고 browser 오류는 없다.
- 세 크기의 완료 화면을 직접 확인했다. PR 강조·제목·Graph 포커스와 좁은 화면의
  overlay drawer 닫힘을 검사했다. 기존 PR 이동·Graph 갱신 브라우저 검사
  41개도 통과했다. 한국어 실패·재시도, loading, 키보드, 검색 결과, 늦은 응답,
  가로 스크롤, 같은 context 갱신과 기존 axe 검사를 포함한다.

원시 기록은 `/private/tmp/gsc-pr-jump-pagination-before.log`,
`/private/tmp/gsc-pr-jump-pagination-after.log`,
`/private/tmp/gsc-pr-pagination-live-before-approved.log`,
`/private/tmp/gsc-pr-pagination-live-after.log`,
`/private/tmp/gsc-pr-pagination-webview.log`에 있다.
실제 화면 전후 결과는 `/private/tmp/gsc-pr-pagination-before.json`과
`/private/tmp/gsc-pr-pagination-after.json`에 있다.
macOS sandbox가 Chromium 실행을 막은 첫 시도는 제품 회귀 결과에서 제외했다.

이 검증은 소유한 임시 저장소와 headless 화면에서 수행했다. 사용자의 활성
VS Code 세션에서 동일한 원인이었는지 확인했다고 주장하지 않는다. 사용자 창의
포커스 전환, 강제 reload와 별도 Marketplace 점검은 하지 않는다.
진행 중이던 별도 작업트리 성능 후보·진단 변경은 이번 배포에 포함하지 않는다.
