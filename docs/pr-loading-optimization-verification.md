# PR 로딩 최적화 검증 — 0.1.72077, 2026-10-05

## 원인과 변경 범위

실제 Output 기록에서 Graph 기본 데이터 준비는 340ms, 로컬 metadata는 50ms였지만,
80개 PR마다 commit·review 연결을 함께 펼치는 첫 GitHub 응답은 9387ms였다.
후속 pagination을 포함한 목록 완성은 10317ms였다. 선택한 PR #38080은 저장소 이름
확인 4803ms, 상세 5288ms, 후속 파일 조회 3117ms를 순서대로 기다렸다.
기록: `/Users/lky/Library/Application Support/Code/logs/20261004T224235/window14/exthost/output_logging_20261005T111905/8-Git Simple Compare.log`.

- 첫 목록 요청은 동일한 80개 PR의 global ID·저장소·기본 branch·opaque cursor를 받는다.
  모든 기존 필드는 ID 20개씩 최대 네 요청으로 직접 읽는다. OPEN/CLOSED/MERGED,
  UPDATED_AT 순서와 기존 30개 commit·20개 review 첫 페이지 크기는 유지한다.
- 전체 commit OID와 댓글 수의 후속 pagination, 완성 정보 재사용, 진행 snapshot,
  Git 쓰기 전 완전성 검사는 유지한다. 누락·중복·다른 ID와 GraphQL 부분 오류는
  전체 실패이며 첫 오류 또는 취소 때 동료 요청을 중단한다.
- 상세와 Explorer 파일은 `{owner}/{repo}`를 gh에 직접 전달해 사전 `repo view`와
  remote config 조회를 생략한다. `GH_REPO`가 바뀌면 현재 선택을 사용한다.
- UI·프로토콜·설정·의존성과 stash 표시 설정은 수정하지 않았다.

