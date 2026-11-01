# HTTP HTTPS 추가 성능 개선 후보

조사일: 2026년 11월 1일. 기준 HEAD: `fd2a7b9960821a2e306c8ad2b7286e2dd39287e2`. 버전: `0.1.72184`.

기존 10개 개선 이후에도 실제 제품 호출 경로에 7개 후보가 남아 있다. 먼저 변경 파일 조회의 HTTP 세션 연결, 남은 REST 페이지 종료 판정, PR 생성 전후 읽기 전환을 검토하는 편이 좋다. 아래 요청 수는 현재 코드에서 유도한 조건부 수치이며, 추가 개선의 실제 GitHub 지연 시간은 측정하지 않았다. 제품 코드 변경 없이 호출 경로와 설계 후보를 조사한 결과다.

## 우선순위 목록

| 번호 | 우선순위 | 대상 | 줄일 수 있는 비용 | 효과가 생기는 조건 |
| --- | --- | --- | --- | --- |
| N1 | 높음 | PR 비교의 변경 파일 목록 | 페이지마다 실행하는 `gh` 프로세스 | HTTP 지원 정책과 확인된 저장소 문맥이 있음 |
| N2 | 높음 | 파일 목록과 SHA 연관 PR의 페이지 종료 | 정확히 100개 배수일 때 마지막 빈 요청 1회 | 마지막 페이지에 다음 Link가 없음을 확인 가능 |
| N3 | 중간 | PR 생성 전후 조회 | `gh pr list`, `gh pr view` 프로세스 최대 2회 | 지원되는 GitHub 환경이며 생성 전후 조회가 모두 실행됨 |
| N4 | 중간 | 재사용 가능한 PR과 신규 PR이 섞인 목록 | 혼합 metadata 묶음의 요청 2회를 1회로 합칠 가능성 | 같은 20개 묶음에 두 종류가 섞임 |
| N5 | 중간 | SHA 검색 결과의 PR 정보 보완 | 텍스트 결과와 연관 PR 사이의 중복 필드 조회 | 같은 PR이 두 검색 경로에 포함됨 |
| N6 | 중간 | 기존 PR 미리보기의 커밋 요약 | bootstrap 이후 커밋 후속 페이지와 첫 페이지의 중복 bytes | 동일 앵커의 완전한 요약이 이미 있고 원문 응답 캐시로 충족되지 않음 |
| N7 | 낮음 | 서로 다른 HTML 읽기 문맥 | TCP와 TLS 연결 재수립 | 같은 호스트를 연속 조회하고 현재 context별 Agent가 종료됨 |

N1은 전송 경로, N2는 페이지 수를 바꾸는 후보다. 같은 파일 조회에 적용될 수 있으므로 효과를 단순 합산하지 않는다. 중간 우선순위 항목은 사용 빈도와 응답 크기를 먼저 측정해야 한다.

## N1 변경 파일 조회에 읽기 세션 연결

실제 경로는 `commands/comparisonDecorations.ts`의 PR 선택 → `ComparisonService.comparePullRequest` → `PullRequestService.getChangedFiles` → `fetchPullRequestChangedFiles`다. `reusableFiles`가 있으면 기존 목록을 재사용하므로 이 경우는 이미 네트워크를 생략한다.

[pullRequestService.ts](../../src/git/pullRequestService.ts)의 `getChangedFiles`는 `{owner}/{repo}`를 넘기고, [pullRequestPreviewFiles.ts](../../src/git/pullRequestPreviewFiles.ts)의 `fetchPullRequestChangedFiles`는 세션을 만들지 않은 기본 `readGitHubInteractive`로 페이지를 읽는다. REST descriptor는 있지만 [githubReadRuntime.ts](../../src/git/githubReadRuntime.ts)의 `prepare`는 `readSession`이 없으면 반환하고 `execute`는 CLI로 실행한다. 따라서 descriptor만으로 직접 HTTP 경로에 들어가지 않는다.

