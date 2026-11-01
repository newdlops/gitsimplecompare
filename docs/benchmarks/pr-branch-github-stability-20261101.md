# PR·브랜치·GitHub 통신 후속 검증

[전체 검증 데이터](./pr-branch-github-stability-20261101.json) · 기준 커밋 `e82d1e1903400202dff272e96b557110f772ab54`. 10월 30일의 미커밋 개선을 독립 리뷰하고 실제 입력에서 빠진 경계를 보완했다.

이 기록은 PR 검색·원격 브랜치 개선의 검증이다. 이후 추가한 PR 미리보기의 중복 조회 감소,
pull 준비 변경 검사와 릴리스 시점의 전체 재검증은
[0.1.72184 패키지 검증](./release-artifact-0.1.72184.json)에 기록한다.

## 확인한 결함과 수정

1. 조회 시작 때 없던 `GH_TOKEN` 등이 후속 페이지에서 다시 상속됐다. 전체 환경 snapshot을 표시해 빈 변수도 유지하고, 설정 탐색 Git 프로세스는 같은 환경만 사용하게 했다. 원래 저장소와 다른 `GIT_DIR`가 나중에 추가되는 실제 Git 재현도 차단했다.
2. `include.path`로 분리한 원격 설정 변경은 기본 파일 검사만으로 놓쳤다. 기존 Git 설정 원본 탐색을 캐시·세션 검증과 공유했다. 첫 발견 후 변하지 않은 설정은 추가 Git config 실행 없이 재사용한다.
3. `origin/main`이라는 로컬 브랜치와 원격 ref, `main` tag와 현재 브랜치가 겹치면 잘못 비교했다. 표시 이름과 실행 ref를 나누고 remote·local-dot·custom-fetch 모두 정확한 full ref로 읽는다.
4. 한 커밋에 연결된 PR이 100개를 넘으면 이후 PR이 빠졌다. 102개 fixture에서 두 REST 페이지와 모든 metadata를 보존했다. 반복 페이지와 후속 실패는 부분 성공으로 반환하지 않는다.
5. 없는 번호의 PR은 GitHub에서 `null + NOT_FOUND`와 CLI exit=1로 반환된다. 실제 공개 응답을 확인하고 요청한 alias의 명시적 누락만 허용했다. 검색의 텍스트 결과와 같은 묶음의 다른 PR은 남기고 인증·권한 오류는 전파한다.

## 검증

- 전체 `npm test`: 2489개 통과, 1개 선택 검사 생략, 실패 0.
- 전체 실행에 포함한 프로덕션 renderer 검사: 4개 통과 (전체 수에 포함).
- 타입 검사·프로덕션 빌드·`git diff --check` 통과. ESLint 미설치로 lint는 종료 코드 127이다.
- 공개 `cli/cli`에서 PR 80개의 전체 연결, 상세 파일 1개와 REST oracle의 일치, 없는 번호 검색, 존재/미존재 PR 혼합 묶음의 정상 처리를 읽기 전용으로 확인했다.
- 첫 전체 검사 실패 9건 중 5건은 수정 전 HEAD에서도 재현했다. 오래된 필드/캐시/프로세스 수 가정은 실제 계약과 실행 예산으로 고쳤고, 나머지 4건은 고정 event-loop 횟수 대신 실제 요청 시작을 기다리게 했다.

## 최종 코드의 수정 전후 비교

같은 임시 저장소에서 예열 후 순서를 교대해 7쌍을 측정했다. PR 전체 DTO와 브랜치 표시 결과가 같고 새 full ref가 정확함을 검사했다. HEAD·index·config·작업 파일 원문이 보존됐다.

| 항목 | 이전 | 수정 |
| --- | ---: | ---: |
| 원격 branch 상태 Git 실행 | 5 | 3 |
| divergence 이력 순회 | 1 | 0 |
| 원격 branch stdout(bytes) | 37044 | 68843 |
| branch 시간 중앙값(ms) | 524.4 | 464.8 |
| 연관 PR 45개 metadata 요청 | 45 | 3 |
| cold 검색 전체 요청 | 48 | 6 |
| 모의 검색 중앙값(ms) | 188.0 | 72.4 |

검색 시간은 10ms 모의 응답 지연을 포함한다. 실제 GitHub 네트워크 속도 향상으로 일반화하지 않는다. 브랜치 응답은 정확한 namespace/symbolic 정보를 받아 byte 수가 늘었으며, 확인된 효과는 Git 호출 두 번과 이력 순회 제거다. API의 페이지 계약은 [GitHub 공식 문서](https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit)에서 확인했다.