GitHub CLI의 [공식 API 문서](https://cli.github.com/manual/gh_api)는 endpoint와 typed
field의 저장소 치환 및 배열 변수를 설명한다. 설치된 gh 2.95.0의
[공식 구현](https://github.com/cli/cli/blob/v2.95.0/pkg/cmd/api/api.go)은 API host를
인증 설정의 DefaultHost/GH_HOST 또는 명시적 hostname으로 정한다. 새로운 ID 요청도
기존 root 요청과 같은 gh 실행·환경을 사용한다. Enterprise 서버의 실측은 수행하지 않았다.

## 실제 제품 코드 전후 비교

추가 VS Code 창 없이 수정 전 `be24d14`와 수정 코드를 각각 번들하고 실제 gh 인증으로
`/Users/lky/project/captain`의 목록·상세·Explorer 파일을 읽었다. 목록은 before → after
→ after → before 순서로 측정해 후속 pagination까지 완료했다. 시간은 이 관측의 값이며
네트워크·서버·OS 대기에 따라 변한다. 단일 상세 비교의 큰 차이를 평균 개선율로 주장하지 않는다.

| 구간 | 수정 전 | 수정 후 | 결과 확인 |
| --- | ---: | ---: | --- |
| 목록 첫 표시, 비교 1 | 18474ms | 3810ms | 동일한 80개 PR |
| 목록 완성, 비교 1 | 19426ms | 4651ms | 전체 결과 deep equality |
| 목록 첫 표시, 비교 2 | 4529ms | 2994ms | 동일한 순서·cursor |
| 목록 완성, 비교 2 | 5480ms | 3762ms | 전체 결과 deep equality |
| PR #38080 상세, 저장소 이름 cache cold | 14713ms | 1717ms | 전체 상세 deep equality |
| PR #38080 Explorer 파일, cache cold | 3605ms | 2930ms | 전체 파일 deep equality |

모든 목록에 PR 80개·commit OID 481개·댓글 합계 576개가 있었으며 각 PR의 commit와
댓글 완료 표시는 모두 true였다. 전체 `PullRequestListPage`를 대조해 PR의 모든 필드,
라벨·파일 수·review decision·branch/OID·순서·저장소·기본 branch·pageInfo가 일치했다.
정규화한 전체 결과 SHA-256은 네 실행 모두
`f2264b00c0d0cc8f48396688fd81c9b32ae510175d4ab330ea97e1b7a5ac40ee`였다.

상세에는 파일 134개·파일 review 댓글 23개·총 댓글 24개가 있었고 잘림 표시는 false였다.
전체 상세 결과 SHA-256은 두 실행 모두
`386a3cad6db3c4aa048015c559f1089f044859231f67748a6f987b12de2f25ef`였다.
Explorer 파일 134개도 상태·이전 경로·증감 수를 포함해 일치하고 잘림은 false였다.
전체 Explorer 파일 결과 SHA-256은
`8f8fc3362f4e5713a0b1a356e8463aebdaf9de5cba31857dc09ced079ea31650`으로 일치했다.
본문·인증을 제외한 원시 기록: `/private/tmp/gsc-pr-product-comparison.json`.

최종 source를 기본 shared runner로 실행한 추가 조회에서도 목록·상세·Explorer 전체
결과 hash가 위 결과와 일치했다. 전체 검사와 겹친 목록 관측은 10328ms였으며 상세는
1586ms, Explorer는 1619ms였다. `/private/tmp/gsc-pr-final-native.json`.
검사 종료 뒤 같은 shared runner로 순차 비교한 목록은 수정 전 첫 표시 8370ms·완성
11278ms, 수정 후 첫 표시 2940ms·완성 3816ms였다. 이 비교도 전체 결과 deep equality가
true였다. `/private/tmp/gsc-pr-default-comparison.json`.

목록의 기본 API 요청은 1회에서 5회로 늘어난다. 이 저장소에서는 기존 후속 조회
3회를 더해 총 4회 → 8회였고 최대 동시 요청은 수정 후 네 개였다. 별도 query-shape
probe에서 기본 GraphQL cost는 20 → 21이었다. 요청 수를 늘리는 대신 느린 중첩
connection을 나누며 목록 개수나 데이터 양을 줄이지 않는다.

## 검사와 한계

- 수정 전 새 핵심 검사 7개가 실패했고 수정 후 모두 통과했다. 추가 응답 검증 3개와
  null identity 검사도 실패 재현 후 수정했다. 초기 기록:
  `/private/tmp/gsc-pr-loading-red-final.log`, `/private/tmp/gsc-pr-loading-validation-red.log`,
  `/private/tmp/gsc-pr-loading-boundaries-red.log`.
- 최종 새 검사 13개 통과: 80개 전체 필드·순서·cursor, 네 요청 중첩, 누락 identity,
  외부 취소, 최초 요청 오류 보존·동료 취소, GraphQL 부분 오류, 필수 연결 누락,
  null root node, 상세·Explorer의 사전 조회 없음과 `GH_REPO` 변경을 포함한다.
  상세·Explorer 검사는 실제 서비스와 fake executable의 자식 프로세스 인자를 확인한다.
  `/private/tmp/gsc-pr-loading-boundaries-green.log`.
- 기존 목록·댓글 pagination·진행·완료 재사용·Git 쓰기 보호·cache 관련 검사 70개는
  추가 null 경계 수정 전에 통과했다. 전체 최종 검사는 아래 릴리스 기록에 기입한다.
- 첫 전체 실행은 950개 중 941개 통과·9개 실패였다. 기존 실제 프로세스 검사에서
  sandbox 내부 `ps`가 code 127로 실패했고, fixture 시작의 2초 가정 및 시작 대기까지
  포함한 close 상한 때문에 준비 실패와 늦은 rejection도 발생했다. 권한 제한 없이
  재검증한 뒤 시험 fixture 시작 대기를 최대 10초로 분리하고 실패를 즉시 관찰하도록
  수정했다. 취소 이후 close 5초 상한·오류 code·실제 부모/자식 PID 종료 검사는 유지한다.
  수정 후 관련 프로세스 검사 13개가 모두 통과했다.
  `/private/tmp/gsc-pr-loading-full.log`, `/private/tmp/gsc-pr-loading-process-final.log`.
- 다음 전체 실행은 949개 통과·1개 실패였다. 시험용 1초 deadline이 OS 시작 지연 중
  자식을 종료해 준비 파일이 없어진 경우였다. deadline fixture는 최대 10초 시작 대기
  뒤에 실행되는 15초 deadline을 사용하고, 호출 시작부터 deadline + 5초 안에 close를
  확인하도록 보강했다. 지정한 deadline의 조기 발동 금지와 실제 부모·자식 종료를
  모두 검사한다. 제품의 조회 timeout·종료 정책은 변경하지 않았다.
  `/private/tmp/gsc-pr-loading-full-final.log`.
- 별도 읽기 전용 reviewer는 사용 한도 오류로 중단됐다. 이를 검토 통과로 간주하지
  않는다. 직접 source와 공식 gh 구현으로 host·실패·취소 경계를 확인하고 관련 검사를
  실행했다.
- 추가 VS Code 시험 호스트·실제 UI 시각 검사·장기 사용 후 UI 속도 검사는 수행하지
  않았다. Mac과 SentinelOne을 재시작하지 않았다. 이미 활성화된 창의 새 코드 적용에는
  설치 후 `Developer: Reload Window`가 한 번 필요하다.

## 릴리스 기록

- 최종 전체 Node 검사: 950 passed, 0 failed, 0 skipped, exit 0,
  153118.229542ms. `/private/tmp/gsc-pr-loading-full-release.log`.
- 최종 타입 검사와 diff check 통과. Production 빌드와 0.1.72077 VSIX 패키징 exit 0.
  패키지는 120 files, 826.97 KB이며 docs와 test는 배포 파일에 포함하지 않는다.
- 패키지 name/publisher/version은 `gitsimplecompare`/`newdlops`/`0.1.72077`로 확인했다.
  빌드와 VSIX의 `dist/extension.js` SHA-256은
  `450c19570dd76a841e10c6cc513d75a8574a3a6ef9f862d1ed209c94daa25b92`로 일치한다.
  VSIX 자체 SHA-256은
  `f85030aff58d8801e913b93d8fe6b7adcc811647591734ff01ef7bacdba7b39c`다.
  `/private/tmp/gsc-pr-loading-release-verification.json`.

설치와 공개 배포 결과는 명령 완료 후 이 절에 추가한다.
