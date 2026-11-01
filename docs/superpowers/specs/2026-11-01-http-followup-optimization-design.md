# 나머지 HTTP·HTTPS 개선 설계

상태: 사용자가 설계 승인 대기로 중단된 목표를 직접 재개하여, 공개한 권장안으로 구현을 진행한다.
사용자 요청은 추가 후보 모두의 개선이며, 아래의 세부 계약은 설계자의 선택으로 기록한다.
기준 소스는 `341e1b2`, 범위 근거는 [추가 후보 목록](../../benchmarks/http-call-opportunities-20261101.json)이다.

## 목적과 범위

에디터 리뷰 댓글, GitHub 웹 suggestion, 스택 PR 탐색, PR 대화·ref·선행 진단, 온보딩 catalog,
로컬 inspector 재연결, 대형 clone에서 중복·직렬 대기·전송량을 줄인다.
기존 DTO·댓글·커밋·diff·인증·원격 쓰기 안전 경계를 보존하며, 첫 표시와 최종 완성을 따로 검증한다.
후보 8개와 조건부 후보 2개 모두에 구현과 검증 결과를 남긴다.

| ID | 구현 결과 |
| --- | --- |
| H1 | 같은 논리 조회의 같은 URL·자격 증명 웹 요청을 한 번만 수행 |
| H2 | 독립 HTML fragment의 제한 병렬 처리, 연결·압축·취소 수명 관리 |
| H3 | Stack Advance의 branch별 PR 조회를 묶음 처리 |
| H4 | API 댓글을 먼저 표시하고 suggested changeset을 후속 보완 |
| M1 | 리뷰 댓글·Conversation의 typed REST 및 응답 헤더 기반 페이지 처리 |
| M2 | PR ref·선행 PR 조회의 typed GraphQL·고정 세션 연결 |
| M3 | Stack Submit의 대상 head 중심 PR 조회와 읽기 중복 축소 |
| L1 | catalog의 OAuth identity별 조건부 GET·동시 조회 공유 |
| D1 | 검증된 inspector 포트를 재연결 때 먼저 확인 |
| D2 | 전체 이력을 보존하는 선택형 blobless clone |

## 접근 방식

1. API·HTML·catalog를 하나의 새 전송 계층으로 교체할 수 있다. 자원 관리가 통일되지만
   `gh` 없는 OAuth 온보딩과 Cookie 웹 인증까지 바뀌어 회귀 범위가 크다.
2. 기존 전송 경계를 유지하고 세션·페이지 metadata·중복 제거를 확장할 수 있다.
   일부 정책이 각 경계에 남지만, 이전 HTTP 개선과 기존 proxy/CLI 동작을 재사용한다.

제안은 2번이다. 기존 TypeScript·Node 18·esbuild를 유지하고 새 runtime 의존성은 추가하지 않는다.
전용 브랜치에서 세션 내 구현과 최종 독립 리뷰를 수행하는 기존 작업 방식을 이어가는 것을 제안한다.
새 릴리스·merge·원격 push는 이번 구현 완료 조건에 포함하지 않는다.

## 공통 계약

- Node 18 빌드 대상, VS Code 최소 기여 버전, 모듈 역할과 한글 함수 주석을 유지한다. 코드 파일은 600줄 미만으로 나눈다.
- `GhExecute`의 문자열 반환과 기존 body-only 요청을 보존한다. 새 REST metadata는 명시적 opt-in이다.
- API의 기본 background/interactive 4-slot 큐와 실제 request close 뒤 슬롯 반환을 유지한다.
- 현재 VS Code 기본 `http.proxySupport=override`에서 API는 CLI를 선택한다. 지원 정책에서만 직접 API HTTP를 쓴다.
- OAuth·gh token·Cookie·계정·저장소 문맥을 섞지 않는다. 401/권한/rate-limit 실패 뒤 다른 인증으로 API를 재시도하지 않는다.
- 인증·쿠키·헤더·본문·credential fingerprint를 OUTPUT·오류·성능 artifact에 기록하지 않는다.
- 새로고침·인증/설정 변경·dispose 뒤 이전 결과가 게시되거나 완료 캐시에 들어가지 않아야 한다.
- 새 기능의 요청 수·첫 표시·전체 시간·bytes·취소·fallback 사유를 비민감 집계로 관찰할 수 있어야 한다.

## 1. GitHub 웹 HTML: H1·H2

`githubWebHtml.ts`의 파싱/URL 제한과 새로운 HTML 읽기 자원 모듈을 분리한다.
한 suggested changeset 조회가 하나의 context를 소유한다. context는 시작 때의 인증 값과 취소 신호를 고정한다.