제안은 논리 조회 전체를 읽기 세션 하나로 감싸고 완료 시 문맥을 검증하는 것이다. 이미 확인된 github.com 저장소와 지원 정책에서는 페이지별 CLI 실행 비용을 줄일 수 있다. 최초 저장소 확인이나 Enterprise·프록시 정책 때문에 CLI를 써야 하는 경우는 유지한다. HTTP API 요청 수 자체는 줄지 않는다.

검증에는 실제 `getChangedFiles` 진입점에서 CLI/HTTP/credential 횟수를 기록하고, 1·100·101개 파일, 최초 scope 확인, 인증 변경, 취소, rename, 상한 잘림을 포함한다. 현재 코드는 정적 호출 경로로 확인했으며 전환 후 시간 단축은 아직 측정하지 않았다.

## N2 남은 REST 페이지의 종료 판정

[pullRequestPreviewFiles.ts](../../src/git/pullRequestPreviewFiles.ts)의 `readPagedResult`는 `/comments`에만 `responseMode: page`를 적용한다. `/files`는 배열 길이가 100보다 작아야 종료한다. 이 코드에서 100개 파일은 `[100, 0]`, 200개는 `[100, 100, 0]`의 응답을 읽어야 종료한다. 알려진 마지막 Link를 쓰면 각각 1회, 2회로 끝낼 여지가 있다. 101개처럼 마지막 페이지가 짧으면 이 이득은 없다. 30페이지 상한은 별도로 보존한다.

[pullRequestSearchService.ts](../../src/git/pullRequestSearchService.ts)의 `searchByCommitHash` 역시 연관 PR 배열 길이 100을 기준으로 다음 페이지를 요청한다. 이 경로도 같은 후보에 포함한다. 기존 개선의 댓글·Conversation 경로와는 다른 endpoint다.

[pullRequestPreviewRemote.ts](../../src/git/pullRequestPreviewRemote.ts)의 `fetchRemotePreviewCommit`도 `files.length < 100`으로 종료하지만 응답이 배열이 아닌 `{sha, files}` 객체다. 적용하려면 객체 내부 파일 배열을 처리하는 adapter와 실제 endpoint 페이지 동작 검증이 필요하다. GitHub 문서도 commit 파일 pagination을 별도로 설명하므로 PR 파일 배열과 똑같이 처리한다고 가정하지 않는다.

