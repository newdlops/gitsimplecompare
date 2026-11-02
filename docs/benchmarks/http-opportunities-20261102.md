# HTTP HTTPS 잔여 성능 개선 후보

조사 기준은 배포된 `0.1.72185`, 커밋 `590c8fc75217c7839aefe04c45d0439d1e698a99`다. 기존 직접 HTTP 전환·snapshot·페이지 종료·연결 재사용 개선 이후에 남은 후보 6개를 정리했다. P1·P4·P5는 제품 함수를 통제된 경계에서 실행해 현재 대기 순서를 확인했고, P2·P3은 실제 호출부와 저장소 구조를 확인했다. P6은 API 동등성을 먼저 입증해야 하는 실험이다.

이번 결과는 후보 조사이며 제품 구현이나 새로운 속도 개선 완료를 뜻하지 않는다. [실행 관찰 원본](http-opportunities-evidence-20261102.json)에 세 탐침의 입력 조건과 이벤트 순서를 기록했다.

## 우선순위

| 후보 | 우선순위 | 남은 비용 | 개선 방향 | 근거 수준 |
| --- | --- | --- | --- | --- |
| P1 | 높음 | PR 검색의 리뷰 tail 뒤에 커밋 tail 시작 | 독립 pagination을 같은 요청 한도 안에서 병렬 실행 | 실제 제품 함수의 순서 재현 |
| P2 | 높음 조건부 | Explorer 비교에서 이미 가진 파일 목록을 REST로 다시 읽음 | 최신 앵커 검증 후 완전한 비이름변경 파일 snapshot 재사용 | 정적 호출 경로와 cache 계약 |
| P3 | 중간 | warm preview도 첫 100개 커밋 요약을 전송 | cache 힌트가 있으면 bootstrap을 앵커·제목·본문으로 축소 | 현재 query와 기존 측정 |
| P4 | 중간 | HTML fragment의 한 단계가 모두 끝나야 자식 시작 | 완료한 부모의 자식을 바로 예약하는 pipeline | 실제 제품 함수의 순서 재현 |
| P5 | 중간 | inspector cold scan에서 느린 다른 포트까지 기다림 | 도착한 HTTP 결과부터 PID를 검증해 첫 정상 target 반환 | 실제 로컬 HTTP·WebSocket 재현 |
| P6 | 실험 | OAuth 저장소 목록의 불필요한 REST 필드 | 필요한 필드만 요청하는 GraphQL 대안 비교 | 코드와 공식 schema 확인 |

권장 착수 순서는 P1, P2, P5다. P3·P4는 반복 사용 또는 특정 네트워크 지연 분포에서 효과가 나고, P6은 기존 REST+ETag 방식보다 나아진다는 증거가 있어야 채택한다.

## P1 검색 결과의 리뷰와 커밋 후속 페이지 병렬화

실제 경로는 [pullRequestSearchService.ts](../../src/git/pullRequestSearchService.ts)의 텍스트·번호·SHA 검색 → [pullRequestSearchReads.ts](../../src/git/pullRequestSearchReads.ts)의 `completeSearchPullRequests`다. 현재 73행에서 `fetchRemainingReviewThreadCommentCounts`가 끝날 때까지 기다린 뒤 74–76행에서 커밋 페이지를 완성한다. 검색 종류 사이의 병렬화와 검색 내 동일 PR 결과 공유는 이미 구현돼 있지만, 한 결과를 완성하는 두 연결은 여전히 순차다.

리뷰와 커밋 모두 후속 페이지가 있는 PR을 넣은 관찰 결과는 `review:start → review:end → commits:start → commits:end`였다. 대역 지연은 리뷰 60ms, 커밋 20ms였으며 댓글 2개·커밋 2개가 완전하게 반환되는 것도 확인했다. 이는 현재 순차 실행의 증거이며 병렬 구현 후 측정치는 아니다.

두 연결의 요청 수는 그대로 두고 대기 구간을 겹칠 수 있다. 요청 슬롯 여유가 있는 이상적인 경우 완료 시간은 두 지연의 합보다 큰 쪽에 가까워질 수 있다. 검색 전체의 기존 4개 요청 한도, 앵커 검증, 부분 오류 전파, 취소, 진행 중 결과 공유를 보존해야 한다. 한 연결 실패 후 다른 요청을 고아 상태로 남기지 않는지도 검증한다.

## P2 Explorer 비교에 완전한 파일 snapshot 재사용

