# GitHub 직접 HTTP 전송과 조회 지연 개선 설계

상태: 사용자 승인 후 구현·검증·성능 판정을 완료했다. [최종 결과](../../benchmarks/github-http-performance-20261101.md).

## 요청과 범위

사용자는 PR 목록·검색, PR 상세·파일, push·pull·fetch 세 구간의 지연을 모두 개선하고,
기존 CLI 최적화에 더해 **직접 HTTP 통신까지 설계 검토**하기로 선택했다.
구현 기반은 `9e75326` / `0.1.72184`의 TypeScript·Node 18 빌드 대상과 기존 모듈 경계다.

이번 문서는 승인받은 구현 범위·계약·검증 조건을 기록한다. 구현은 전용 브랜치에 보존하며 새 릴리스는 수행하지 않았다.
전송 구현, 기본 설정, 캐시 상한과 단계 구분은 아래에 명시한 설계 선택이며 사용자가 직접 정한 세부사항으로 간주하지 않는다.

최종 일곱 쌍에서 기본 CLI의 반복 목록 46.1%, 상세 재열기 89.2%, 검색 30.9% 개선을 확인했다.
직접 HTTP의 추가 완료 시간 개선은 같은 코드 대비 목록 4.0%, 상세 19.1%, 검색 16.5%였다.
실제 VS Code 1.144.0의 기본 `http.proxySupport=override`는 Agent를 교체하므로 최초 요청 전에 CLI를 선택한다.
native 사전 인증은 push dry-run에만 이득이 확인됐고 fetch/pull은 느려져 기본 `false`를 유지한다.

## 실측 근거

[조사 데이터](../../benchmarks/github-latency-investigation-20261101.json)의 공개 저장소 읽기 측정과
임시 저장소의 Git 전송 측정을 기준으로 한다. 인증 헤더·토큰·비공개 저장소 원문은 기록하지 않았다.

| 경로 | 관찰한 결과 | 의미 |
| --- | --- | --- |
| PR 80개 cold 목록 | 첫 표시 약 1.43초, 전체 약 5.29초 | 첫 표시와 전체 완성을 따로 측정해야 한다. |
| 같은 목록 새로고침 | HTTP 1회지만 첫 표시 약 4.50초 | 무거운 단일 쿼리가 첫 표시를 늦춘다. |
| 같은 PR 738개 파일 재열기 | 같은 head/base인데 HTTP 9회, 약 6.30초 | 불변 파일을 다시 받는 비용이 크다. |
| metadata 묶음 5·10·20·40·80개 | 비교한 범위에서는 기존 20개가 가장 빠름 | 요청 수 감소가 항상 지연 감소를 뜻하지 않는다. |
| 댓글 단일 합계 필드 대체 | 80건 중 64건이 현재 집계와 불일치 | 기존 댓글 의미를 유지하며 이 대체는 채택하지 않는다. |
| HTTPS thin 조회 4회 순차 중앙값 | CLI 2.254초, 직접 연결 재사용 1.670초 | API 구간만의 측정이며 인증 획득 비용은 별도다. |
| HTTPS metadata 4회 병렬 중앙값 | CLI 3.603초, 직접 연결 재사용 3.061초 | 큰 쿼리에서는 HTTP 응답 대기가 여전히 크다. |
| 저장된 gh 인증 정보 획득 | 한 번 약 400ms | 이를 포함하면 위 이득의 상당 부분이 상쇄될 수 있다. |
| Git push dry-run 인증 구간 | 401·200 두 GET에서 200 한 GET으로 감소, 중앙값 675→448ms | 실제 객체 업로드 시간이나 전체 push 속도 개선을 증명한 수치는 아니다. |
| 변경 없는 Git fetch / pull | 각 전송 명령 1회, 중앙값 약 0.53 / 0.62초 | 이미 기본 연결 수가 적다. 보존해야 할 검증을 생략해 수치를 줄이지 않는다. |

묶음·전송 방식은 각각 세 번의 순서 교대 표본이다. 한 공개 저장소와 standalone Node 22의
결과이며, Node 18 Extension Host·프록시·실제 업로드·다른 저장소의 보편적인 속도를 보장하지 않는다.
기존 native 동기화·안전 경계 검사 13개는 이번 조사에서도 통과했다.

