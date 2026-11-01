# HTTP 후속 개선 검증 기록

H1/H2/H3/H4/M1/M2/M3/L1/D1/D2 구현은 `341e1b2..04bc29b`, 최종 리뷰 수정은 `58d5a4b`와 `0e2419e`에 있다. 취소 예외 문구 의존성을 없애고 결정적 회귀 검사·실제 Host 시나리오·재현 가능한 성능 도구도 추가했다. 버전은 `0.1.72184`, 작업 브랜치는 `codex/github-http-design`이다.

## 전체 검사

| 검사 | 결과 | 근거 |
| --- | --- | --- |
| Renderer 포함 전체 unit 파일 | **360파일, 2,705개 중 2,704 통과 / 0실패 / 1건너뜀** | [모든 파일·그룹·입력 hash](http-followup-full-suite-20261101.json) |
| 취소 경합 집중 검사 | **14/14 통과** | `pullRequestCommentLoading` / `pullRequestCommentProgress` |
| 리뷰 회귀·SSH 집중 검사 | **33/33 통과** | 별칭/다른 host 거부, native SSH 설정·close, comment tail, 요청별 예산 |
| TypeScript | **통과** | `npm run check-types` |
| Production bundle | **통과** | `npm run package` |
| Node 18.20.8 관련 검사 | **32파일, 252/252 통과** | 기존 29파일과 새 API budget/preview comment/SSH 검사 |
| 실제 VS Code EN/KO Host | **모두 통과** | VS Code 1.144.0, Host Node 24.22.1; [EN](http-followup-host-20261101/host-en.json) / [KO](http-followup-host-20261101/host-ko.json) |
| 10항목 성능 비교 | **항목마다 3쌍, 전체 applicable payload 동일** | [측정 결과와 비용](http-followup-performance-20261101.md) |
| 새 문맥의 전체 코드 리뷰 | **Important 3개 수정, Critical/Minor/판단 보류 없음** | 1회 전체 리뷰 후 RED→GREEN; 최종 전체 suite 통과 |

첫 단일 `GSC_VERIFY_PR_RENDERER=1 npm test`는 진행 중 기존 900,000ms 한계에 도달했다. 그 실행에서 로컬 branch 조회 중 취소된 `AbortError`의 메시지가 기존 정규식과 달라지는 테스트 의존성도 발견했다. 의미 있는 계약인 예외 유형을 확인하도록 고치고, 그 단계에서 원격 comment 읽기가 시작되지 않는 결정적 검사까지 추가했다.

Node 18 관련 실행에서 기존 inspector 테스트의 최신 MockTimers 인자 형식이 호환되지 않는 것을 재현했다. Node 18에는 배열 형식을 전달했다. 새 35초 pagination 검사는 실제 Git의 `.unref()`/close timer까지 가상화해 간섭하는 문제를 발견해, 실제 Git 설정 발견을 먼저 완료하고 API latency만 가상화했다. 이전 전체 30초 timer를 임시 복원하면 Node 18에서도 AbortError로 실패했고, 수정 복원 뒤 관련 252/252가 통과했다. 제품 동작을 건너뛰거나 예외 처리로 성공시키지 않았다.

초기 전체 검사는 같은 renderer 검증과 worker 3개/그룹별 15분 상한을 유지하면서 **179/178파일, 누락·중복 없는 두 순차 그룹**으로 실행했다. 1,254통과/1건너뜀과 1,431통과, 총 약 531초였다. 리뷰 뒤에는 새 회귀를 포함한 360파일을 180/180개 두 그룹으로 다시 실행해 2,704통과/0실패/1건너뜀을 확인했다. 최종 입력 hash와 source commit은 새 manifest에 있다. 단일 실행이 15분 안에 끝난다는 증거로 사용하지 않는다. 건너뛴 1개는 별도 opt-in 실서비스 changed-files 교차 검사다. 공개 GitHub API 실제 Host 읽기와 검색 검사는 별도로 실행해 통과했다.

리뷰 뒤 첫 전체 실행에서는 `production PR commit control reaches the native timeline, paginates both ways, and opens history` 1개가 실패했다. 실제 다음 페이지가 paint/DOM 읽기 사이에 도착해 서로 다른 정상 snapshot을 비교한 것이 원인이었다. 동일 경합을 실제 renderer의 Home 키 페이지 이동으로 제어해 RED를 재현했고, 동일 backend snapshot이 유지된 paint/DOM만 Native oracle와 비교하도록 검사 경계를 고쳤다. 정확한 순서·누락·중복 검사는 유지했으며 6/6 및 최종 전체 suite가 통과했다. 제품 Graph 코드는 변경하지 않았다.

## 항목별 완료 지도

아래 기능 검사는 전체 suite에 포함된다. 성능 비교는 전체 DTO/body/footer/refs를 각각 비교하며, 외부 API 응답을 통제한 경우 실제 인터넷 속도라고 주장하지 않는다.

