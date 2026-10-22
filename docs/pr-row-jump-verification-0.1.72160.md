# PR 행 이동 검증 — 0.1.72160

기준 버전은 0.1.72159, 커밋은 `b382969b7036067472964edc3a5834cbc22ef90a`다.
All branches에서 클릭한 PR 커밋이 로컬에 있어도, 무관한 local/remote ref가
없는 객체를 가리키면 `rev-list`가 먼저 실패해 직접 객체 조회에 도달하지 못했다.
catalog가 준비된 뒤 ref가 손상되는 경우도 포함한다.

전체 이력 조회가 일반 Native 종료 오류로 실패하면 선택한 OID를 기존의
읽기 전용 batch-check와 제한된 log로 검증한다. commit 객체와 실제 표시할
행을 확인한 경우에만 성공을 알린다. custom 필터 오류, 취소, 시간 제한,
출력 제한과 종료 중인 프로세스는 이 복구 경로로 재조회하지 않는다.
OUTPUT에는 `graph commit window history unavailable; checking selected target`
로그와 종료 코드·후보 수를 남긴다.

## 확인한 결과

- 수정 전 Native 회귀 검사에서 unrelated local/remote ref 2건과 등록된
  panel 메시지 경로 1건이 실패했다. custom 범위 유지 검사는 통과했다.
- 배포 사본에서 Native Git·PR 이동·필터·refresh 수명·index 보존 검사 77건을
  통과했다. TypeScript 검사와 production build도 통과했다.
  취소 직후 직접 조회를 시작하지 않는 경우와 missing/tree 객체를 성공으로
  처리하지 않는 경우도 검사한다.
- 같은 임시 Git 저장소 시나리오와 production HTML/CSP/JS를 연결한 headless
  Chromium에서 실제 PR 버튼에 Enter를 입력했다. 390×844, 768×1024,
  1440×900 모두 수정 전에는 이동에 실패하고 수정 후에는 대상 행이 표시됐다.
- 세 크기의 완료 화면을 캡처하고 직접 확인했다. 대상 제목의 시작과 강조,
  Graph 포커스, 좁은 화면의 overlay drawer 닫힘을 확인했다. 원본 HEAD,
  index, config, 작업 파일과 손상 ref의 바이트가 유지되고 browser 오류는 없다.
- 기존 PR 이동의 로드 전/후·넓은 Graph·가로 스크롤·로딩·한국어 실패/재시도·
  늦은 응답·동일 context·검색 결과 25개 headless 검사가 통과했다.
  새 스타일·버튼·문구는 추가하지 않았다.

초기 production drawer를 닫지 않아 첫 live driver가 toolbar를 누르지 못한
시도는 이동 회귀 근거에서 제외했다. 일반 Escape로 drawer를 닫은 뒤 같은
절차로 수정 전후를 비교했다. 브라우저 실행이 차단된 sandbox 시도도 제외한다.

원시 로그는 `/private/tmp/gsc-pr-row-ref-before.log`,
`/private/tmp/gsc-pr-row-release-native-final.log`,
`/private/tmp/gsc-pr-row-current-browser-approved.log`,
`/private/tmp/gsc-pr-row-live-before-corrected.log`,
`/private/tmp/gsc-pr-row-live-after.log`에 있다. 배포용 소스 사본의 live 검증은
`/private/tmp/gsc-pr-row-live-release.log`에 따로 기록한다.
live 결과 JSON은 `/private/tmp/gsc-pr-row-live-failure.json`과
`/private/tmp/gsc-pr-row-live-success.json`이다.

이 검증은 소유한 임시 저장소와 headless 화면에서 수행했다. 사용자 창의
포커스를 전환하거나 강제로 다시 로드하지 않았다. 실 GitHub 응답 속도,
사용자 저장소에서 같은 ref 손상이 실제 원인인지, 기존 VS Code 창의 활성
확장 버전은 확인했다고 주장하지 않는다. 별도 Marketplace 점검은 하지 않는다.
진행 중인 별도 작업트리 성능 후보는 이 배포에 포함하지 않는다.

## 배포 산출물

`gitsimplecompare-0.1.72160.vsix`는 1,019,788바이트이며 SHA-256은
`d727a32d6a9178198f6329ae5e57a99ae3c8ffe9f2f6f88ab255d7b45b48c25b`다.
126개 runtime 파일을 배포 소스와 대조했고 0.1.72159 대비 변경된 runtime은
`dist/extension.js`뿐이다. rebase helper와 웹뷰 리소스는 동일한 바이트다.
별도 성능 후보의 두 진단 문자열이 bundle에 없다는 점도 검사했다.
산출물 검증 결과는 `/private/tmp/gsc-release-72160-artifact.json`에 남긴다.
