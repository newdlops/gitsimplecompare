# PR 행 이동 검증 — 0.1.72158

기준 커밋은 `078a27813943b0f8657b5d7778e1cc13c326b58b`다.
사용자가 All branches를 선택해도 원격 브랜치 목록을 준비하는 동안,
목록 조회가 실패했을 때, 손상 ref를 제외한 검증 목록을 사용할 때는
내부적으로 `filtersRefs`가 켜진다. 이전 이동 코드는 이를 사용자의 custom
선택과 동일하게 취급해 목록 밖 PR 객체를 확인하지 않았다. 아직 검증된
ref가 없는 경우에는 조회 자체가 생략됐다.

이제 사용자의 All branches 선택에서는 클릭한 commit/PR의 객체를 직접
확인한다. 객체가 없으면 기존의 취소 가능한 단건 PR 조회와 객체 전용
fetch를 사용한다. 빈 catalog에서는 암묵적인 전체 ref 조회를 실행하지
않는다. custom 모드의 선택 범위, 손상 ref 격리와 표시용 ref 필터는 유지한다.
OUTPUT의 `graph commit window checking direct target outside catalog` 로그에
후보 개수와 검증된 ref 개수를 기록한다.

## 검증 결과

- 수정 전 새 Native 재현 5건이 실패했다. pending/ready/error 상태의 내부
  catalog 제한 3건, 빈 pending catalog 1건, 미수신 PR 객체 fetch 1건이다.
- 수정 후 관련 Native Git·필터·pager·패널 검사 31건을 통과했다. 실제
  missing-object ref를 가진 임시 저장소의 등록된 패널 메시지 callback으로
  PR window 게시까지 확인했다. invalid ref 원문, HEAD, index와 config를
  보존하며, 객체 fetch는 refs·FETCH_HEAD·작업 파일도 보존한다.
- headless Chromium에서 PR 이동·Graph 갱신·상세 최적화 43건을 통과했다.
  실제 버튼과 키보드, 로드 전/후 행, 긴 ref와 넓은 Graph, 검색 결과,
  로딩·한국어 실패·재시도·취소·늦은 응답·동일 context 갱신을 포함한다.
- 390×844, 768×1024, 1440×900의 이동 후 화면을 캡처하고 직접 확인했다.
  좁은 화면의 drawer 닫힘, 행 강조, 제목 노출과 Graph 포커스를 검증한다.
  기존 axe 검사도 통과했다. UI의 스타일·버튼·문구는 변경하지 않는다.
- TypeScript 검사와 VSIX production build를 통과했다. 실제 Git/gh 경계는
  임시 저장소·bare remote·격리된 gh 응답으로 검증하며, 실 GitHub 네트워크의
  응답 속도나 현재 실행 중인 VS Code 세션의 활성 버전은 주장하지 않는다.

원시 로그는 `/private/tmp/gsc-pr-jump-catalog-before.log`,
`/private/tmp/gsc-pr-jump-fetch-before.log`,
`/private/tmp/gsc-pr-jump-catalog-after.log`,
`/private/tmp/gsc-pr-jump-safe-ref-route.log`,
`/private/tmp/gsc-pr-jump-72158-browser.log`에 남긴다.
사용자 창의 포커스 전환, 강제 reload와 별도 Marketplace 점검은 하지 않는다.
진행 중이던 별도 성능 측정 harness 변경은 이번 배포 커밋에 포함하지 않는다.

VSIX는 `gitsimplecompare-0.1.72158.vsix`이며 1,019,078바이트다.
SHA-256은 `84ea2b7902f20f7c7c59701deb15f73dd33ebd1bd37f7f6f404e6b2a41538c78`이다.
126개 runtime 파일을 작업 소스와 대조했으며 0.1.72157 대비 변경된 runtime은
`dist/extension.js`뿐이다. rebase helper와 기존 웹뷰 리소스는 동일한 바이트다.
