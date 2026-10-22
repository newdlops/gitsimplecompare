# PR 행 이동 검증 — 0.1.72156

기준 커밋은 `d2e8d3ffb0538539800346b5af6a13f02122bb14`다.
기존 이동 코드는 세로 위치만 변경했다. 레인이 많거나 ref 배지가 길면
대상 행의 제목이 화면 오른쪽 밖에 남았고, 사용자가 가로로 많이 스크롤한
상태에서는 화면 왼쪽 밖에 남았다. 행을 찾아 강조해도 사용자는 이동 결과를 볼 수 없었다.

이제 명시적인 PR/커밋 이동에서 선택한 제목 한 개의 위치를 읽고, 제목의
시작 부분이 보이도록 Graph 컨테이너의 가로 위치도 조정한다. 이미 보이면
기존 위치를 유지한다. 후속 metadata 갱신은 강조만 복원하며 다시 스크롤하거나
포커스를 빼앗지 않는다. 기존 VS Code 토큰, Codicon, 버튼과 번역을 유지한다.

## 검증

- 수정 전 headless Chromium에서 72개 레인의 로드된 행·새로 로드한 행 이동
  6건이 모두 화면 노출 검사에 실패했다. 화면에는 빈 Graph 영역만 남았다.
- 수정 후 PR 이동·Graph 갱신·상세 최적화 브라우저 검사 43건을 통과했다.
  390×844, 768×1024, 1440×900에서 넓은 Graph, 긴 ref 배지,
  가로 스크롤 복구, 읽을 수 있는 위치 보존과 실제 버튼 클릭을 검사한다.
- 기존 키보드 이동·한국어 오류/재시도·로딩·reduced motion·검색 결과·
  저장소 교체·동일 context 새로고침·늦은 응답 무효화와 axe 검사도 포함한다.
- 관련 Native Git/패널 테스트 40건과 TypeScript 검사를 통과했다.
  객체 준비, ref/index/config/FETCH_HEAD 보존, 필터와 취소 경계를 포함한다.
- 화면 검증은 headless Chromium에서 수행한다. VS Code 창 포커스 전환,
  foreground Extension Development Host, 강제 reload와 별도 Marketplace 점검은 하지 않는다.

이 수정의 제품 변경은 `media/graph/graphPrMatching.js`에 한정한다.
진행 중인 별도 Native 브랜치 최적화는 작업트리에 보존하고 이번 배포에는 포함하지 않는다.
배포는 기준 소스에 이 수정·검증·버전 파일만 적용한 임시 디렉터리에서 빌드하며,
Native 번들과 나머지 runtime 파일이 0.1.72155와 같은 바이트인지 확인한다.

원시 검증 로그는 `/private/tmp/gsc-pr-row-wide-before.log`,
`/private/tmp/gsc-pr-row-wide-after.log`, `/private/tmp/gsc-pr-row-native-72156.log`에 남긴다.
수정 후에는 drawer 전환이 끝난 화면도 각각 캡처해 확인한다.
