# UI Overhaul 배포 준비 상태

기준일: 2026-07-27

## 결론

현재 워크트리로 생성한 `git-simple-compare-0.1.72006.vsix`는 **PR 리뷰 쓰기 기능을 포함한 배포 후보**로 사용할 수 있다. Marketplace 공개 게시와 버전 변경은 수행하지 않았다.

## 이번 배포에 포함하는 안전 경계

- Changes/Reviews sidebar 전환과 Personal/Management 리뷰 큐는 공개한다.
- Review Center의 PR 정보, 파일, 커밋, 체크, 활동 조회는 공개한다.
- GitHub 리뷰 쓰기(메타데이터 변경, 리뷰 제출, 댓글, Viewed/resolve, suggestion 적용, bulk 관리)는 기본값에서 사용 가능하다.
- `gitSimpleCompare.reviewWritesEnabled`의 기본값은 `true`다. 사용자가 이 설정을 끄면 UI와 host 메시지 경계가 함께 읽기 전용으로 전환된다.
- 설정으로 차단된 요청은 `Git Simple Compare` OUTPUT 채널에 원인과 메시지 종류를 남긴다.

실제 GitHub 쓰기 E2E는 별도 검증이 필요하다. 이번 경계에서는 사용자가 실제 계정과 대상 저장소에서 수행하며, 문제가 있으면 설정을 꺼 즉시 읽기 전용으로 되돌릴 수 있다.

## 확인한 증거

- `npm run check-types`
- `npm run compile`
- `npm run package`
- review write 관련 node test 44개: management/bulk, draft, comment mutation, suggestion apply, queue failure/cache, write gate
- `npx @vscode/vsce package --no-yarn`: VSIX 생성 및 파일 목록 검증 통과
- `unzip -l`로 `extension/dist/extension.js` 포함을 확인했고, 개발 메타데이터·테스트 결과·로그·문서는 VSIX에서 제외했다.

## 의도적으로 남긴 배포 전/후 과제

- 공개 Marketplace 게시 전에는 게시할 버전과 CHANGELOG 항목을 담당자가 확정한다.
- 전체 `npm test`는 기존에 15분 안전 제한에 걸렸으므로 이번 배포 판정에 사용하지 않았다. 오래 걸리는 테스트 원인 분리는 백로그로 남긴다.
- 기본 활성화 뒤의 browser/Extension Host/GitHub E2E는 실행하지 않았다. 사용자 검증 범위다.
- 실제 GitHub write E2E는 일회용 저장소와 권한 있는 계정에서 수행한다. 통과 전까지는 `gitSimpleCompare.reviewWritesEnabled`를 끄면 읽기 전용으로 사용할 수 있다.
- VSIX를 실제 사용자 VS Code 프로필에 설치하거나 Marketplace에 게시하지 않았다. 둘 다 사용자 환경/외부 상태를 바꾸므로 명시적 승인 뒤 수행한다.