[comparisonService.ts](../../src/git/comparisonService.ts)의 `comparePullRequest`는 자체 `reusableFiles`가 없으면 `PullRequestService.getChangedFiles`를 호출한다. [pullRequestPreviewFiles.ts](../../src/git/pullRequestPreviewFiles.ts)의 `fetchPullRequestChangedFiles`는 세션을 만든 뒤 매번 REST 파일 페이지를 읽는다. 직전 개선으로 CLI 실행과 불필요한 마지막 페이지는 줄었지만, [pullRequestDetail.ts](../../src/git/pullRequestDetail.ts)가 저장한 파일 snapshot을 이 경로에서 사용하지는 않는다.

[githubPullRequestSnapshots.ts](../../src/git/githubPullRequestSnapshots.ts)는 현재 인증·저장소·PR 번호·head/base·파일 합계가 일치하는 완전한 `path/additions/deletions/changeType` 배열을 이미 보관한다. 이를 최신 앵커 요청 이후 안전하게 재사용하면, 예를 들어 이름 변경이 없는 파일 1000개의 기존 snapshot이 있을 때 파일 REST 10페이지 대신 작은 앵커 1회를 읽는 설계가 가능하다. 이 10→1은 조건부 설계 계산이며 구현 후 실측이 아니다. 파일 100개 이하는 요청 수 이득이 없을 수도 있다.

