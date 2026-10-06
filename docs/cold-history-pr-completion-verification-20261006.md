# 첫 파일 이력 표시·PR 전체 완료 검증 — 2026-10-06

대상 버전: Git Simple Compare 0.1.72084.
0.1.72083의 캐시·요약 표시 개선에 이어, 캐시가 없는 파일의 첫 표시와
PR의 전체 정보 완료를 다룬다.

## 파일 이력

실제 Git trace에서 `--follow`가 rename 판정을 위해 많은 커밋의 tree/diff를
탐색하는 비용을 확인했다. 경로별 구간 분할 후보는 동일한 27개 이력을
반환했지만 실제 측정에서 더 느려 제품에 반영하지 않았다.

- 기존 `git log --follow --raw --numstat -z -M`을 불변 HEAD에서 한 번 실행한다.
  `runGitStream`으로 완성된 첫 커밋을 먼저 표시하고 같은 프로세스가 전체 탐색을 끝낸다.
- UTF-8 분할과 NUL record를 보존한다. 마지막 미완성 record는 미리 표시하지 않는다.
  진행 표시는 한 번으로 제한해 반복 UI 렌더와 파싱을 줄인다.
- 기존 128 MiB 출력 상한을 유지하고, 1 MiB보다 큰 출력은 부분 파싱을 중단한다.
- 부분 결과는 표시 전용이다. 전체 조회 성공과 HEAD/context 재검증 뒤에만
  메모리·디스크 캐시를 갱신한다. 기존 소비자 공유·동시 조회 두 개·취소 수명을 유지한다.
- 로딩·부분·완료·오류·중단 상태를 구분한다. 중단된 부분 목록은 완료로 보이지 않는다.
  파일명 옆에 로딩 안내를 표시하며 키보드 포커스, disclosure와 입력 draft를 보존한다.

실제 27개 이력 파일을 새 캐시 인스턴스로 번갈아 조회했다. 디스크 캐시는 사용하지 않았다.

| 조회 순서 | 첫 표시 | 전체 완료 | 최종 커밋 수 |
| --- | ---: | ---: | ---: |
| 스트림 1 | 502 ms (1개) | 3,215 ms | 27 |
| 전체 대기 1 | 1,379 ms (27개) | 1,379 ms | 27 |
| 전체 대기 2 | 1,278 ms (27개) | 1,278 ms | 27 |
| 스트림 2 | 94 ms (1개) | 1,425 ms | 27 |

OS/Git의 준비 상태는 순서에 따라 달라지므로 첫 실행과 뒤 실행의 전체 시간 차이를
구현 속도 개선으로 해석하지 않는다. 이번 개선은 전체 traversal이 끝나기 전
완성된 커밋부터 사용할 수 있게 하는 것이다. 네 번의 불변 필드·rename·통계가 같고
HEAD와 사용자 index hash도 조회 전후 같았다. 전체 native traversal 비용은 남아 있다.

## PR 전체 정보

- 첫 요약 조회와 20개 단위 metadata 묶음, 동시 실행 네 개를 유지한다.
- metadata의 최초 commit/review-thread connection 크기를 각각 100으로 바꾼다.
  후속 cursor를 모두 따라가므로 100개보다 큰 PR도 생략하지 않는다.
- commit OID, 정확한 댓글·파일 수, pageInfo와 완료 플래그를 보존한다.
- 빠른 후속 페이지 오류가 peer 취소로 가려지는 경우 원래 오류를 다시 전달한다.

같은 실제 저장소의 80개 PR을 기존·수정 서비스 번들로 비교했다.

| 항목 | 기존 | 수정 |
| --- | ---: | ---: |
| 80개 요약 준비 | 1,660 ms | 1,628 ms |
| 모든 정보 완료 | 5,473 ms | 5,111 ms |
| 전체 GitHub 요청 수 | 10 | 5 |

최종 전체 데이터와 pageInfo는 정확히 같았다. 네트워크 한 차례 비교이므로
완료 시간이나 개선 비율을 보장하지 않는다. 요청 감소가 확인된 변경이다.
후속 페이지가 더 많은 후보와 작은 metadata 묶음은 실제 측정에서 더 느려 제외했다.

## 자동 검사·시각 검사

- 변경 관련 Node 테스트 94개 통과. 실제 Git, 캐시와 consumer 수명에 더해
  모든 byte 경계·UTF-8·rename·미완성 record, 표시 실패와 mutation, 부분 결과의
  캐시 배제, 소비자별 취소와 늦은 완료 차단을 검사했다.