| 항목 | 제품 경계 | 기능 증거 |
| --- | --- | --- |
| H1 | HTML context의 URL/credential/Accept별 성공·실패 공유 | `githubWebReadContext`, `pullRequestSuggestedChangesetsRead` |
| H2 | 최대 2개 HTML reader, 압축, 30초 context, 실제 close/dispose | `githubWebTransport`, `githubWebReadContext` |
| H3 | branch PR alias 묶음, gh 선택 조건, Advance 조립 | `pullRequestBranchLookup`, `pullRequestStackLifecycle` |
| H4 | API-ready service → subscriber cache → native thread | `pullRequestCommentProgress`, `pullRequestCommentLoading`, `githubReadIntegration`, 실제 EN/KO Host |
| M1 | typed REST page metadata와 Conversation의 3개 stream | `githubRestPages`, `pullRequestConversationPages`, preview safety/local-read 검사 |
| M2 | ref/prerequisite typed logical session | `pullRequestRefLookup`, `pullRequestDependencyLookup`, `githubReadIntegration` |
| M3 | Submit head preflight 및 쓰기 뒤 최신 body 조회 | `pullRequestStackLifecycle`, `pullRequestBranchLookup`; 실제 Git source/lease/hook/order 검사 |
| L1 | OAuth 목록의 매회 인증 GET·304·bounded singleflight/cache | `githubRepositoryCatalogCache`, `githubRepositoryCatalog`, `repositorySetupCommands` |
| D1 | port hint와 매번 실제 PID 소유 검증 | `nativeInspectorDiscovery`, retry/blame/process-owner 검사 |
| D2 | full 기본값, native 접근 확인 후 선택형 blobless | `repositoryCloneMode`, `repositoryBloblessClone`, setup service/commands, 실제 smart HTTP와 EN/KO Settings |

## 실제 Host 기능과 화면

확장을 활성화한 별도 profile/PID의 실제 VS Code 창에서 소스 service/cache/controller와 native CommentThread를 실행했다. 댓글 API/gh/HTML 외부 경계만 fixture로 제어하며 Git branch 확인·단계별 게시·캐시·에디터 이벤트·실제 thread 렌더링은 제품 코드를 사용한다. 댓글 시나리오는 인터넷 계정의 댓글을 변경하지 않는다.

**기능 검사:** HTML 완료를 막아 둔 동안 API 댓글과 답글이 나타났고, provisional snapshot은 completed TTL에 없었다. 기본 접힌 thread를 실제 명령으로 펼친 뒤 HTML 403을 완료해도 같은 thread 객체와 Expanded 상태가 유지됐다. 다음 읽기 중 다른 파일로 옮기면 저장소 singleflight는 계속됐지만 오래된 댓글은 새 파일에 다시 나타나지 않았다. Dispose 뒤 thread와 cache가 비워졌다.

**화면 검사:** EN/KO 각각 1440×900과 900×700에서 실제 캡처를 열어 확인했다. 긴 한글 본문·code block·답글이 줄바꿈되며 댓글 widget에 가로 overflow가 없었다. 하단 Comments 목록과 보조 sidebar를 닫아 에디터 thread를 확인했다. Settings의 full→blobless→full은 화면에 보이는 SELECT 값과 실제 저장 값을 모두 확인했다. Clone 설명·Git 2.46 조건·이후 과거 내용 다운로드 문구와 control이 두 폭에서 읽힌다. native Settings shell에는 가로 scrollbar가 나타날 수 있으며, shell 자체의 무가로 overflow를 주장하지 않는다.

- 댓글: [EN 1440](http-followup-host-20261101/comments-en-1440.png), [EN 900](http-followup-host-20261101/comments-en-900.png), [KO 1440](http-followup-host-20261101/comments-ko-1440.png), [KO 900](http-followup-host-20261101/comments-ko-900.png)
- 보완 실패 뒤: [EN](http-followup-host-20261101/comments-en-html-failed.png), [KO](http-followup-host-20261101/comments-ko-html-failed.png)
- 다른 파일로 전환 뒤: [EN](http-followup-host-20261101/comments-en-stale-file.png), [KO](http-followup-host-20261101/comments-ko-stale-file.png)
- Clone Settings: [EN 기본값](http-followup-host-20261101/clone-settings-en-1440.png), [EN blobless](http-followup-host-20261101/clone-settings-en-blobless.png), [KO 기본값](http-followup-host-20261101/clone-settings-ko-1440.png), [KO blobless](http-followup-host-20261101/clone-settings-ko-blobless.png)

