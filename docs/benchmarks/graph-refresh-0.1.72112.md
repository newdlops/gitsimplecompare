# 0.1.72112 Graph 갱신·자원·백그라운드 검증

기준은 0.1.72111(`886dd7508431d792888e20a07a9507217a5a63bb`)이다. 실제 production source를 같은 harness로 실행한 원본 결과와 소스 SHA-256은 [JSON](./graph-refresh-0.1.72112.json)에 보존했다. 일부 측정은 manifest 버전만 올리기 전에 실행했으므로 원본의 버전 문자열도 그대로 남겼다.

## 큰 ref 목록의 변경 알림

20개 watcher 알림이 겹칠 때 폐기할 소비자에게까지 ref 목록을 복사하던 비용을 줄였다. 최신 요청을 선정한 뒤 한 번 복사한다. 소비자 수정 격리, 독립적인 취소, 진행 조회와 최신 후속 조회의 상한은 유지한다.

각 크기는 warmup 뒤 5회 측정한 중앙값이다. ref 이름과 원본 목록을 측정 전에 만들고, 복사 횟수만 getter로 관찰한다. 매 표본 전 명시적인 GC를 수행했다.

| ref 수 | 복사한 객체 | Node CPU ms | 조정 완료 ms | 관측 peak heap 증가 MiB |
| --- | ---: | ---: | ---: | ---: |
| 2,000 | 42,000 → 2,000 | 23.61 → 1.73 | 23.97 → 1.25 | 7.84 → 1.09 |
| 10,000 | 210,000 → 10,000 | 113.61 → 6.77 | 105.11 → 4.61 | 22.06 → 4.69 |

양쪽 모두 fingerprint 조회 1회, 최종 reload 1회였고 소비자가 원본 snapshot을 수정하지 못하는 것도 확인했다. 객체 복사는 95.2% 줄었다. CPU와 heap은 Node coordinator만의 수치다. heap/RSS는 목록 복사 완료와 실행 완료 시점에서 표본을 얻었으며 Git·Chromium·전체 시스템 자원을 측정한 값은 아니다. 특히 1만 ref의 RSS 증가 중앙값은 0.02→0MiB여서 전체 메모리 사용량 감소로 일반화하지 않는다.

재현은 `node scripts/benchmark-graph-refresh.mjs <result.json>`이다. 이전 source는 `GSC_BENCH_SOURCE_REF=886dd7508431d792888e20a07a9507217a5a63bb`를 지정한다. 두 실행은 같은 harness를 사용한다.

## 실제 Git에서 실제 renderer까지

파일 1,000개·기본 커밋 1,000개·곁가지 100개인 임시 저장소와 로컬 bare 원격을 사용했다. 실제 Git 서비스 → GraphPanel → production Graph HTML/CSP/JS → DOM 및 두 animation frame 뒤 응답까지 연결했다. headless Chromium이므로 OS 창을 띄우거나 포커스를 요청하지 않는다. 사용자 저장소나 GitHub 네트워크를 사용하지 않았다.

| 작업 | Git 작업 완료 → renderer frame ms |
| --- | ---: |
| push | 342 |
| pull | 343 |
| fetch | 312 |
| rebase | 388 |
| 브랜치 squash merge | 424 |
| 일반 no-ff merge | 400 |
| PR squash cherry-pick | 489 |
| PR cherry-pick | 439 |
| cherry-pick | 374 |
| checkout | 235 |
| 이미 읽은 이력의 pull | 403 |
| 이미 읽은 이력의 fetch | 268 |
| 변경 없는 fetch | 342 |
| 별도 새 fixture에서 새 이력 fetch | 574 |

처음 13개는 같은 fixture를 순서대로 사용했다. 일반 fetch는 앞선 pull의 이력을 활용할 수 있다. 마지막 fetch는 별도의 새 fixture에서 대상 object가 로컬에 없다는 것부터 확인했고 Graph 이력 조회가 정확히 1회였다.

14개 모두 별도의 새 Git 조회와 HEAD·부모·refs가 일치했고 renderer의 실제 HEAD 배지와 로드된 300개 commit 행의 refs도 일치했다. production CSP가 위치 스타일을 차단하지 않는지와 renderer 오류가 없는지 확인했다. 수치는 각 시나리오 1회이며 머신 부하·로컬 원격의 영향을 받는다. GitHub 전송 시간이나 모든 사용자 환경의 지연을 의미하지 않는다.

`GSC_BENCH_LIVE_RENDERER=1 node scripts/benchmark-git-operations.mjs <result.json>`으로 실행한다. `GSC_BENCH_OPERATIONS`에 JSON의 작업명을 쉼표로 지정한다. 새 이력 fetch를 검증할 때는 `fetch-new-history`만 별도로 실행한다.

