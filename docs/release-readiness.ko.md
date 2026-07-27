# UI Overhaul 배포 준비 상태

기준일: 2026-07-27

## 결론

현재 워크트리로 생성한 `git-simple-compare-0.1.72006.vsix`는 **읽기 전용 PR 리뷰 UI를 포함한 배포 후보**로 사용할 수 있다. Marketplace 공개 게시와 버전 변경은 수행하지 않았다.

## 이번 배포에 포함하는 안전 경계

- Changes/Reviews sidebar 전환과 Personal/Management 리뷰 큐는 공개한다.
- Review Center의 PR 정보, 파일, 커밋, 체크, 활동 조회는 공개한다.
- GitHub 리뷰 쓰기(메타데이터 변경, 리뷰 제출, 댓글, Viewed/resolve, suggestion 적용, bulk 관리)는 기본값에서 숨긴다.
- `gitSimpleCompare.experimentalReviewWrites`는 기본값 `false`이며, 명시적으로 켜도 host의 메시지 경계에서 다시 검사한다.
- 기본 차단이 발생하면 `Git Simple Compare` OUTPUT 채널에 원인과 메시지 종류를 남긴다.

이 경계는 일회용 GitHub 저장소에서 실제 쓰기 검증을 완료하기 전 원격 PR 상태가 바뀌는 것을 막는다. 실험 설정을 켜는 것은 공개 릴리스의 일반 사용 경로가 아니다.

## 확인한 증거

- `npm run check-types`
- `npm run compile`
- `npm run package`
- 핵심 node test 16개: sidebar 상태/manifest, review count cache, typed failure, review write gate
- `npm run test:webview`: 7개 통과
- `npm run test:a11y`: 5개 통과
- `npm run test:visual`: 5개 통과. 280/360/480px sidebar, Management, Review Center 대표 화면을 실제 Chromium으로 확인했다.
- `npm run test:extension`: 격리된 Extension Development Host smoke 통과
- `npx @vscode/vsce package --no-yarn`: VSIX 생성 및 파일 목록 검증 통과
- `unzip -l`로 `extension/dist/extension.js` 포함을 확인했고, 개발 메타데이터·테스트 결과·로그·문서는 VSIX에서 제외했다.

## 의도적으로 남긴 배포 전/후 과제

- 공개 Marketplace 게시 전에는 게시할 버전과 CHANGELOG 항목을 담당자가 확정한다.
- 전체 `npm test`는 기존에 15분 안전 제한에 걸렸으므로 이번 배포 판정에 사용하지 않았다. 오래 걸리는 테스트 원인 분리는 백로그로 남긴다.
- `experimentalReviewWrites`의 실제 GitHub write smoke는 일회용 저장소와 권한 있는 계정이 준비된 뒤 별도 과제로 수행한다. 통과 전에는 기본값을 바꾸지 않는다.
- VSIX를 실제 사용자 VS Code 프로필에 설치하거나 Marketplace에 게시하지 않았다. 둘 다 사용자 환경/외부 상태를 바꾸므로 명시적 승인 뒤 수행한다.