- 동일 context의 URL(hash 제거)·인증 identity·Accept가 같은 요청은 성공/실패 모두 한 Promise를 공유한다.
  기본 files 페이지와 comment permalink 후보에 같은 URL이 있어도 다시 전송하지 않는다.
- 인증 값이 다른 요청은 공유하지 않는다. 실제로 같은 token인 두 경로의 동일 요청은 공유할 수 있다.
  key는 context 내부에만 존재하며 로그에 노출하지 않는다. 완료 결과를 다음 조회의 인증 판단에 재사용하지 않는다.
- fragment는 기존 최대 120개·깊이 2·same-origin/같은 PR 제한을 유지한다. 동시 body 읽기는 2개로 제한한다.
  결과를 완료 순서가 아닌 기존 breadth-first 순서로 합쳐 파싱 결과의 우선순위를 보존한다.
- 중복 URL이 자식에서 다시 나와도 예약 때 한 번만 등록한다. 취소 뒤 새 fragment를 시작하지 않는다.
- gzip/deflate/br을 해제하고 wire/decoded 각각 기존 64MiB 상한을 적용한다. per-request idle 10초에
  context 전체 30초 deadline을 더한다. context deadline 초과는 웹 보조 조회 실패이며 API 댓글은 남긴다.
- 검증된 Agent 보존 정책에서만 context 소유 keep-alive Agent를 사용한다. maxSockets 2, maxFreeSockets 2다.
  VS Code proxy가 Agent를 소유하는 환경에서는 기존 Host 관리 HTTPS 경로를 유지한다.
  Cookie HTML을 API Bearer transport에 넘기거나 proxy/사용자 CA를 우회하지 않는다.
- Cookie/Authorization은 각 요청에 붙인다. Agent에 보관하지 않는다. redirect는 기존 origin 제한을 유지한다.
- request·response·decoder가 닫힌 뒤에만 context를 종료하고 Agent를 해제한다.

웹의 기존 인증 시도 순서는 유지한다. 의미 있는 성공 경로 순서 변경이나 장기 실패 캐시는 도입하지 않는다.

## 2. 에디터 댓글의 점진 표시: H4

Git 서비스는 API 댓글 준비 시점을 알리는 선택 callback을 제공하고 최종 결과 Promise도 유지한다.
provider cache는 진행 중 load의 최신 API snapshot과 progress 구독자를 관리한다.

- API 결과를 받은 즉시 `api-ready` snapshot을 게시한다. HTML suggestion을 기다리지 않는다.
- 최종 보완은 같은 comment ID의 suggestion만 갱신한다. 댓글 위치·답글·본문은 기존 정규화를 사용한다.
- HTML 실패/시간 초과가 이미 표시한 댓글을 지우지 않는다. 실제 최종 실패 이유는 기존 OUTPUT 진단에 남긴다.
- API-ready는 완성된 2분 TTL 캐시로 승격하지 않는다. 최종 완료 때만 기존 bounded cache에 저장한다.
- 같은 branch load에 뒤늦게 합류한 구독자는 현재 progress를 받는다. 한 구독자의 예외/취소가 다른 구독자를 막지 않는다.
- 파일/창 전환은 원격 조회를 반복 재시작하지 않는 현재 정책을 유지한다. 공유 load는 완성·캐시될 수 있다.
  표시 callback은 request ID·활성 URI·저장소·branch 세대·포커스·설정을 매번 검사한다.
- 무효화·dispose는 실제 원격 load를 취소하고 모든 callback을 해제한다. 기존 thread ID와 펼침 상태를 유지한다.

UI는 기존 VS Code comment thread·아이콘·hover를 재사용한다. 별도 버튼·새 웹뷰·새 디자인 시스템은 만들지 않는다.
초기/빈/오류/후속 성공, 파일·branch 전환, 창 포커스, 긴 댓글과 한국어 상태를 검증한다.

## 3. typed REST 페이지 계약: M1

새 페이지 reader만 `GitHubRestRequest`의 opt-in response mode를 사용한다.
정규화한 page envelope는 JSON 문자열이며 `body`와 allowlist metadata만 담는다.
허용 metadata는 effective status와 `Link`, `ETag`, `Last-Modified`, rate-limit/retry 시간 필드다.
Cookie·Authorization·Set-Cookie와 원문 HTTP 오류는 envelope에 넣지 않는다.