격리 창이 비활성일 때 `innerWidth`와 native Settings layout 갱신이 어긋나고, 포커스가 빠져 두 번째 입력/댓글 refresh가 스킵되는 harness 실패를 재현했다. visible Host 허용과 PID/profile 검증을 모두 통과한 **소유 테스트 창만** 활성화하고, 그 창의 background throttling을 끈 뒤 frame/compositor 갱신을 기다린다. 상태를 DOM 값으로 바꾸지 않고 실제 native 입력을 사용했다. 최종 EN은 checkbox mouse on/off, KO는 mouse on/Space off를 통과했다. 다른 사용자 창이나 profile에는 입력하지 않았다.

HTTP Host 시나리오는 실제 공개 API의 최초 CLI bootstrap→검증 뒤 HTTP, 실제 검색 HTTP, 강제 CLI와 unsupported proxy/CA/Enterprise 정책의 최초 CLI 선택도 확인했다. 로컬 TLS에서 인증서 검증 유지·구독자 취소 격리·연결 재사용·dispose 시 실제 close까지 확인했다. 이 QA 환경은 macOS이며 Windows/Linux의 실제 Host 시각 검사는 수행하지 않았다.

## 최종 리뷰

새 문맥의 `gpt-6-astra` xhigh reviewer가 main 분기점 `9e75326..ad713b2` 전체를 읽기 전용으로 검토했다. Critical/Minor/판단 보류는 없었고, 다음 3개를 사용자 영향 기준으로 Important로 유지했다. 한 번의 수정 단계에서 각각 RED→GREEN을 확인했으며 재리뷰는 요청하지 않았다.

1. **SSH 별칭이 PR을 놓침:** `github-work`를 canonical host와 그대로 비교해 같은 저장소 PR을 못 찾았다. 실제 `ssh -G`의 Include/HostName 결과를 읽고 `ssh.github.com`을 정규화했다. 같은 작성자/branch라도 다른 서버의 PR을 선택할 수 없도록 host 불일치는 실패시킨다. [gh의 SSH translator 적용 경계](https://github.com/cli/cli/blob/v2.95.0/pkg/cmd/factory/remote_resolver.go)를 확인했으며, 평가는 고정 환경·3초 상한·1MiB 출력 상한·절대 PATH·기존 managed process close를 따른다. SSH 평가가 실패하면 gh처럼 원래 host를 남기지만, canonical host와 다르면 PR을 추측하지 않는다.
2. **Preview Files의 조용한 comment tail 누락:** 3,001개가 3,000개 성공으로 반환되는 것을 재현했다. 승인 설계의 댓글 10페이지 한계를 적용하고 실제 tail은 명시적 제한 오류로 반환한다. 1,000개 terminal page 성공, 1,001/3,001개 실패와 전체 body 보존을 확인했다. changed-files는 별도 30페이지/3,000개를 그대로 읽는다.
3. **API 전체 30초 제한 회귀:** Conversation의 전체 timer와 branch lookup의 공유 deadline을 없애고, 기존 session의 요청별 새 30초 예산을 쓴다. 전체 취소·오류 시 sibling 종료는 유지한다. 일곱 페이지×5초와 selection 20초+body 15초가 성공하며, 이전 구현에서 실패하는 것을 확인했다. HTML의 승인된 전체 30초 context는 유지한다.

처리 비용/조건은 [성능 보고서](http-followup-performance-20261101.md)에 함께 기록했다. 최종 전체 suite는 수정 후 2,704통과/0실패/1건너뜀이다. [통합 검증 metadata](http-followup-verification-20261101.json)에 실행 소스와 판단을 남겼다.

## 기록한 판단

아래는 이 계획의 모든 `Ruling:`이며 순서를 보존했다.

1. 설계 공개 뒤 사용자가 같은 목표를 재개한 것을 권장 설계 진행 지시로 해석했다. 해석이 다르면 선택형 clone 정책을 다시 조정해야 하며 full 기본값은 유지한다.
2. 기존 전용 브랜치에서 inline으로 진행했다. 별도 checkout 격리 효과는 없다.
3. 응집된 작은 helper는 300줄 미만으로 유지하고 변경 제품 모듈의 600줄 상한을 지켰다. 엄격한 최소 300줄을 의도했다면 helper 통합이 필요하다.
4. 전체 검사를 기존 제한의 두 순차 그룹으로 나눴다. 모든 파일은 검증하지만 단일 실행의 15분 완료를 보장하지 않는다.
5. Task 11이 리뷰를 포함하므로 그 완료 기록 전에 최종 리뷰를 수행했다. 완료 기록의 순서만 바뀌며 검사/리뷰 gate를 생략하지 않았다.
6. Preview Files 댓글에는 승인된 10페이지 한계를 적용하고 파일의 30페이지 한계는 분리했다. 과거 완전히 읽힐 수도 있던 1,001–3,000개 댓글은 이제 명시적 제한 오류가 된다.

Deferred minors: 없음.