## 접근 방식

1. **CLI 유지 + 조회 재사용:** 기존 인증·네트워크 호환성을 그대로 쓰며 파일 재조회와 무거운 쿼리만 줄인다.
   변경 규모가 작지만 API 호출마다 CLI와 연결을 다시 준비하는 비용이 남는다. 최초 권장안이었다.
2. **직접 HTTPS + 호환 CLI:** 기존 인증 출처를 유지하고 HTTP 연결을 재사용한다.
   인증 수명·프록시·오류·취소를 직접 관리해야 한다. 사용자가 검토 대상으로 선택한 방식이다.

두 번째 방식을 사용하되 조회 재사용도 함께 적용한다. PR API는 직접 HTTPS 또는 호환 CLI가 담당하고,
Git 객체 전송·merge·hooks·lease는 계속 native Git이 담당한다.

## 목표와 유지할 계약

- 기존 PR DTO의 값·정렬·검색 결과 수·원래 commit 의미·전체 pagination을 유지한다.
- 첫 표시, 전체 완성, 재열기와 네트워크 전송 시간을 각각 측정한다.
- 응답은 조회 시작에 고정한 인증·호스트·저장소 문맥에만 속한다. 관찰 가능한 설정·계정 세대가 바뀌면
  이전 응답이 새 문맥으로 게시되거나 캐시되지 않는다. 아래에 명시한 비관찰 keychain 교체의 경계도 유지한다.
- 부분 데이터·반복 cursor·HTTP 오류를 성공한 빈 결과로 반환하지 않는다.
- 같은 head/base라도 댓글·라벨·review 상태는 새로 읽는다.
- 로컬 작업 파일·index·HEAD·사용자 Git/SSH 설정과 push hook·lease 검증을 보존한다.
- read 요청 취소는 소비자별이고, 실제 자원을 회수하기 전에 실행 슬롯을 반환하지 않는다.

## 1. 서비스와 전송 경계

`git/`에 typed read request, 세션 인증, HTTPS 실행, 호환 CLI, bounded snapshot 저장을 나눈다.
서비스는 조회와 DTO 해석을 담당하고 전송 구현을 알지 않는다. VS Code 네트워크 설정 읽기는
composition 계층에서 값으로 주입하며 HTTP 모듈에 UI 업무를 섞지 않는다. 파일당 600줄을 넘기지 않는다.

- typed request는 `REST GET`과 `GraphQL query`만 표현한다. 사용자 입력은 변수·인코딩된 경로 값으로 전달한다.
- 기존 `GhExecute` 인자 계약을 호환 경계로 유지한다. 공통 builder가 typed descriptor와 CLI 인자를 함께 만든다.
  기존 대역·호출자는 같은 CLI 인자를 관찰할 수 있고, 기본 실행기만 descriptor를 이용해 전송을 선택한다.
- 일반적인 `gh` 명령행 파서는 만들지 않는다. 미전환 명령·파일 입력·임의 템플릿·`gh pr ...`는 기존 실행기를 사용한다.
- GraphQL AST로 선택 operation이 query임을 확인한다. mutation·subscription·모호한 복수 operation은
  typed read 경로에서 거부한다. 파서의 구체 패키지·버전은 Node 18 호환성과 번들 크기를 확인해 구현자가 정한다.
- GitHub 쓰기 요청은 기존 명시적 쓰기 경로를 유지한다. read 쪽의 자동 재시도·캐시에 편입하지 않는다.

## 2. 저장소 식별과 전송 선택

직접 전송은 **검증된 canonical repository scope**를 사용한다. remote 문자열만 보고 gh의 기본 원격·
fork·`GH_REPO`·`gh-resolved` 규칙을 다시 추측하지 않는다.

- 첫 scope가 없으면 해당 논리 조회 전체를 CLI로 처리한다. 원래 첫 조회의 repository selection에
  `url`을 함께 받아 별도 `repo view` 왕복을 추가하지 않고 canonical host/name을 관찰한다.
