# HTTP HTTPS 추가 개선 검증

기준 구현은 `fd2a7b9`, 최종 제품 및 테스트 구현은 `2e8f6a7`이다. 기존 조사안 N1부터 N7까지 적용했다. 아래 수치는 실제 서비스 조립 또는 로컬 TLS 경계에서 검증한 작업량이며, 실제 GitHub 서버 응답 시간의 측정치는 아니다.

## 개선별 검증 결과

| 항목 | 조건 | 이전 | 개선 후 | 검증 |
| --- | --- | --- | --- | --- |
| N1 변경 파일 HTTP 세션 | 확인된 github.com 문맥, 1페이지 | CLI 경로 | HTTP 1회, CLI 0회, credential 1회 | `githubReadIntegration.test.ts` |
| N2 최종 REST 페이지 | 파일 100개, 알려진 마지막 페이지 | 빈 페이지까지 2회 | 1회 | PR preview 및 commit 파일 테스트 |
| N2 연관 PR 페이지 | 연관 PR 100개, 알려진 마지막 페이지 | 길이 기반 추가 요청 | 1회 | `pullRequestSearchEfficiency.test.ts` |
| N3 게시 전후 읽기 | 지원되는 HTTP 문맥 | `gh pr list` 및 `gh pr view` | 독립된 typed HTTP 세션 | 실제 publish 읽기 단계와 staged publish 회귀 테스트 |
| N4 혼합 metadata | warm 10개와 cold 10개 | metadata 요청 2회 | query 1회, alias별 검증 | `prListBatchLoading.test.ts` |
| N5 SHA 검색 중복 | 텍스트 PR 1, 연관 PR 1과 2 | 번호 1과 2 재조회 | 번호 2만 재조회 | 완료/진행 중 tail 공유 및 다른 head 격리 |
| N6 커밋 요약 | 같은 앵커의 201개 커밋 재조회 | bootstrap 포함 3회 | 최신 bootstrap 1회 | 인증/base 변경 미적중, head 변경 거절, 제목 누락 재사용 거절 |
| N7 HTML 연결 | 같은 인증의 연속 두 context | TLS 연결 2개 | TLS 연결 1개 | 실제 로컬 HTTPS 서버, CA 검증 유지 |

N1과 N3은 API 요청을 없애는 변경이 아니라 CLI 실행 비용을 줄이는 변경이다. N4의 이전 두 요청은 병렬이었으므로 요청 수 감소를 지연 시간 절반으로 해석하지 않는다. N5는 먼저 등록된 같은 검색 결과를 활용하고, 무관한 검색 응답을 기다리는 직렬화는 추가하지 않았다. N6은 기존 원문 캐시 적중을 추가 성과로 계산하지 않는다.

## 통제된 전후 시간 비교

`node scripts/benchmark-http-next.mjs`는 기준 소스를 archive하고 현재 소스와 같은 의존성으로 빌드한다. 각 후보마다 실행 순서를 바꾼 5쌍을 비교했고, 35쌍 모두 반환 payload가 일치했다. 외부 API 대역에는 고정 8ms 지연을 주었고, N1·N3은 실제 native 자식 프로세스 대역을, N7은 실제 CA 검증 로컬 TLS를 사용했다. fixture 준비 시간은 제외했다.

| 항목 | p50 이전→이후 ms | p95 이전→이후 ms |
| --- | --- | --- |
| N1 | 555.22 → 11.66 | 824.32 → 14.83 |
| N2 | 20.31 → 10.73 | 21.55 → 10.95 |
| N3 | 598.29 → 23.62 | 816.79 → 25.43 |
| N4 | 10.14 → 9.66 | 11.88 → 11.15 |
| N5 | 32.85 → 33.19 | 35.93 → 35.22 |
| N6 | 34.30 → 12.57 | 36.38 → 12.86 |
| N7 | 26.49 → 23.53 | 36.83 → 24.48 |

실제 GitHub latency와 성능 보장으로 해석하지 않는다. 특히 N1·N3은 이 환경의 fixture 프로세스 기동 비용을 포함한다. N5의 p50은 약간 늘었으므로 속도 개선으로 주장하지 않는다. 같은 요청 수에서 보완 PR 수가 2→1, 응답 JSON이 2294→1765 bytes로 줄어든 결과다. 작은 표본의 p95는 상위 관측치에 가깝다.