- PR 133개 commit / 151개 review thread의 전체 pagination과 빠른 오류도 검사했다.
- TypeScript 검사와 `git diff --check` 통과.
- Chromium 웹뷰 기능 테스트 86개 통과. History 로딩·부분·완료·오류·빈 상태,
  키보드 diff 열기, 포커스/disclosure/draft 유지, PR 부분/전체 표시를 포함한다.
- History의 390×844, 768×1024, 1440×900 화면을 직접 확인했다.
  작은 영역에서 로딩 안내가 아래로 잘리던 문제를 파일명 옆 표시로 수정했다.
  재검증에서 로딩 안내의 본문·viewport 경계와 가로 overflow를 확인했다.
- 테스트 호스트는 실제 확장의 Codicon과 대표 VS Code dark-theme 변수를 주입한다.
  제품 CSS는 사용자 테마 토큰을 유지한다. 실제 설치 창 확인은 아래에 기록한다.

Impeccable 검사에서 Codicon과 테스트용 Menlo/12px는 VS Code 재현에 필요한 값이다.
해당 파일·해당 값에만 이유를 기록해 예외 처리했다. 기존 CSS의 10/12/14/16px 및
5px radius advisory 14건은 변경 줄 밖의 기존 항목으로 남겼다. 전체 스타일 감사나
임의의 기존 화면 재설계는 이번 작업에 포함하지 않았다. 디자인 sidecar는 현재
DESIGN.md의 typography·경계·로컬 브랜치 정리 지침과 동기화했다.

위 14건은 이후 0.1.72085의 [UI 스타일 권고 정리](ui-style-recommendations-verification-20261006.md)에서 해결했다.

## 실측 자료

`/private/tmp/gsc-cold-history-pr-full-20261006/`에 원본을 보관했다.
주요 파일은 `history-final-comparison.json`, `history-stream.json`,
`pr-full-baseline.json`, `pr-full-100-100-20.json`, `node-tests-final.log`다.
브라우저 PNG는 `test-results/playwright/`에 있다.

## 실제 설치·배포 확인

- 기존 VS Code에 0.1.72084를 설치하고 같은 창을 Reload Window로 적용했다.
  설치된 실행 번들·History JS/CSS·한국어 bundle과 패키지/생성 파일의 hash가 일치했다.
- 기존 27개 파일 이력은 실제 Host의 디스크 캐시에서 495 ms에 복원됐다.
- 캐시가 없는 다른 파일은 834 ms에 첫 커밋을 표시했고, 3,135 ms에 전체 34개로
  완료됐다. 실제 History 34개 화면과 통계를 확인했다.
- 실제 그래프의 PR 요약 80개는 1,644 ms에 준비됐고 전체 데이터는 7,025 ms에
  완료됐다. OUTPUT의 요청 수는 5, paginationTasks는 0이었다.
  실제 drawer의 `80 loaded pull requests`, 파일/commit/댓글 수와 활성 액션을 확인했다.
- Mac·SentinelOne은 재시작하지 않았다. 사용자 Git 설정과 stash는 변경하지 않았다.
  실제 화면의 Changes 143개, Stashes 43개, Worktrees 9개와 monitor 검사 0개를 확인했다.
- VSIX: `/private/tmp/gitsimplecompare-0.1.72084.vsix`.
- VSIX SHA-256: `3b54b42b63b8c9f6eb22770eb45032598a31cf186892b434f1d1552c6e7a4478`.
- 실행 번들 SHA-256: `6d3d098de61f44475f5d051f93fb7ff201639b0614f7375e8bc1d355cdb28ff4`.
- 구현 커밋 `8003d26`을 origin/main에 푸시했다.
- `env NODE_OPTIONS=--use-system-ca vsce publish --packagePath
  /private/tmp/gitsimplecompare-0.1.72084.vsix`로 Marketplace 게시에 성공했다.
  Node 기본 CA의 issuer 오류는 macOS 신뢰 저장소로 해결했으며 TLS 검증은 유지했다.
- 정확한 0.1.72084 공개 VSIX를 내려받아 전체 패키지 SHA-256이 위 값과 같음을 확인했다.
  공개 package.json의 publisher/version과 실행 번들도 설치·검증한 파일과 일치했다.
  공개 검증 시각은 2026-10-06 02:37:50 KST다.
  영수증은 `/private/tmp/gsc-cold-history-pr-full-20261006/public-release-receipt.json`에 있다.
