# OAuth 저장소 목록 GraphQL 실험

P6의 결론은 기존 REST + ETag 유지다. 실제 계정에서 읽기 전용 API를 호출했으며,
GraphQL의 작은 응답이 현재 목록 계약이나 응답 지연을 개선한다는 증거를 얻지 못했다.
제품에는 GraphQL 목록 경로를 추가하지 않았다.

## 결과

| 항목 | REST | GraphQL projection |
| --- | ---: | ---: |
| 전체 목록 수 | 60 | 61 |
| 첫 페이지 압축 전송 body | 25,974 B | 7,955 B |
| 첫 페이지 압축 해제 body | 321,100 B | 7,955 B |
| cold p50 / p95 | 664.55 / 1,227.73 ms | 1,151.71 / 1,285.69 ms |
| warm p50 / p95 | 657.72 / 735.97 ms | 1,053.48 / 1,217.82 ms |
| warm 응답 | 304, body 0 B | 200, body 7,955 B |

전송량 비교는 네 필드만 요청한 최소 쿼리다. 전체 동등성 확인에는 정렬·fork·owner
유형 확인용 필드를 추가했다. latency는 같은 HTTPS/1.1 풀과 압축 요청 조건에서
각 7개 표본으로 관측한 값이며, 서비스 전체의 성능 추정이 아니다. 이 표본의 p95는
가장 큰 관측값이다. JSON 파싱 p50은 1.076ms에서 0.056ms로 감소했지만 총 지연은 늘었다.

## 동등성 판정

[User schema](https://docs.github.com/en/graphql/reference/users#user)의 `affiliations`와
`ownerAffiliations`에 OWNER·COLLABORATOR·ORGANIZATION_MEMBER를 모두 지정했다.
[RepositoryAffiliation](https://docs.github.com/en/graphql/reference/repos#repositoryaffiliation)과
[REST affiliation](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)의
범위를 기준으로 비교했다. 두 인자를 모두 지정하면 1개가 추가됐고, 어느 한쪽을 기본값으로
두면 REST 목록의 5개가 누락됐다. 공통 항목의 DTO 필드와 상대 정렬 순서는 같았다.
각 GraphQL 조회 뒤 REST는 계속 304였으므로 관측된 REST 목록 변경으로 차이를 설명할 수 없다.

추가 항목은 동일 인증으로 직접 REST 조회가 가능한 private fork였다. 이는 목록 집합 차이이며,
인가되지 않은 정보 노출이라고 단정하지 않는다. 특정 fork를 임의로 제외하는 규칙은 추가하지 않았다.

표본에는 private·조직 저장소와 fork가 포함됐지만 archived 항목과 팀 전용 권한은 별도로 입증하지
못했다. 전체 목록이 한 페이지여서 live cursor 연속성도 입증하지 못했다. 단일 gh 인증 실험은
VS Code OAuth 앱의 모든 권한 조합을 대신하지 않는다. 이런 미입증 범위와 실패한 집합·지연 게이트를
감안해 기존 OAuth 전용 REST 경로를 유지한다. 기존 catalog·ETag·취소·온보딩 검사 28개가 통과했다.

재현 명령과 집계 원문은 [JSON](oauth-catalog-projection-20261102.json)에 있다.
[실험 스크립트](../../scripts/benchmark-github-catalog.mjs)는 `--live`를 명시해야 실행되며
토큰·저장소 이름·응답 원문·ETag를 기록하지 않는다. 제품의 Git/gh 의존성을 추가하지 않는다.