- body-only 요청은 기존 값 그대로 반환한다. GraphQL과 native Git은 envelope를 사용하지 않는다.
- 직접 HTTP는 기존 body/ETag 캐시에 페이지 metadata를 함께 저장한다. 304에서는 완전한 기존 body와 Link를 복원한다.
  body 없는 304는 기존처럼 unconditional GET을 한 번만 허용한다.
- 304가 새 Link를 반환하면 갱신한다. Link를 생략한 304는 과거의 종료 판정을 최신으로 확정하지 않는다.
  알려진 next는 따라가되, next가 없고 body가 꽉 찬 경우에는 길이 fallback으로 새 tail 누락을 방지한다.
- production CLI adapter는 opt-in REST 요청에만 `gh api --include`를 사용하고 최종 응답 헤더를 envelope로 정규화한다.
  기존 service/fake runner의 plain JSON body도 reader가 받아 기존 page-length 종료 판정으로 fallback한다.
- Link가 있으면 `rel=next`를 사용한다. 다음 URL은 같은 API origin·같은 endpoint/query·증가하는 page여야 한다.
  임의 외부 URL을 따르거나 인증 헤더를 전달하지 않는다. 반복 URL·역행 page·잘못된 metadata는 실패한다.
- Link가 없는 경우에는 page 길이 판정을 유지한다. header 없는 test seam을 임의로 완료로 간주하지 않는다.
- 리뷰 댓글과 Conversation은 현재 100개 page size·최대 10페이지, Accept full media type과 tail·fallback을 보존한다.
  상한 도달로 다음 페이지가 남으면 완성된 성공으로 게시하지 않고 명시적인 제한 오류로 보고한다.
- 0/99/100/101/200/1000/1001개, timeline 실패, 삭제/수정 댓글, partial/error/cancel과 200/304의 최종 DTO를 검증한다.

Conversation의 세 독립 stream은 이미 병렬이며 그대로 유지한다. 추가 무제한 API 병렬화는 하지 않는다.
에디터 댓글의 현재 `gh pr view` bootstrap도 같은 branch 선택 의미의 typed 조회로 연결한다.
그렇지 않으면 첫 unconverted 명령이 후속 REST까지 CLI로 고정하므로 descriptor 추가만으로 완료했다고 간주하지 않는다.
canonical metadata를 같은 bootstrap에서 검증하고, 실제 production 조립에서 알려진 저장소의 HTTP 요청과 credential lease를 확인한다.

## 4. typed GraphQL과 branch PR 묶음: M2·H3

PR ref와 두 prerequisite 조회에 typed query·같은 read session·완료 문맥 검증을 연결한다.
검증용 repository metadata를 같은 응답에 포함할 수 있지만 DTO·head/base 최신성·기존 30초 TTL과 batch 상한은 보존한다.

스택용 branch lookup은 git 모듈의 공통 read-only 서비스로 분리한다.
한 묶음은 최대 20개 head, 동시에 실행되는 묶음은 기존 큐 한도를 따른다.
로컬 upstream/remote branch 해석을 먼저 끝내고 실제 selector를 변수로 전달한다.

- 명시적 branch의 `gh pr view` 선택 의미를 보존한다. 기준은 GitHub CLI 2.95.0의 finder다.
  branch별 최근 생성 PR 최대 30개를 읽고 OPEN을 안정적으로 우선하며 head label·owner·base 조건을 맞춘다.
  default branch의 CLOSED/MERGED 제외 규칙도 보존한다. 동명 fork·재사용 branch를 최신 updatedAt 하나로 대체하지 않는다.
- canonical repository/default branch는 묶음에서 한 번만 읽는다. head별 응답과 오류를 정확히 대응한다.
- 일반 branch 조회 실패는 기존처럼 다른 Advance 후보를 잃게 하지 않는다. 취소·auth·권한·rate-limit·문맥 변경은
  일괄 중단하고 상위에 안전한 오류를 전달한다. 이를 단순한 빈 후보나 다른 계정 재시도로 숨기지 않는다.
- 부분 GraphQL 응답은 검증된 alias만 사용할 수 있다. 모호한 응답은 affected 묶음을 같은 credential의
  개별 typed query로 분해해 오류를 격리한다. HTTP 오류 뒤 `gh pr view`로 인증 fallback하지 않는다.
- 1/8/21/40 head, OPEN/CLOSED/MERGED, 기본 branch, owner-qualified head, 빈 결과, 일부 오류를 검증한다.

## 5. Stack Submit: M3

읽기 최적화는 native push/create/base edit의 검증·순서를 바꾸지 않는다.

- submit 전 전체 열린 PR 1000개와 사용하지 않는 repository 표시 정보를 읽는 대신 대상 head만 묶어 읽는다.
  기존 open PR 식별·fork owner·base 의미가 불명확하면 값을 추측하지 않는다.
