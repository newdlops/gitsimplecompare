# GitHub Review Test Fixtures

이 디렉터리는 GitHub Pull Request review 구현의 `GhRunner` contract test에 쓰는
합성 응답만 보관한다. 실제 조직·저장소·계정·PR·댓글·소스 코드·token을 넣지 않는다.

## 파일 형식

모든 JSON fixture는 다음 최소 형식을 지킨다.

```json
{
  "schemaVersion": 1,
  "source": "gh api graphql",
  "operation": "viewer",
  "response": {
    "status": 200,
    "headers": {
      "x-ratelimit-remaining": "4999"
    },
    "body": {}
  }
}
```

- `source`: `gh api`, `gh api graphql`, `gh search prs`, `gh pr checks` 중 하나다.
- `operation`: 서비스가 읽기 쉬운 안정된 operation 이름이다. URL/query/body 원문을
  넣지 않는다.
- `response.status`: HTTP 또는 gh가 해석한 응답 status다.
- `response.headers`: 모두 소문자 header name과 문자열 value를 쓴다.
- `response.body`: endpoint가 반환한 JSON body다. secret과 실제 private data를
  포함하지 않는다.
- `response.stderr`: 오류 mapping을 검증할 때만 redaction된 synthetic 문자열을 쓴다.

## 이름 규칙

`{area}.{scenario}.json`을 사용한다. 예: `queue.search.page1.json`,
`threads.pending-resolved.json`, `errors.rate-limit.json`.

fixture가 API version 또는 특정 schema capability에 의존하면 body 최상단의
`meta`에 그 근거를 기록한다. 테스트는 fixture에 없는 API field를 정상 응답으로
가정하지 않는다.