- 기존 `readGitHubRepositoryName`의 cold 조회도 `nameWithOwner,url`을 함께 받아 같은 scope에 기여한다.
- 원래 요청의 성공·문맥 검증 후에만 scope를 기록한다. 취소·실패·부분 오류는 scope를 가르치지 않는다.
- 조회 하나의 전송 방식은 시작 때 고정한다. 중간 페이지에서 계정·호스트·전송을 교체하지 않는다.
- 첫 cold 조회는 기존 속도를 유지하고, 검증된 scope의 다음 조회부터 직접 HTTP를 사용할 수 있다.

초기 직접 전송 대상은 `https://api.github.com`의 GitHub.com API다. Enterprise·`*.ghe.com`·custom host·
Unix socket·표현하지 못하는 프록시/인증서 정책은 CLI로 처리한다. 이는 설계자의 초기 범위 제안이다.
Enterprise 기능을 제거하거나 인증을 GitHub.com 토큰으로 대체하지 않는다.

## 3. 인증 수명과 비밀값

- 현재 gh 인증 출처를 유지한다. 새 VS Code GitHub 계정으로 조용히 전환하지 않는다.
- 환경 토큰 우선순위는 gh 문서와 같게 적용한다. 저장된 계정은 고정한 환경의
  `gh auth token --hostname <verified-host>`로 읽는다. 직접 keychain/hosts 파일의 비밀 내용을 해석하지 않는다.
- 자격 증명은 **논리 조회 한 번에 한 번** 해석해 그 조회의 모든 HTTP 페이지에서 고정한다.
  동시 진행 조회의 같은 lookup은 소비자 취소를 분리해 공유할 수 있으나, 완료된 토큰을 장기 TTL로 공유하지 않는다.
- 토큰은 Extension Host 메모리의 credential lease에만 둔다. 웹뷰 메시지·설정·로그·파일·오류 stdout/cause에 넣지 않는다.
  credential CLI의 출력/오류는 전용 adapter가 소유하며, 기존 일반 오류 로거로 원문을 전달하지 않는다.
- 실제 토큰의 activation-local HMAC을 응답 캐시·snapshot·연결 pool 문맥에 포함한다. 원문과 HMAC을 진단 로그에 남기지 않는다.
- 새 조회는 자격 증명을 새로 해석하므로 파일 metadata에 드러나지 않은 keychain 교체도 구분한다.
- 조회 중 파일 metadata나 공급자 이벤트에 드러나지 않는 외부 keychain 교체는 진행 중인 lease를 바꾸지 않는다.
  현재 조회는 시작 때 승인된 자격 증명으로 끝나며 다음 논리 조회부터 새 토큰으로 구분한다.
  이런 비관찰 교체를 즉시 감지한다고 주장하지 않는다. 관찰 가능한 hosts/config 변경은 기존 전후 검사로 게시를 차단한다.
- 인증 401이면 현재 조회를 실패시키고 lease와 관련 cache를 무효화한다. pagination 중 새 계정으로 재시도하지 않는다.
- 이미 고정한 환경의 **없는 변수도 없는 상태로** 유지하며, 기존 Git include/원격/인증 문맥의 실행 전후 검사를 유지한다.
- 기본 30초는 기존과 같이 **개별 API 요청당** 예산이다. 목록·상세 전체 pagination의 총 시간 상한이 아니다.
  첫 요청의 예산에는 세션 준비·인증 획득·큐 대기·네트워크를 포함하며, 후속 요청은 각각 새 예산을 받는다.
  credential lookup 자체도 최대 30초이며 호출자의 더 짧은 남은 예산과 취소를 따른다.

장기 토큰 캐시를 두지 않는 선택은 약 400ms로 관찰된 획득 비용을 남길 수 있다. 성능 판정에 이 비용을 포함한다.

## 4. HTTPS 연결과 네트워크 호환성