현재 REST DTO는 `previous_filename`을 `oldPath`로 보존한다. [공식 GraphQL 필드 목록](https://docs.github.com/en/graphql/reference/pulls#pullrequestchangedfile)에는 이전 이름 필드가 없다. 따라서 rename/copy·알 수 없는 상태·불완전한 합계는 REST로 보완해야 한다. 이름 변경을 조용히 손실시키는 전체 GraphQL 대체는 권하지 않는다. fresh auth/head/base/count, 401 무효화, 잘림 표식, binary·submodule·타입 변경의 동등성을 검증한다.

## P3 warm preview bootstrap의 커밋 필드 생략

[pullRequestPreviewRemote.ts](../../src/git/pullRequestPreviewRemote.ts)의 `BOOTSTRAP_QUERY`는 항상 `commits(first: 100)`을 포함한다. `fetchPreviewBootstrap`은 이 응답을 받은 뒤에야 같은 앵커의 기존 요약을 찾는다. 직전 N6 개선은 후속 커밋 페이지를 제거했으며, 첫 페이지의 전송 bytes는 남아 있다.

기존 [통제된 측정](http-next-performance-20261101.json) N6의 개선 후 warm 요청은 1회지만, 응답 body는 각 표본에서 13563 bytes였다. 이 수치는 당시 fixture의 값이며 실제 GitHub 트래픽 평균이 아니다.

snapshot 힌트가 있으면 최신 제목·본문·head/base만 요청하고, 그 성공으로 현재 인증을 확인한 뒤 완료 요약을 찾는 방식을 검토할 수 있다. body 접근 전에 최신 인가를 확인하는 순서는 유지한다. 힌트가 계정 변경 등으로 빗나가면 커밋 첫 페이지를 별도로 읽어야 하므로 요청 1회가 추가될 수 있다. cold·warm·잘못된 힌트를 함께 비교하고, 값이 없을 때는 기존 전체 query를 유지한다.

## P4 중첩 HTML fragment의 단계 대기 제거

[githubWebHtml.ts](../../src/git/githubWebHtml.ts)의 `readFragmentHtml`은 한 깊이의 모든 `context.read`를 `Promise.all`로 기다린 뒤 다음 깊이의 URL을 만든다. 빠른 부모가 자식 URL을 이미 반환했어도 같은 단계의 느린 부모를 기다린다.

부모 A 15ms, 부모 B 80ms, A의 자식 C 15ms를 둔 실제 함수 관찰에서 A와 B가 병렬로 시작했고, C는 B 종료 뒤에 시작했다. 최대 동시 실행은 기존 한도인 2개였다. 각 부모가 완료될 때 자식을 발견·예약하면 마지막 느린 부모와 다른 가지의 자식 대기를 겹칠 여지가 있다.

이는 연결 풀이나 병렬 수를 다시 늘리는 제안이 아니다. 최대 동시 2개, URL 중복 제거, 120개 URL·깊이 2 제한, 동일 PR/origin, 취소와 기존 HTML 병합 우선순위를 유지해야 한다. 특히 완료 순서로 병합해 suggestion 선택 결과가 바뀌지 않도록 결과 순서와 실행 순서를 분리한다.

## P5 inspector cold scan의 전체 HTTP 응답 대기 제거

[nativeDiffOverlayInspector.ts](../../src/providers/nativeDiffOverlayInspector.ts)의 `findInspectorWebSocketUrlForPid`는 warm port 힌트를 이미 사용한다. 남은 cold 경로는 첫 포트를 읽은 뒤 나머지 포트의 `urlsForPort`를 모두 기다리는 94행의 `Promise.all`을 거쳐 PID 검증을 시작한다.

로컬 실제 HTTP 서버 세 개를 사용해 첫 포트는 빈 목록, 정상 target은 즉시 응답, 무관한 포트는 100ms 뒤 빈 목록을 반환하게 했다. 이벤트는 `target-http → unrelated-http:end → target-pid`였고 전체 발견은 약 109.6ms였다. 정상 target이 먼저 도착해도 느린 무관한 포트가 PID 검증 시작을 늦추는 것을 확인했다.

도착한 결과부터 PID를 확인하고 첫 소유 target을 찾으면 남은 소유 probe를 취소하는 방식이 후보가 된다. 기존 port hint 최적화와 달리 cold 경로의 대기를 줄이는 변경이다. localhost/예상 포트 검사, 실제 PID 확인, profile 분리, PID 재사용·stale hint 방어, 자기 요청만 취소, 실제 socket close를 보존한다. PID를 확인하지 않고 HTTP 응답 속도만으로 target을 고르지 않는다.

## P6 OAuth 저장소 목록의 필요한 필드만 조회하는 실험

[githubRepositoryCatalog.ts](../../src/git/githubRepositoryCatalog.ts)는 `/user/repos`를 읽어 이름·설명·공개 여부·보관 여부를 추리고 clone URL을 직접 만든다. [repositorySetup.ts](../../src/commands/repositorySetup.ts)의 목록 UI는 이 축약 DTO를 사용한다. 전체 REST 저장소 객체의 필요 없는 필드는 전송·JSON 파싱 비용으로 남는다.

필드 선택이 가능한 GraphQL viewer 저장소 connection을 비교할 수 있다. 다만 [공식 User schema](https://docs.github.com/en/graphql/reference/users#user)의 `affiliations`와 `ownerAffiliations`는 서로 다른 인자이며 기본값도 있다. REST의 owner/collaborator/organization_member 범위와 동일하다고 가정하지 않는다. 조직·팀을 통한 private 접근, fork, archived, 정렬과 전체 페이지 집합이 같다는 것을 먼저 입증해야 한다.

기존 catalog는 동시 요청 공유와 ETag 재검증을 이미 제공한다. GraphQL 전환은 warm REST 304의 이점을 잃어 오히려 느려질 수 있다. 현재 OAuth만 쓰고 Git·gh에 의존하지 않는 온보딩 계약도 유지해야 한다. cold 응답 bytes·파싱 비용과 warm 304·권한 범위·rate limit을 같이 비교해 개선되지 않으면 기존 경로를 유지한다.

## 제외한 제안과 조사 범위

- 같은 저장소/브랜치의 댓글 전체 load는 `PullRequestCommentCache.inFlightLoads`에서 이미 공유한다. HTML context 간 request 공유는 실제 겹치는 제품 호출이 충분한지 입증하기 전까지 우선 후보로 세지 않았다.
- comment permalink를 hash 없이 모으면 대부분 같은 PR의 기본/files URL로 합쳐지고 context memo도 적용된다. `readCommentPages` 루프가 순차라는 사실만으로 큰 병렬화 이득을 주장하지 않는다.
- `PullRequestStackService.getSnapshot`과 예전 eager commit 조회는 여전히 제품 호출부가 없는 경로여서 제외했다.
- API·HTML 연결 풀, 압축, ETag, REST 최종 페이지 종료, typed read 세션, 댓글 선표시, 현재 PR bootstrap, 혼합 metadata batch, 검색 중복 공유는 이미 적용돼 있다.
- 사용자 인증 경로 순서를 무조건 바꾸거나 장기 실패 cache로 인증 시도를 생략하는 안은 계정/권한 선택을 바꿀 수 있어 제외했다.
- native Git 네트워크 작업과 외부 브라우저 로그인은 확장이 소유한 HTTP reader와 구분했다. HTTP/2·DNS cache·전역 동시성 증가는 병목 계측 없이 권하지 않는다.

제품 네트워크 진입점·서비스 호출부·cache 경계를 검색했고 세 대기 순서를 실행 관찰했다. 실제 GitHub 계정에 쓰기 요청을 보내거나 제품 코드를 바꾸지는 않았다. 이번 목록의 효과를 확정하려면 각 후보 구현 전후 payload 동등성, 요청 수·bytes·첫 표시·완료 시간, 실패·취소·인증 경계 검증이 필요하다.
