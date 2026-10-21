# PR Graph 행 이동 수정 — 0.1.72144

기준은 `66616d7d82d054eb5b464422abd70d4101c20b4a`다.
첫 PR 목록은 제목·작성자·브랜치를 먼저 보여주면서 OID는 후속 조회에서 받는다.
기존 이동 버튼은 이 단계의 빈 후보를 즉시 실패로 처리해 host에 요청조차 보내지 않았다.
커밋을 알고 있어도 일반 fetch에 없는 `refs/pull/<번호>/head`의 객체는 로컬에 없을 수 있었다.

## 동작

- 이동 메시지에 PR 번호를 포함한다. host pager에 실제로 적재한 PR만 보완하며,
  클릭한 PR 한 건의 head/merge OID만 별도 우선 조회한다. 80개 목록의 후속 조회를 기다리지 않는다.
- 현재 그래프에 이미 있는 행은 즉시 사용한다. 새로 찾은 마지막 한 건도 같은 PR 식별 정보에
  한해 재사용한다. 저장소 교체·head·상태·갱신 시각 변경은 재사용을 무효화한다.
- All branches에서 로컬 후보가 없으면 PR URL과 같은 host·owner/repo의 등록 remote에서
  필요한 객체를 가져온다. fork origin이 다르면 같은 저장소의 upstream을 찾는다.
- merge 결과 OID를 우선하며, 해당 OID의 전송이 거절되면 PR head ref를 시도한다.
  명시적·빈 브랜치 필터는 유지하고 이 경로에서는 fetch하지 않는다.
- 전송은 destination 없는 고정 refspec과 `--refmap=`, `--no-write-fetch-head`,
  `--no-tags`, `--no-prune`을 쓴다. submodule·자동 maintenance·commit-graph 갱신도 끈다.
  named ref·FETCH_HEAD·index·작업 파일·config는 변경하지 않고 필요한 object만 추가한다.
  옵션의 의미는 [Git fetch 공식 문서](https://git-scm.com/docs/git-fetch)에 따른다.
- 정확한 고정 명령만 조회 수명으로 분류해 Git·transport 자식의 취소·종료 확인과
  시간 상한을 적용한다. 일반 fetch와 쓰기는 기존 보호를 유지한다.
  객체 준비가 Graph mutation 알림을 보내 자기 이동을 취소하지 않게 한다.
- 같은 OID의 확인은 fetch 전후에만 실행한다. API가 새 head를 돌려준 경우에만 추가 확인한다.
  실패·취소·늦은 응답은 기존 재시도와 latest-wins 처리를 유지한다.

## 검증 방법

`test/pullRequestGraphJump.test.ts`는 격리한 bare remote와 실제 Native Git을 사용한다.
GitHub 단건 응답만 로컬 gh 대역으로 제공하며 실제 서비스 조회와 등록된 Graph message callback을 검사한다.
로컬 수정, index, named refs, config, 기존 FETCH_HEAD의 전후 바이트를 비교한다.
미수신 PR, squash 결과, 최신 head, fork/upstream 선택, 필터, 누락 metadata와 취소를 검사한다.

`test/gitProcessLifecycle.test.ts`는 SIGTERM을 무시하는 Git·transport 자식의 실제 종료도 확인한다.
Git command policy, fetch negotiation, read pipeline과 PR 시작 경로의 회귀 검사를 함께 실행한다.
샌드박스의 프로세스 확인·종료 제한으로 실패한 실행은 중단하고 권한을 적용한 같은 검사로 재검증했다.
잘못 지정한 테스트 파일로 시작하지 못한 실행과 최초 재현 실패 로그도 보존했다.

브라우저 검사는 `test/webview/prRowJump.spec.ts`와 PR 목록·상세·행 갱신 spec을 사용한다.
기존 VS Code 토큰·Codicon·밀도를 유지하고 `ui-design-workflow`를 적용했다.
390×844, 768×1024, 1440×900에서 이동 성공·로딩·실패·키보드 재시도·한국어·reduced motion·
늦은 응답·저장소 교체·요약 행 재사용과 무효화를 확인한다. 관련 axe 검사도 포함한다.

별도 headless production HTML/CSP 검증은 실제 PR 버튼 → 등록 callback → Native 객체 fetch →
실제 DOM으로 연결한다. 첫 목록에 OID가 없는 상태에서 시작해 세 크기 모두 대상 행의 노출과
Graph 포커스를 확인하고, Native 부모/refs와 DOM을 대조한다. 첫 클릭만 window 요청을 보내며
이후 두 클릭은 추가 window/API 요청 없이 같은 행을 재사용한다. 안정된 화면도 각각 직접 확인했다.
이는 기능 검사이며 네트워크 지연이나 전체 작업의 CPU/RSS 개선을 측정한 결과는 아니다.

최종 결과는 서로 다른 Node 검사 57건, 브라우저 검사 29건, production HTML의 세 크기 모두 통과다.
`npm run check-types`, production 패키징과 VSIX 내부 런타임 파일 126개의 원본 대조도 통과했다.
eslint는 프로젝트 의존성에 선언되지 않은 기존 상태이므로 이번 검증에 포함하지 않았다.

## 범위

네트워크·인증·일치 remote 부재나 명시적 필터로 찾을 수 없으면 기존 오류 안내와 재시도를 유지한다.
실제 Captain 저장소는 변경하지 않았다. OS 포커스 전환, foreground Extension Development Host,
강제 reload와 별도 Marketplace 점검을 실행하지 않았다. 원래의 전체 Git 지연·자원 최적화 목표는 계속 진행 중이다.

원시 기록은 `/private/tmp/gsc-pr-row-jump-*`에 보관한다. 이번 커밋은 PR 이동 수정 범위이며,
기존에 진행하던 별도 성능 계측 작업은 포함하지 않는다.