- Node의 `https.request`와 명시적인 keep-alive Agent로 시작한다. HTTP/2 전용 구현은 초기 범위에 넣지 않는다.
- pool key는 API origin·네트워크 정책 세대·credential 세대다. 헤더는 요청마다 만들며 Agent에 Authorization 기본값을 저장하지 않는다.
- 기존 background 4개·interactive 4개 제한을 유지한다. pool 때문에 총 동시 요청 수를 더 늘리지 않는다.
- pool은 최대 4개 문맥, 문맥당 active/free socket 상한을 두고 idle 60초 또는 관련 문맥 해제 때 정리한다.
  같은 origin에 여러 문맥이 생겨도 기존 전역 read 실행 상한을 넘어서는 별도 우회 경로를 만들지 않는다.
- 성공은 body 소비와 요청 자원 반환까지, 취소는 소유 요청/stream의 close까지 기다린 뒤 settle한다.
  정상 keep-alive socket이 물리적으로 닫힐 때까지 기다리는 방식은 사용하지 않는다.
- 한 요청의 취소가 다른 소비자의 요청이나 pool 전체를 끊지 않는다. 계정 전환은 이전 idle 연결을 닫고 active 응답 게시를 차단한다.
- 압축 응답과 해제 후 응답 모두 기존 `maxBufferBytes` 상한을 지킨다. 잘린 body를 JSON/빈 성공으로 반환하지 않는다.
- TLS 검증을 유지한다. 인증서 검증을 끄거나 사용자 proxy/CA/Unix socket 설정을 무시하고 직접 연결하지 않는다.
- VS Code proxy 설정, 대소문자 proxy 환경, `ALL_PROXY`, `NO_PROXY`, 인증서 관련 환경을 capability 판정에 포함한다.
  지원을 증명하지 못한 정책이면 첫 네트워크 요청 전에 CLI로 결정한다. direct 경로가 host 시스템 proxy를
  자동 상속한다고 가정하지 않으며 Extension Host에서 별도로 검증한다.
- REST GET의 redirect는 동일 HTTPS origin 안에서만 최대 3번 허용한다. 다른 origin에 자격 증명을 전달하지 않는다.
  GraphQL redirect는 초기 구현에서 오류로 처리한다.
- 이미 재사용한 socket의 응답 시작 전 `ECONNRESET`만 같은 자격 증명과 남은 예산으로 한 번 재시도한다.
  권한·인증·rate-limit·TLS 오류를 다른 계정/CLI로 재실행해 숨기지 않는다.

## 5. 오류·conditional read·관찰

- HTTP 상태와 GraphQL `errors`를 별도로 판정한다. 200 partial GraphQL도 기존 서비스의 완전성 검증을 통과해야 한다.
- HTTP 오류는 안전한 kind/status/operation/retry 시각을 가진 타입으로 정규화한다.
  예상한 PR alias의 `null + NOT_FOUND`만 허용하는 검색 규칙은 CLI/HTTP에서 동일하다.
  이때 필요한 구조화된 GraphQL 결과를 일반 stdout/오류 cause에 노출하지 않는 내부 accessor로 제공한다.
- 403/429의 Retry-After와 quota 정보를 존중한다. primary cooldown은 host/credential별,
  secondary cooldown은 host별로 다음 읽기를 제한한다. 긴 자동 재시도는 하지 않고 기존 결과와 재시도 가능한 오류를 유지한다.
- ETag 재검증은 지원되는 REST GET에만 적용한다. GraphQL POST에 304 계약을 가정하지 않는다.
- 304는 같은 요청·인증·Accept·호스트의 완전한 200 body가 있을 때만 재사용한다.
  body가 없으면 같은 예산 안에서 한 번 unconditional GET으로 복구한다.
- OUTPUT에는 transport, 안전한 operation, credential/queue/connect/TLS/response/body/전체 시간,
  연결 재사용 여부, 실제 HTTP/CLI 횟수·byte 수를 남긴다. 응답 대기를 순수 서버 CPU 시간으로 표시하지 않는다.
- 계정 전환·취소·재시도·호환 CLI 선택·cache hit/miss·상한 초과를 관찰할 수 있게 한다.

## 6. PR 데이터 대기 감소

### 상세와 파일

완료한 raw 변경 파일만 bounded immutable snapshot으로 보관한다. 초기 상한은 128개/16MiB,
단일 4MiB이며 truncated/실패/취소 결과는 저장하지 않는다. 댓글을 합친 최종 DTO는 저장하지 않는다.

