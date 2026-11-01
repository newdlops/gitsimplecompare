# GitHub HTTP 후속 개선 측정

기준 소스 `341e1b2`와 구현 소스 `04bc29b`를 같은 설치 의존성으로 bundle해 비교했다. Node 22.22.2, Apple Git 2.50.1에서 각 항목을 **전→후 / 후→전 / 전→후** 순서로 세 쌍 실행했다. 아래 시간은 각 측의 중앙값이며, 모든 쌍에서 해당 서비스의 **전체 반환 값**이 같았다. 객체 key의 삽입 순서만 정규화했으며 배열 순서·본문·metadata·footer는 모두 비교했다.

[전체 측정 값과 payload hash](http-followup-performance-20261101.json), [설계](../superpowers/specs/2026-11-01-http-followup-optimization-design.md), [구현 계획](../superpowers/plans/2026-11-01-http-followup-optimization.md).

## 측정 결과

이 수치는 소유한 로컬 Git/HTTP/TLS와 통제한 API/gh 응답에서 나온다. 실제 인터넷 GitHub의 일반적인 속도 향상률로 해석하지 않는다. 요청 수에는 표에 명시한 경계만 포함하며, 인증 조회·전체 CLI 호출·쓰기 횟수는 JSON에 별도로 기록했다. 바이트는 서버가 보낸 HTTP 응답 body 크기다. TLS/TCP 전체 전송량은 아니다.

| 항목 | 구현·검증 경로 | 전 → 후 | 해석 |
| --- | --- | --- | --- |
| H1 HTML 중복 제거 | `githubWebReadContext`, suggestion fallback | HTML 6 → 2회; 전체 125.13 → 129.00ms | 중복 요청 66.7% 감소. 로컬 전체 시간은 3.1% 증가했다. |
| H2 fragment 병렬·압축 | 실제 TLS, 8개 fragment, 응답별 15ms | 151.54 → 92.21ms; body 104,691 → 836B | 전체 39.2%, body 99.2% 감소. 읽기는 최대 2개다. |
| H3 Advance 묶음 조회 | 실제 branch metadata + fixture gh, 부모 8개 | PR 조회 8 → 1회; 794.14 → 167.84ms | 전체 78.9% 감소. 후 측은 인증 조회 1회를 포함한다. |
| H4 댓글 선표시 | 실제 service/cache 계약, HTML 200ms 지연 | 첫 표시 366.93 → 203.95ms; 완료 366.93 → 487.27ms | 첫 표시 44.4% 단축. 전체 완료는 32.8% 증가했다. |
| M1 Conversation pagination | 실제 조립, terminal page 100개, API 지연 15ms | API 4 → 3회; 33.02 → 20.22ms | 빈 tail 요청 제거. 전체 38.8% 감소. |
| M2 ref·prerequisite typed read | production session/cache/runtime + 통제한 API | CLI 3 → 0회; HTTP 0 → 3회 | 실제 네트워크 시간은 측정하지 않았다. 후 측은 논리 작업별 credential lease 1회, 총 3회다. |
| M3 Submit 대상 조회 | 실제 native Git gate/fetch, 기존 layer 8개 | metadata 10 → 3회; 2,802.65 → 2,608.68ms | 전체 6.9% 감소. PR 쓰기 8회 및 모든 footer/user body가 같다. |
| L1 OAuth 목록 재검증 | native fetch, private fixture 100개, ETag 재열기 | GET 1 → 1회; body 67,191 → 0B; 18.12 → 17.68ms | 매번 인증된 GET을 유지하고 304에서만 저장된 본문을 재사용한다. |
| D1 inspector port hint | 실제 localhost HTTP/WebSocket, 포트 21개 | HTTP probe 21 → 1회; PID 확인 1 → 1회 | 포트 탐색만 줄이며 실제 PID 검증은 계속한다. 5.65 → 1.96ms. |
| D2 선택형 blobless clone | 실제 smart HTTP, 이력 8개·모든 refs·checkout | clone body 1,063,258 → 136,084B; 721.84 → 934.61ms | body 87.2% 감소, 로컬 clone 시간은 29.5% 증가했다. 기본값은 full이다. |

## 비용과 검증 한계

H1/H2/H4의 이전 코드는 Node 22의 global Agent 연결도 재사용한다. 후 코드는 논리 HTML context별 소유 Agent를 최대 2개 연결로 제한하고 종료한다. 서로 다른 context 사이에서는 연결 재사용이 줄 수 있다. 이 측정에서 H2 전 측의 새 연결은 0개, 후 측은 2개였다. 따라서 성과를 단순히 “keep-alive를 처음 도입했다”로 설명하지 않는다. H1은 중복 감소, H2는 압축·동시 읽기, H4는 첫 표시 시점이 주된 개선이다.

H4의 첫 표시 시간은 API-ready callback이다. 실제 native CommentThread 표시·펼침·HTML 실패·파일 전환은 별도의 EN/KO Host 시나리오에서 검증한다. 통제한 gh 자식 프로세스와 보조 인증 조회가 포함되며, 이 로컬 비교에서는 최종 완료 시간이 늘었다. M2의 4.64 → 8.70ms는 메모리 대역 응답을 포함한 조립 비용이므로 GitHub 속도의 증거로 사용하지 않는다.

D2는 clone에 native 접근 preflight와 현재 checkout에 필요한 blob 요청을 포함한다. 처음 과거 blob을 읽을 때 full은 24.11ms/추가 0B, blobless는 315.29ms/132,629B/3요청이 들었다. clone과 이 hydration의 body 합계는 1,063,258 → 268,713B(74.7% 감소)였다. 모든 branch/tag/parent/current file와 과거 파일 내용이 같고, 앱 OAuth를 영속 저장하지 않고 native credential 경로로 hydration했다. 프리플라이트·추가 요청이 유리하지 않은 환경이 있으므로 full 기본값을 유지한다.

이 fixture는 성공 경로의 성능을 비교한다. 취소·인증 변경·rate limit·proxy/Enterprise·페이지 경계·실패/부분 clone 보존은 각각 기능 테스트로 검증한다. 인터넷 환경의 대용량·고 RTT clone 속도와 실제 계정의 OAuth catalog 처리량은 이번 후속 측정으로 주장하지 않는다.

## 재현

```sh
node scripts/benchmark-http-followup.mjs
node scripts/verify-http-followup-tests.mjs
npm run check-types
npm run package
```

첫 명령은 pinned 기준 소스만 임시 디렉터리에 추출하고 같은 fixture에서 30쌍을 실행한다. 실제 GitHub 계정/원격에는 쓰지 않는다. 두 번째 명령은 전체 unit 파일을 누락·중복 없는 두 순차 그룹으로 나누며, 기존 그룹별 15분/worker 3개 제한과 renderer 검증을 유지한다. 결과 검증 및 실제 Host 증거는 [완료 기록](http-followup-verification-20261101.md)에 정리한다.