[GitHub pagination 문서](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)는 Link의 `next`를 통한 페이지 이동과 단일 페이지의 Link 생략을 설명한다. [PR 파일 문서](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files)는 최대 3000개 파일을, [commit 문서](https://docs.github.com/en/rest/commits/commits#get-a-commit)는 파일 pagination과 3000개 상한을 설명한다.

검증은 0·99·100·101·200개, next/prev만 있는 Link, 헤더를 알 수 없는 응답, 304, Enterprise API base, 상한 도달을 포함한다. 헤더를 모르는 상황을 완료로 오판해 파일을 누락시키면 안 된다.

## N3 PR 생성 전후의 읽기 전환

실제 호출부는 [pullRequestPreviewPublish.ts](../../src/webview/pullRequestPreviewPublish.ts)의 `publishService.publishPreview`다. [pullRequestPublishService.ts](../../src/git/pullRequestPublishService.ts)는 변경 전에 `assertNoOpenPullRequest`에서 `gh pr list`를 실행하고, push 및 생성 후 `readPublishedPullRequest`에서 `gh pr view`를 실행한다. 두 읽기 모두 `runGh`를 직접 사용한다.

두 읽기를 typed HTTP 경로로 옮길 수 있다. 후속 조회는 생성 결과 URL의 정확한 PR identity를 활용할 수 있는지도 검토한다. 목표는 CLI 프로세스 비용이며 API 왕복 2회가 사라진다는 의미는 아니다. `gh pr create`와 native Git commit/push는 이 후보의 대상이 아니다.

생성 전 조회와 생성 후 조회는 쓰기 경계를 사이에 두므로 각각 최신 문맥으로 검증해야 한다. 같은 head의 기존 PR 차단, fork head 의미, 생성 후 조회 실패 시 fallback, commit/push 이후 실패 복구 정보를 보존한다. 사전 조회 결과를 캐시해 중복 방지 검사를 생략하지 않는다.

## N4 혼합 metadata 묶음 합치기

[pullRequestListReads.ts](../../src/git/pullRequestListReads.ts)의 `readPullRequestNodes`는 20개 단위로 읽는다. 한 묶음에 재사용 가능한 snapshot과 신규 항목이 섞이면 `readNodeBatch(..., false)`와 `readNodeBatch(..., true)`를 병렬 호출한다. 따라서 이러한 묶음 하나는 metadata 요청 2회를 만든다. 모두 신규이거나 모두 재사용 가능하면 이미 1회다.

항목마다 안정적인 connection 필드를 선택하는 alias query로 묶거나, 전체 목록에서 두 집합을 다시 묶는 방식을 비교할 수 있다. 20개 혼합 묶음의 2회→1회는 가능한 설계 목표이며 구현으로 검증된 수치가 아니다. 현재 두 요청이 병렬이므로 왕복 시간이 절반이 된다고 볼 수도 없다.

새 query의 GraphQL 비용·bytes·오류 처리를 함께 비교한다. 원래 PR 순서, mutable 필드 최신성, head/base 변화 시 해당 PR만 보완하는 동작과 부분 표시 시점을 보존해야 한다. 단순히 batch 크기나 동시성을 늘리는 제안은 아니다.

## N5 SHA 검색의 PR 정보 중복 보완 줄이기

[pullRequestSearchService.ts](../../src/git/pullRequestSearchService.ts)는 텍스트·정확한 번호·SHA 연관 검색을 이미 병렬로 실행하며, 완료 후 번호로 결과를 합친다. SHA 경로는 REST 연관 결과에서 번호를 모아 [pullRequestSearchReads.ts](../../src/git/pullRequestSearchReads.ts)의 `fetchSearchPullRequestsByNumber`로 정보를 다시 읽는다. 텍스트 검색도 PR 필드와 connection 보완을 수행한다.

같은 논리 검색에서 두 결과에 포함된 PR은 이미 읽은 완전한 정보를 공유할 여지가 있다. 우선 중복 PR 수와 추가 보완 요청 수를 계측한 뒤 적용 여부를 정한다. REST 연관 결과만으로 현재 DTO의 완전한 commit/review connection을 대체할 수 있다고 가정하지 않는다.

검색별 identity와 완료 여부를 검증하는 공유 계층이 필요하다. 조회를 직렬화해 첫 표시를 늦추거나, head가 달라진 두 결과를 합치지 않도록 한다. 중복이 없을 때의 비용 증가도 비교해야 한다.

## N6 미리보기 커밋 요약 재사용

[pullRequestPreviewRemote.ts](../../src/git/pullRequestPreviewRemote.ts)의 bootstrap은 최신 제목·본문·head와 첫 100개 커밋 요약을 함께 읽고, `fetchPreviewCommitSummaries`가 후속 페이지를 가져온다. [githubCommitSnapshots.ts](../../src/git/githubCommitSnapshots.ts)에는 이미 인증과 head/base/대상 branch에 묶인 완전한 커밋 요약 저장소가 있지만, 현재 preview 함수는 이를 조회하지 않는다.

최신 인증 응답으로 같은 앵커를 확인한 뒤 완전한 요약을 재사용하면 bootstrap을 유지하면서 후속 페이지를 생략할 수 있다. 커밋 C개이고 각 페이지가 100개이며 응답 캐시 미적중이라는 조건에서 최대 `max(0, ceil(C/100)-1)`개의 후속 요청이 대상이다. 100개 이하에서는 후속 요청 감소가 없다. bootstrap의 커밋 필드까지 조건부 생략하면 bytes를 줄일 여지가 있다.

현재 30초 원문 캐시가 이미 충족하는 요청은 추가 이득으로 세지 않는다. snapshot의 모든 OID, 제목, 작성자, 날짜가 preview 계약을 충족해야 한다. 최신 제목·본문 확인과 head 변경 시 중단은 유지한다. 기존 first-page 결합 개선을 다시 성과로 계산하지 않는다.

## N7 HTML 문맥 사이의 연결 재사용

[githubWebReadContext.ts](../../src/git/githubWebReadContext.ts)는 문맥별 transport를 만들고 종료한다. [githubWebTransport.ts](../../src/git/githubWebTransport.ts)는 허용된 환경에서 최대 2개 socket의 Agent를 소유하며 종료 시 destroy한다. 같은 문맥 안의 병렬 읽기·중복 제거·압축·연결 재사용은 이미 구현돼 있다.

추가 후보는 활성화 수명 안에서 범위를 제한한 Agent를 공유해 서로 다른 연속 조회 사이의 연결 재수립을 줄이는 것이다. 기존 [성능 보고서](http-followup-performance-20261101.md)는 context별 소유 Agent가 Node 22 global Agent보다 문맥 간 연결 재사용을 줄일 수 있음을 기록했다. 해당 로컬 측정은 이번 설계의 실제 GitHub 개선량을 뜻하지 않는다.

먼저 연속 HTML 조회에서 DNS/TCP/TLS와 첫 응답 시간을 분리 계측한다. 충분한 연결 비용이 관찰될 때만 적용한다. origin·정책 generation·인증 경계, proxy 소유 Agent, idle socket 상한과 TTL, context별 취소 격리, 비활성화 시 종료를 보존해야 한다.

## 제외하거나 보류한 항목

- `PullRequestStackService.getSnapshot()`은 `src`에서 제품 호출부를 찾지 못했다. Graph는 이미 전달된 목록으로 `getGraphSnapshot`을 사용한다. 예전 `gh repo view`와 대량 `pr list`를 현재의 주요 지연으로 계산하지 않는다.
- `fetchExistingPullRequestCommits()`의 eager 개별 조회도 `src`의 제품 호출부를 찾지 못했다. 현재 원격 preview는 `fetchRemotePreviewCommit`으로 선택한 commit을 읽는다.
- `GitHubCredentialProvider.acquire`는 동일 root·고정 환경의 진행 중 lookup을 이미 공유한다. 완료 token을 오래 캐시하는 제안은 추가하지 않는다.
- 비교용 변경 파일 응답은 patch를 DTO에서 버려도 REST가 보낸 patch bytes는 받을 수 있다. 다만 GraphQL metadata-only 대체는 rename 원래 경로·상태·줄 수의 동등성을 먼저 확인해야 하므로 독립적인 확정 후보로 세지 않았다.
- repository catalog ETag, inspector 포트 힌트, HTML 압축·최대 2개 병렬 처리, 댓글 선표시, typed refs/dependencies, Advance batch, Submit 선별 조회, opt-in blobless clone은 기존 적용 항목이다.
- native Git fetch/pull/push/clone, 브라우저 로그인용 `openExternal`, SVG namespace URL, 벤치마크 전용 네트워크는 추가 HTTP 제품 경로 개선량에서 제외한다.
- HTTP/2 전환·별도 DNS 캐시·전역 동시성 증가는 원인 계측 없이 우선 후보로 올리지 않는다.

## 검증 범위

저장소의 HTTP·HTTPS·`fetch`·`runGh`·typed reader 진입점을 검색하고 호출부를 추적했다. 위 근거는 기준 HEAD의 소스와 GitHub 공식 API 문서다. 이번 조사는 제품 실행, 실제 네트워크 벤치마크, 구현 후 회귀 테스트를 수행한 결과가 아니다. 다음 구현에서는 요청 수·CLI 수·새 연결 수·전송 bytes와 첫 표시 및 전체 완료 시간의 p50/p95를 함께 비교한다.