## 안전성과 포커스

- refs가 같아도 shallow/graft 증거가 읽기 상한을 넘거나 불확실하면 자동 watcher 갱신을 생략하지 않는다. 실제 Git이 허용하는 1.23MiB shallow 파일에서 refs를 유지한 채 경계를 깊게 바꾸고 부모·행 수·local-only branch 표시를 새 Git 서비스와 대조했다.
- topology가 바뀌거나 불확실하면 ancestry 기반 캐시를 먼저 무효화한다. 증거가 정상으로 돌아오면 변경 없는 자동 알림은 다시 생략한다.
- full ref 장식을 사용해 Git의 `grafted`/`replaced` 주석과 동명의 실제 브랜치를 구분하고, 합법적인 쉼표 이름을 보존한다.
- Graph의 동적 위치·색상 style 속성만 허용한다. inline script는 기존 nonce 정책을 유지한다.
- Git 작업에는 OS 포커스가 필요하지 않다. 확장은 자원 절약을 위해 비활성 창의 자동 Graph 조회를 보류하고, 복귀 시 최신 요청 한 건을 조정한다.
- 이전 native 검증은 테스트 창을 반복 활성화해 다른 앱의 작업을 방해했다. 앱 강제 활성화·항상 위 표시·Space 이동·포커스 반복 요청을 제거했다. native 측정은 포커스가 없으면 실패하며 visible Host 실행에는 `--allow-visible-host`가 필요하다.

이번 최종 검증은 headless 통합을 사용했다. 최신 코드의 모든 작업을 실제 VS Code 창에서 다시 측정했다고 주장하지 않는다. 사용자에게 창을 앞에 유지하도록 요구하거나 기존 창을 다시 로드하지 않았다.

## 회귀 검사와 패키지

- 관련 Node 묶음 298개에서 294개가 처음 통과했다. 이전 중복 config 조회 횟수와 topology 이전 fingerprint를 기대하던 4개는 현재 계약으로 갱신했다. 해당 두 파일의 16개 재실행은 모두 통과했다.
- headless Chromium 회귀 검사 15개 통과: 초기 status 지연, stale paint 억제, 5,000행의 checkout DOM/선택/스크롤/색상 유지, reference lifecycle, Graph health의 Axe·키보드·live announcement를 포함한다.
- 실제 production Graph에서 commit 선택·Escape를 실행하고 390×844, 768×1024, 1440×900 캡처를 시각적으로 확인했다. 기존 VS Code 테마·Codicon·조밀한 DAG 표시를 유지한다. 좁은 화면의 넓은 DAG는 가로 스크롤을 사용한다.
- TypeScript 검사, production bundle, VSIX 생성 및 runtime 파일 124개의 원본 일치 확인을 통과했다. 개발용 source/test/scripts/docs는 VSIX에서 제외했다. Graph·stash·blame native test bundle은 생성했으며 visible Host 실행 차단도 확인했다.

전체 `npm test`는 장시간 실행을 정리하고 위 변경 영역 묶음으로 전환했으므로 전체 통과로 보고하지 않는다. ESLint 실행 파일은 설치되어 있지 않다.

## Graph 기술 감사

이번 변경 영역에 대한 Impeccable 기계 검사 결과는 신규 지적 0개이고 suppression을 추가하지 않았다. 기존 DESIGN.md와 현재 화면을 기준으로 확인했다. `.impeccable/design.json`의 기존 캐시 노후화는 수정하지 않았다.

| 차원 | 점수(0–4) | 근거와 범위 |
| --- | ---: | --- |
| 접근성 | 3 | Graph health Axe·키보드, commit 선택 유지. 전체 Graph의 스크린 리더 검증 없음 |
| 성능 | 3 | watcher 복사/CPU/heap 감소와 실제 frame 확인. 5,000행 전체 모델/DOM은 유지 |
| 반응형 | 2 | 390/768/1440px 확인. 넓은 DAG의 가로 스크롤과 desktop용 작은 도구 버튼 유지, 물리 touch 검증 없음 |
| 테마 | 3 | 기존 토큰·Codicon과 dark 화면 확인. 모든 light/high-contrast 상태의 시각 검사 없음 |
| 구현 일관성 | 4 | production HTML/CSP 재사용, 신규 detector 지적 없음 |
| 합계 | 15/20 | Good — 위 검증 범위 기준 |

측정에서 발견한 차단 결함인 CSP의 행 위치·색상 누락은 수정했다. 검증한 변경 영역에 남은 P0/P1 결함은 없다. 기존 desktop Graph의 좁은 화면 밀도와 전체 행 DOM은 향후 별도 `$impeccable optimize`/`$impeccable adapt` 검토 대상이며, 현재 목표에 새 레이아웃이나 가상화 구현을 추가하지 않았다.