- layer push와 create/base 변경은 현재 부모→자식 순서를 유지한다. 실제 remote OID·고정 source·lease·hook을 생략하지 않는다.
- 모든 layer의 원격 작업 뒤 번호/URL/현재 body를 대상 head 묶음으로 최신 조회하고 footer를 구성한다.
  마지막 쓰기에 필요한 최신 state/body를 과거 UI cache로 대체하지 않는다. 중간 실패의 부분 결과와 복구 정보는 유지한다.
- 외부 실제 PR 생성/수정/push는 검증용으로 수행하지 않는다. fake GitHub와 임시 Git remote로 호출 순서·payload·실패 복구를 검증한다.

## 6. OAuth catalog: L1

`GitHubRepositoryCatalog`는 기존 fetch와 VS Code가 준 OAuth token을 사용하며 `gh`/Git에 의존하지 않는다.

- token의 process-local HMAC identity·URL·Accept·API version별 bounded body/ETag cache를 둔다.
  최대 32페이지·전체 4MiB·페이지당 1MiB, idle 보관 상한 2분이다.
- 재열기는 권한 확인 없이 과거 목록을 먼저 표시하지 않는다. conditional GET을 보내 304일 때만 기존 body/Link를 사용한다.
  200은 현재 body로 바꾼다. ETag 없는 응답은 동시 조회만 공유하고 장기 재사용하지 않는다.
- 같은 identity/page의 동시 조회는 한 fetch를 공유한다. 소비자별 취소를 격리하고 마지막 소비자가 떠나면 fetch를 취소한다.
- 401/403은 해당 인증의 후보를 제거한다. 429·primary/secondary limit은 Retry-After/reset까지 재전송을 막는다.
  body 없는 304는 한 번의 unconditional GET 뒤에도 반복되면 오류다.
- dispose 시 요청·타이머·cache를 해제한다. UI가 생성한 catalog만 UI가 dispose한다.
- 기존 사용자 선택형 pagination·정렬·권한/취소 오류를 보존한다. 이미 fetch가 가진 연결 재사용을 없다고 가정하지 않는다.

## 7. Inspector 재연결: D1

검증된 성공 포트 힌트는 extension lifetime에서 PID·profile·configured port set별 최대 16개만 보관한다.

- 재연결 때 힌트 포트를 먼저 읽고 WebSocket에서 실제 `process.pid`를 다시 확인한다.
- 틀린 PID/닫힌 포트/다른 profile/취소면 힌트를 버리고 기존 preferred-port + 나머지 탐색으로 돌아간다.
- 기본 포트와 힌트가 같으면 같은 round에서 중복 probe하지 않는다. 포트 목록에 없는 힌트는 사용하지 않는다.
- 기존 열린 socket·connectPromise 공유·15초 cooldown은 유지한다. PID·프로필 소유 검증을 생략하지 않는다.
- 연결 폐기 때 해당 수명의 힌트와 진행 중 probe를 해제한다. 힌트는 영구 설정에 쓰지 않는다.

## 8. 선택형 전체 이력 clone: D2

새 고급 설정 `gitSimpleCompare.cloneMode`를 `full | blobless`, 기본 `full`, machine-overridable로 제안한다.
명령 자동화 인자와 `RepositoryCloneOptions`에도 같은 선택값을 제공한다. 시작 시 선택을 고정한다.

- `full`의 기존 인자·Git 실행 수와 동작은 보존한다.
- `blobless`는 검증된 HTTP/HTTPS clone에서 `--filter=blob:none`만 추가한다. `--depth`, single-branch, no-tags,
  sparse checkout으로 이력·branch·파일을 줄이지 않는다. 현재 checkout 파일과 전체 commit/ref 이력을 유지한다.
- 보수적으로 Git 2.46 이상에서 적용하고 그 미만/불확실하면 API 요청 전에 full로 선택한다.
  로컬 경로·SSH clone은 full을 유지한다. server가 filter를 지원하지 않으면 Git의 일반 clone 동작을 따른다.
  실패한 clone을 지우거나 같은 destination에 자동 재시도하지 않는다.
