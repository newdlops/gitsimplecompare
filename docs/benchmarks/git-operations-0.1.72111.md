# 0.1.72111 Git 작업·Graph·Stash 검증

기준 버전은 0.1.72110(`0ae1783f46`)이며 같은 계측 harness로 이전 commit과 현재 코드를 번갈아 세 번씩 실행했다. 각 회차는 파일 1,000개·기본 커밋 1,000개·곁가지 100개의 새 임시 저장소와 로컬 bare 원격을 사용한다. 사용자 저장소와 GitHub 원격은 사용하지 않았다.

## 반복 측정

아래 값은 세 회차의 중앙값이다. Graph 시간은 작업 완료부터 확장 측 갱신 완료까지이며 실제 화면 paint 시간과 구분한다. 마지막 Graph의 HEAD·부모·ref는 별도의 새 Git 조회와 대조했고 **72회 모두 일치**했다.

12개 작업 전체의 Git 호출 중앙값은 **254→209회(17.7% 감소)**였다. 같은 Node 프로세스의 CPU 시간 중앙값은 1,796→1,486ms였고 Git registry 작업 최댓값은 양쪽 모두 6이었다. 작업별 Node RSS 증가 표본 최댓값은 9→14MiB였으므로 전체 메모리 감소를 측정한 결과로 해석하지 않는다.

| 작업 | 준비·실행 Git 호출 | 후속 갱신 포함 Git 호출 | Graph 이력 재조회 | Graph 갱신 ms |
| --- | ---: | ---: | ---: | ---: |
| push | 21 → 19 | 27 → 24 | 0 → 0 | 563 → 295 |
| pull | 4 → 4 | 15 → 14 | 1 → 1 | 972 → 542 |
| fetch | 1 → 1 | 11 → 7 | 1 → 0 | 699 → 461 |
| rebase | 20 → 15 | 32 → 26 | 1 → 1 | 1341 → 444 |
| merge | 16 → 14 | 26 → 23 | 1 → 1 | 738 → 554 |
| pr-squash-cherry-pick | 28 → 24 | 40 → 35 | 1 → 1 | 1518 → 839 |
| pr-cherry-pick | 31 → 25 | 43 → 34 | 1 → 1 | 947 → 460 |
| cherry-pick | 1 → 1 | 13 → 12 | 1 → 1 | 667 → 571 |
| checkout | 3 → 3 | 10 → 9 | 0 → 0 | 514 → 428 |
| pull-known-history | 4 → 4 | 13 → 9 | 1 → 0 | 1452 → 319 |
| fetch-known-history | 1 → 1 | 12 → 8 | 1 → 0 | 992 → 335 |
| fetch-no-change | 1 → 1 | 12 → 8 | 1 → 0 | 856 → 275 |

원본 수치와 자원 측정의 범위는 [JSON 결과](./git-operations-0.1.72111.json)에 있다. 작업들은 표 순서대로 같은 fixture를 사용하므로 일반 fetch도 앞선 pull이 읽은 이력을 활용할 수 있다. merge 행은 제품의 브랜치 squash merge다. 새 이력을 가져오는 fetch와 실제 no-ff merge는 별도 실제 Git 회귀 테스트에서 확인했다. 시간은 머신 부하와 프로세스 시작 지연의 영향을 받았으며 전체 작업의 일정한 배수 개선을 의미하지 않는다.

재현: 이전 소스는 `GSC_BENCH_SOURCE_REF=0ae1783f46fe24900439e70d9b8873685d32162a`, 현재 소스는 해당 변수를 생략해 `node scripts/benchmark-git-operations.mjs <result.json>`을 각각 실행한다. 추가 세 시나리오는 `GSC_BENCH_OPERATIONS`에 표의 작업명을 쉼표로 지정한다.

## 안전성과 자원 경계

- 브랜치/PR 작업은 한 실행 안에서 private JSON 경로와 검증된 Git 디렉터리만 공유한다. 각 쓰기 경계의 HEAD·브랜치·CAS·Undo 소유권 검사는 새로 수행한다. metadata/gitfile/commondir나 상속 Git 환경이 바뀌면 경로 재사용을 중단한다.
- 작은 직접 Graph 갱신은 최대 256개 ref의 브랜치 metadata를 fingerprint와 함께 읽는다. 많은 upstream, 큰 이력 차이, 손상 ref, 범위 제한 및 불완전 출력은 기존 전체 조회/일괄 계산으로 돌아간다.
- Graph 이력은 동일한 topology 증거와 실제 DAG의 도달 가능성을 확인한 경우에 재사용한다. 갱신을 수행할 때 새 커밋, shallow/graft 변화, replace ref 및 불확실한 증거는 전체 이력 조회 경로를 사용한다. 취소된 직접 요청은 focus/visibility 복귀 때 최신 상태로 다시 조정한다.
- push의 중복 초기 조회만 줄였다. 실제 매 전송과 upstream 변경 직전에는 source·설정·취소를 새로 검사한다. 원격 lease와 부분 성공·재시도 계약을 유지한다.
- Stash 내용 보기는 생성 당시 base, 저장된 working tree, index 및 미추적 tree를 읽기 전용으로 비교한다. 이름 변경의 원본 경로를 사용하고 선택 중 저장소/번호가 바뀌어도 원래 root/hash를 유지한다.
- 완료한 stash metadata는 host 16항목/추정 8MiB, 웹뷰 16항목/40,000파일 예산으로 제한한다. 단일 대형 목록은 열려 있는 동안 표시할 수 있으며 40,000파일을 넘는 목록은 접을 때 해제한다. 접힌 파일 DOM도 즉시 해제한다.