- key: canonical repository, PR 번호, head/base OID, 실제 인증 문맥, API/정규화 버전.
- 재열기 첫 요청에서 현재 head/base·파일 합계와 최신 review thread 첫 페이지를 함께 읽는다.
- 앵커와 합계가 같은 완전한 snapshot이면 파일을 다시 받지 않고 최신 댓글로 DTO를 다시 만든다.
- 다르면 snapshot을 사용하지 않고 현재 파일을 읽는다. 같은 조회의 모든 페이지 앵커를 계속 검증한다.
- review thread 후속 페이지는 계속 읽는다. 댓글 오류가 이미 검증한 파일을 숨기지 않는 계약도 유지한다.
- 새 댓글이 생기거나 삭제되어도 같은 파일 snapshot에 이전 댓글 수가 남지 않아야 한다.
- 캐시만으로 새 계정의 파일 조회를 완료하지 않는다. 현재 인증의 성공한 앵커 요청 뒤에만 재사용한다.

738개 파일·thread 꼬리 없음 fixture의 재열기 목표는 파일 페이지 8개 재수신 없이 **API 1회**다.
이는 구현 후 검증할 구조적 목표이며, 현재 달성한 속도 수치가 아니다.

### 목록과 검색

- warm 목록의 첫 쿼리는 summary와 head/base 등 얕은 identity만 읽는다. 80개 mutable connection을 한꺼번에 펼치지 않는다.
- 첫 identity를 게시한 뒤 검증한 commit/file-count snapshot은 재사용하고 mutable metadata는 20개씩, 최대 4개 요청으로 보완한다.
- 댓글·라벨·review 상태는 head/base가 같아도 최신 조회로 갱신한다.
- 첫 identity 뒤 head/base가 바뀐 PR은 그 PR의 전체 연결을 한 번 보완한다. 다시 바뀌면 명확한 오류로 중단해 무한 재요청하지 않는다.
- 검색도 같은 저장소 scope·직접 HTTP·검증된 immutable commit snapshot을 공유한다.
  정확 번호·텍스트·commit/branch 검색의 병합 순서, 결과 제한, cursor, 전체 tail 조회를 유지한다.
- 기존 commit summary가 불완전하면 재사용하지 않는다. 로드되지 않은 제목을 SHA로 완료 표시하는 이전 문제를 되살리지 않는다.
- 댓글은 현재 conversation + inline 합계를 유지한다. `totalCommentsCount` 단일 대체는 채택하지 않는다.

## 7. native push·pull·fetch

native Git은 pack·credential helper·hooks·프로토콜·remote rewrite·lease의 실행 주체로 유지한다.
직접 API용 토큰을 Git 쓰기 인증으로 주입하지 않는다.

- 정상 pull/fetch의 기존 단일 전송, 준비 상태 재검증, stash 복구, 고정 source OID와 단계별 push lease를 유지한다.
- GitHub HTTPS의 최초 401을 피하는 `http.proactiveAuth=auto`는 **옵션을 켠 경우만** 명령 단위로 적용한다.
  기본은 꺼짐이며 이 옵션을 켜도 기존 명시적 http.proactiveAuth/emptyAuth·credential 정책을 덮지 않는다.
- native Git이 선택한 기존 credential helper를 쓰고 사용자 전역·로컬 Git 설정 파일을 변경하지 않는다.
- 대상은 Git이 실제 해석한 HTTPS GitHub.com URL이다. SSH·다중/상이한 push URL·불확실한 rewrite는 기존 경로다.
- 공개 remote에서 켜면 원래 필요하지 않던 인증을 요구할 수 있으므로 설정 설명에 적용 조건을 명확히 적는다.
- 현재 공개 pull/fetch에서 추가 개선은 입증되지 않았다. 구현 후에도 개선되지 않으면 속도 개선으로 보고하지 않는다.
- 전송 완료와 이미 분리된 Graph refresh 큐를 유지한다. 필요한 갱신을 제거해 완료 표시만 빠르게 만들지 않는다.