- **독립 builder 검토 후의 권장 인증 계약:** 선택형 blobless는 clone 전에 app OAuth header를 넣지 않은
  native Git의 비대화식 `ls-remote`로 원격 읽기 접근을 확인한다. 상한은 5초이며 별도 로그인/askpass 창을 열지 않는다.
  이 확인이 성공한 경우에만 적용하고, 비공개 OAuth-only·실패·불확실한 경우에는 기존 OAuth를 사용하는 full clone을 한다.
  public remote는 익명 읽기로 통과할 수 있다. native helper/extraheader 설정은 영구 변경하지 않는다.
  이 제안은 OAuth token을 이후 로컬 Git 작업·hook에 새로 공급하지 않는 대신 OAuth-only private 저장소에는
  blobless를 적용하지 않는 tradeoff다. 모든 private 저장소에서 blobless가 동작한다고 주장하지 않는다.
- 원래 GitHub OAuth helper/extraheader 경계, 부모 디렉터리 검증, 취소와 빈 소유 폴더 정리 정책은 유지한다.
- 설정에는 오래된 파일 내용은 나중에 네트워크에서 받을 수 있고, 인증·서버 지원에 따라 full로 동작할 수 있음을 영어·한국어로 설명한다.
  원시 Git 옵션을 일반 온보딩 흐름의 새 질문으로 노출하지 않는다.
- full/blobless의 refs·전체 parent history·현재 파일을 비교하고, 과거 파일 내용의 on-demand hydration도 검증한다.
  blobless에서 과거 파일의 오프라인 사용이 full과 같다고 주장하지 않는다.

builder가 남긴 질문은 이 private OAuth hydration 계약 하나다. 위 native 접근 확인/fallback은 설계자의 권장안이며,
사용자가 OAuth를 이후 Git hydration에도 연결하기를 선택하면 해당 인증 설계를 수정한 뒤 구현한다.

## 검증과 완료 조건

각 구현은 의미 있는 실패 재현→통과 검사를 갖는다. 공유 모듈 변경 뒤 타입·관련 회귀를 확인하고 최종 전체 검사를 실행한다.

1. H1/H2: 실제 코드로 동일 credential의 files 중복 감소, fragment 동시 상한 2·순서·전체 suggestions 동등성,
   압축·response close·timeout·취소·redirect·proxy 정책을 검증한다.
2. H4: HTML을 지연/실패시켜 API 댓글이 먼저 표시되는 실제 Host 흐름을 확인한다. 파일·branch·포커스 전환에서
   stale callback이 반영되지 않고 thread 펼침 상태가 유지되는지 별도로 확인한다.
3. M1/M2: CLI와 지원 HTTP 양쪽에서 body-only/metadata opt-in, Accept, 페이지 끝, 304, 부분 오류·auth 문맥을 확인한다.
4. H3/M3: branch 선택 oracle·묶음 수와 DTO, remote 쓰기 순서·fresh lease·hook·실패 복구를 확인한다.
5. L1: 현재 OAuth 권한의 200/304/401/403/429, account 변경, cache 상한과 취소·dispose를 검증한다.
6. D1: 비기본 포트 재연결 probe 감소와 잘못된 PID/profile 회피를 검증한다.
7. D2: 소유한 smart HTTP fixture에서 전송 bytes와 전체 clone/checkout/hydration 비용을 비교한다.
8. 모든 후보에 최소 3회 순서 교대 비교 또는 결정적 요청 수/동등성 근거를 남긴다. 모의·로컬·공개 실측을 구분하고,
   기준 코드와 새 코드의 payload/파일/ref/config가 같은 범위에서만 개선율을 보고한다.
9. 최종 `GSC_VERIFY_PR_RENDERER=1 npm test`, 타입, production package, Node 18 관련 검사와 실제 Extension Host를 수행한다.
   Settings와 댓글 화면은 영어·한국어, 기존 검증 viewport 1440×900·900×700에서 기능/시각 QA를 따로 수행한다.
   lint 등 사용할 수 없는 도구는 정확히 기록한다. 독립 최종 리뷰 뒤 Important 수정과 전체 재검증을 수행한다.

설정/댓글의 visual language는 현재 VS Code UI를 그대로 사용한다. 새 버튼을 추가하게 되면 tooltip·접근성 라벨을 제공한다.
개선이 약하거나 조건부인 경로도 구현 범위에서 빼지 않으며, 조건·회귀·전체 비용을 최종 보고서에 공개한다.

## 근거

- [현재 후보와 모의 호출 근거](../../benchmarks/http-call-opportunities-20261101.json)
- [기존 HTTP 구현과 실측](../../benchmarks/github-http-performance-20261101.md)
- [GitHub REST 조건부 요청·pagination·rate limit](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [GitHub CLI 2.95 branch PR finder](https://github.com/cli/cli/blob/v2.95.0/pkg/cmd/pr/shared/finder.go)
- [Git clone filter 의미](https://git-scm.com/docs/git-clone#Documentation/git-clone.txt---filterltfilter-specgt)