## 실행한 검증

- TypeScript 검사, production bundle, VSIX 생성 및 runtime 파일 124개의 원본 일치 확인.
- 최종 Node 대상 묶음 50개와 충돌/복구 묶음 47개 통과. 경로 수명·교체·취소, 큰 브랜치 추적, 실제 충돌 뒤 갱신, shallow deepen, native Git Graph 정확성, stash 바이트/선택/예산, push 변경 감지를 포함한다.
- Chromium stash/메뉴 검증 10개 통과. 390×844, 768×1024, 1440×900에서 긴 한글/영어, loading·error·retry·empty, 메뉴 툴팁 비중첩, 키보드와 저장소 선택 identity를 확인했다. 각 크기의 메뉴/빈 상태 캡처도 시각적으로 확인했다.
- Changes 기본 renderer의 Axe·키보드·forced colors·reduced motion 검증 1개 통과. 확장된 모든 stash 상태에 대한 개별 Axe나 실제 스크린 리더 검증을 수행한 것은 아니다.
- 별도 profile과 임시 저장소를 사용하는 실제 VS Code에서 등록된 stash 두 명령이 saved-untracked/staged 가상 문서의 본문을 올바르게 열고 HEAD·stash·작업트리를 보존했다.
- 실제 VS Code SCM 명령이 50MiB를 세 번의 순차 push로 전송하고 작업트리/기본 Git 설정을 보존했다.

전체 `npm test`를 통과했다고 주장하지 않는다. 앞선 큰 묶음은 15분 상한에 도달하여 최종 대상 검증을 작은 묶음으로 실행했다. ESLint 실행 파일은 설치되어 있지 않다.

### 실제 Graph paint 검증 범위

직접 갱신 요청 보존 수정 뒤 네 동작(create branch/checkout/new commit/known-history fetch)의 전체 native paint 검증은 통과했다. 이후 작은 브랜치 metadata 병합까지 포함한 현재 candidate는 한 실행에서 앞의 세 동작까지 실제 paint를 확인했지만, 마지막 fetch 직전 OS focus를 확보하지 못했다. 마지막 전체 재시도도 초기 focus 조건에서 중단됐다. 이 재시도들은 통과로 계산하지 않았으며, 사용자 창의 focus나 제품의 focus 판정을 강제로 바꾸지 않았다. 최신 코드의 전체 native Git 상태 대조와 focus 복귀 회귀 테스트는 위의 통과한 Node 묶음에 포함된다.

## Stash UI 기술 감사

범위는 이번 stash 컨트롤과 공용 메뉴 툴팁이다. 기존 VS Code 테마·글꼴·Codicon과 작업 제어면의 밀도를 유지한다. 기계적 검사 10개 대상의 결과는 빈 배열이며 신규 suppression은 없다. fixture의 잘못된 Codicon 별칭 지적은 문서화된 `codicon`으로 수정했다. 기존 다른 파일의 예외 설정은 변경하지 않았다.

| 차원 | 점수(0–4) | 근거와 한계 |
| --- | ---: | --- |
| 접근성 | 3 | 새 파일 행의 role/name/focus/Enter, 메뉴 탐색과 상태 알림 확인. 실제 스크린 리더 검증 없음 |
| 성능 | 3 | 지연 조회·중복 요청 공유·캐시 예산·접힌 DOM 해제. 열린 대형 목록은 전체 행을 생성함 |
| 반응형 | 3 | 390/768/1440px overflow와 긴 문구 확인. VS Code desktop 대상이며 물리 touch 기기 검증 없음 |
| 테마 | 3 | 기존 의미 토큰·Codicon 재사용, dark 캡처와 forced colors 검사. 새 상태의 light/high-contrast 전체 시각 검증 없음 |
| 구현 일관성 | 4 | 기존 메뉴/네이티브 Quick Pick/diff 재사용. detector 신규 지적 0 |
| 합계 | 16/20 | Good — 위에 명시한 검증 범위 기준 |

이번 변경에서 확인한 P0/P1 결함은 없다. 잠재적인 P2 성능 범위는 `media/changes/changesStashes.js`의 열린 대형 stash 전체 행 렌더다. 예산 밖 목록을 접으면 해제되지만 매우 큰 목록의 첫 확장은 파일 수에 비례한다. 별도 확장 시 `$impeccable optimize`로 pagination/가상화를 검토하고 `$impeccable polish`로 확인할 수 있다. 현재 검증에서 이 경로의 frame 지연 수치를 측정하지 않았으므로 실제 지연 결함으로 단정하지 않는다.

`.impeccable/design.json`은 DESIGN.md보다 오래된 보조 캐시다. 이번 감사는 실제 DESIGN.md와 현재 코드/캡처를 기준으로 수행했다. 보조 캐시 갱신은 요청 시 `$impeccable document`로 별도 처리한다.