## 8. 설정과 배치 제안

설계자가 제안하는 고급 설정은 두 개다. 별도의 로그인 화면·새 버튼·웹뷰 레이아웃은 추가하지 않는다.

| 설정 | 기본값 / 범위 | 역할 |
| --- | --- | --- |
| `githubReadTransport` | `auto` / machine-overridable | 검증된 지원 환경은 HTTP, 미지원 환경은 CLI. `cli` 선택 시 기존 전송을 강제한다. |
| `githubGitProactiveAuth` | `false` / machine-overridable | 인증이 필요한 GitHub HTTPS Git 작업에서 기존 helper의 사전 인증을 사용한다. |

설정에는 영어 기본 문자열과 한국어 번역을 제공한다. 설정 구현은 사용자에게 보이는 변경이므로
`ui-design-workflow`의 적용 범위를 확인하고 실제 Settings 표시와 전환 동작을 검증한다.
전송 방식 변경은 새 세대를 열며, 이미 승인해 진행 중인 Git 쓰기의 정책을 중간에 바꾸지 않는다.

## 9. 단계와 완료 조건

1. typed request/오류/인증/문맥 계약을 만들고 CLI adapter의 기존 결과를 보존한다.
2. HTTPS pool과 compatibility 선택을 넣고 실제 Extension Host의 proxy/CA·취소·종료를 검증한다.
3. 상세 불변 파일 재사용과 얕은 warm 목록/검색 snapshot을 연결한다.
4. native Git 사전 인증 옵션을 별도로 구현·검증한다. 일반 경로와 hook/lease는 그대로 유지한다.
5. 같은 데이터의 CLI/HTTP·수정 전후를 순서 교대 7쌍으로 측정하고 승인할 릴리스 범위를 결정한다.

필수 검증은 다음과 같다.

- 기존 DTO 전체의 동등성, 모든 commit/review/file tail, exact/missing PR 혼합 검색, 반복 cursor·부분 오류.
- 인증/환경/포함 설정/host 변경 중 응답, token stdout/오류 원문 유출 방지, 다른 origin redirect 거부.
- 취소 소비자 격리, queued timeout, socket close 후 슬롯 반환, stale socket 단일 재시도, pool/리스너/타이머 상한.
- proxy/CA/Unix socket/Enterprise의 최초 CLI 선택, CLI 강제 설정, Node 18 및 실제 Extension Host 실행.
- 같은 head/base의 최신 댓글 반영, 변경된 head/base의 파일 재수집, 누락·truncated·실패 snapshot 비재사용.
- native Git helper/401·잘못된 자격 증명·명시적 설정 우선순위, hook 실행, source/config 변경, lease·stash 원본 보존.
- 기존 전체 `npm test`, 타입 검사·production package, 의미 있는 변경별 회귀 검사. 사용할 수 없는 검사는 명시한다.
- 인증 획득을 포함한 첫 표시·완료·재열기·API 횟수와 Git 전송 단계별 시간. 파일/원격 원문은 익명화한다.

직접 HTTP 표본의 15~26% API 구간 차이를 제품 전체 속도 개선으로 보고하지 않는다.
복잡한 network 환경이 호환 경로로 남을 때도 기능이 유지되어야 하며, 성능 증거가 없는 우회는 기본 경로로 승격하지 않는다.

승인 후 작성한 [구현 계획](../plans/2026-11-01-github-http-performance.md)의 여덟 단계를 완료했다.
전체 검사·Node 18·실제 Extension Host·독립 리뷰 수정과 140개 표본/49개 DTO 비교는 최종 결과 문서에 기록한다.

## 근거 문서

- [GitHub CLI 환경·호스트·토큰 우선순위](https://cli.github.com/manual/gh_help_environment)
- [gh auth token](https://cli.github.com/manual/gh_auth_token)
- [Node 18 HTTPS](https://nodejs.org/docs/latest-v18.x/api/https.html)
- [GitHub REST 사용 권고·conditional request·rate limit](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [VS Code의 확장 proxy 지원 범위](https://code.visualstudio.com/docs/setup/network)
- [Git http.proactiveAuth](https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpproactiveAuth)