[원본 모든 표본](http-next-performance-20261101.json)에 요청·CLI·인증·응답 body·TLS 연결 수를 함께 저장했다. body bytes는 내부 REST envelope와 요청 document·HTTP 헤더·TLS overhead를 제외한다. native CLI 내부의 bytes·인증 lookup은 관찰하지 않아 null이며, CLI 대역 한 번은 API 읽기 한 번을 모델링한다.

성능 비교 소스는 `c40a75a`다. 이후 추가한 빈 커밋 제목의 OID 대체 표시 보완은 이 성능 fixture의 비어 있지 않은 제목에 영향을 주지 않으며, 별도 회귀 테스트에서 실패 재현 후 검증했다.

## 보존한 동작

모든 파일 페이지는 기존 body-only runner를 지원하며, 알려지지 않은 304 pagination 상태는 길이 기반으로 보완한다. 최대 3000개 파일이 꽉 차면 Link가 끝났더라도 PR의 `truncated` 표식과 선택 commit의 상한 오류를 보존한다. 100개·200개의 정상 최종 페이지와 API 상한을 구분한다.

PR 생성 전 중복 검사는 캐시한 과거 결과로 대체하지 않는다. 생성 후 조회는 github.com의 정확한 생성 URL identity를 사용한다. native Git commit/push, `gh pr create`, 단계별 실패 복구와 생성 후 조회 실패의 fallback은 유지한다. branch 필터는 [GitHub CLI의 현재 구현](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/shared/lister.go)과 같은 `headRefName` 조건을 사용한다.

커밋 snapshot은 최신 응답에서 확인한 인증·저장소·head/base/대상 branch가 일치해야 재사용한다. title 누락으로 OID를 대신 표시한 결과는 완료 요약으로 저장하지 않는다. 검색 공유는 한 논리 검색 안에서만 존재하고, 서로 다른 앵커의 연결을 합치지 않는다.

목록의 유효한 snapshot에 빈 제목이 저장돼 있어도 미리보기는 기존처럼 OID를 대신 표시한다. cache 경로가 기존 표시 정규화를 우회하지 않도록 빈 제목도 별도로 검증했다.

HTML Agent는 활성화와 네트워크 설정 세대 안에서만 공유한다. 인증 header는 원문을 보관하지 않고 활성화별 HMAC key로 분리한다. 최대 Agent 8개, 각 최대 socket 2개, 기본 idle 30초이며, 가득 찬 경우 다른 인증 소비자는 취소 가능한 대기를 한다. context 취소는 자기 요청만 닫고, 활성화 종료는 활성 요청과 Agent 대기 요청까지 실제 close를 기다린다. Host/proxy 관리 경로의 Agent 선택은 유지한다.

## 검사 상태

최종 커밋 `2e8f6a7`에서 `GSC_VERIFY_PR_RENDERER=1 npm test`를 실행했다. 전체 2723개 중 2722개 통과, 선택 검사 1개 건너뜀, 실패·취소 0개이며 종료 코드는 0이다. 실행 시간은 498.39초였다. 타입 검사와 production package 빌드도 종료 코드 0으로 통과했다.

실행 전후 src·test·scripts·package 입력의 SHA-256이 일치했다. [검증 집계](http-next-improvements-verification-20261101.json)에 파일 수, 입력 해시, 각 검사 결과와 성능·리뷰 범위를 기록했다. 실제 VS Code Host 화면이나 실제 GitHub 인터넷 응답 시간을 검사한 결과는 아니다.

최초 샌드박스 기준 실행은 파일 감시 및 resistant 자식 프로세스 종료 제약으로 실패했고, 멈춘 소유 테스트 그룹을 종료했다. 같은 프로세스 생애주기 테스트는 샌드박스 밖에서 10개 모두 통과했다. 이 환경 실패를 제품 수정으로 숨기지 않았다.

## 독립 코드 리뷰

`gpt-6-astra high`가 기준부터 N1–N7 전체 변경과 3000개 상한 보완을 읽기 전용으로 검토했다. 해결되지 않은 Critical·Important·Minor 지적과 판단 제외 항목은 모두 0개다. 리뷰어의 별도 Node 실행은 출력 전에 exit 137로 종료돼 독립 테스트 통과를 주장하지 않는다. 실행 검증 결과는 이 문서의 검사 상태에 따른다.

리뷰 뒤 발견한 빈 제목 보완은 실패 재현과 관련 27개 테스트 통과로 검증했으며, 최종 전체 검사에도 포함해 통과했다.
