# Graph 병렬 준비 후보 평가 — 2026-10-20

후속 배포의 구현·검증 기록은 [0.1.72116 범위 조회 개선](local-only-groups-0.1.72116.md)에서 확인한다.
아래 내용은 그 전에 평가한 병렬 준비 후보의 기록이다.

**결정: 후보를 배포에서 제외하고 제품 소스를 원복했다.** 화면 안 tip 선택의 순차 5회
중앙값은 화면 반영 1852→2660ms, Node CPU 341→357ms, 동시 Git 2→3개였다.
반복 가능한 성능 이득을 입증하지 못해 0.1.72116을 발행하지 않았으며, 배포·설치된
0.1.72115를 유지한다. 이번 커밋에는 측정 도구의 HEAD 위치 가정 수정과 평가 기록만 포함한다.

기준은 0.1.72115(`f865d9d8cf6ea5c1ea1c8403f73fff4afd7389ef`)다. 같은 harness를
기준 commit과 작업 트리 source에 연결했다. source 종류·commit·번들 SHA-256과 모든 완료
표본은 [JSON](graph-branch-preparation-evaluation-2026-10-20.json)에 보존한다. 작업 트리의 commit 필드는
기반 HEAD이며 미커밋 구현은 bundle SHA-256으로 구분한다.

## 폐기한 후보의 설계와 안전 검사

아래 설계는 평가한 후보에 해당하며 현행 제품 코드에는 포함하지 않는다. 후보 소스와
tracked diff는 로컬 `/private/tmp/gsc-graph-branch-preparation-rejected`에 별도로 보관했다.

큰 ref catalog의 직접 갱신에서 native 로컬 브랜치 상태를 fingerprint와 함께 시작한다.
전체 원격 ref에 상세 metadata를 요청하지 않고, 이전 목록에서 선택한 divergent upstream
최대 8개·16 KiB만 완전 일치 glob로 추가한다. 이름이 사라져도 자식 ref 전체로 범위를 넓히지
않는다. 로컬 상태·counts·upstream 설정은 요청마다 새로 읽으며 이전 값은 조회 이름 선택에만 쓴다.

준비 결과는 HEAD/symbolic HEAD, 전체 로컬 tip, upstream tip 또는 동일 OID의 0/0,
history identity, 실행 경로가 현재 fingerprint와 맞을 때만 한 번 소비한다. 불확실하면 기존
native snapshot으로 돌아간다. timeout·취소·종료 대기 오류는 같은 무거운 조회로 재시도하지
않는다. 손상 ref는 기존 격리·경고 경로를 유지한다.

fingerprint는 metadata를 기다리지 않고 반환하므로 새 이력의 첫 log 시작을 늦추지 않는다.
작은 목록은 기존 합친 조회를 유지하며, batch tracking·필터·busy Git·알려진 replace refs는
추가 병렬 준비를 생략한다. 숨김·필터·서비스 교체·처분 시 준비를 취소하고 실제 종료를
추적한다. 이전 자식이 종료 중이면 새 준비를 겹치지 않는다. 새 타이머나 세대 간 상태 캐시는 없다.

## 순차 반복 비교

파일 1,000개·기본 commit 1,000개·곁가지 300개와 로컬 bare 원격을 사용했다. 두 경로를
각각 기준 5회 후 최종 source 5회 실행했으며, 다른 테스트/benchmark를 동시에 실행하지 않았다.
production HTML/CSP/JS를 headless Chromium에 연결했다. 각 값은 5표본 중앙값이다.

| 경로 | host Graph ms | 실제 화면 반영 ms | Node CPU ms | 후속 Graph Git 수 | 동시 Git 수 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 페이지 밖 topic 선택 | 1213 → 1299 | 1578 → 1529 | 322 → 278 | 10 → 9 | 4 → 4 |
| 화면 안 tip 선택 | 1514 → 2077 | 1852 → 2660 | 341 → 357 | 6 → 6 | 2 → 3 |

화면 안 tip 선택은 Graph 행에서의 checkout을 모사하며 이력 log 0회를 검사했다. 페이지 밖
topic 선택은 현재 HEAD가 첫 300행에 없는 경우로, native 페이지와 정확히 같은 행·HEAD
표시를 요구한다. 초기 반복 시도는 측정기의 HEAD 위치 가정으로 실패했으며 완료 표본에
포함하지 않았다. 해당 가정을 고친 뒤 양쪽 source에 동일한 도구로 다시 실행했다.

화면 반영은 Git 작업 완료부터 실제 renderer frame 응답까지다. host Graph는 갱신 호출
완료까지이며, status·보조 조회 전체 완료와는 다르다. Node CPU/RSS는 호출 조립 프로세스만
측정하며 Git·브라우저·전체 확장의 CPU/메모리가 아니다. 보조 status/tag/config 조회 수는
cache 시점에 따라 달라져 중앙값 감소를 명령 제거 효과로 단정하지 않는다. 느린 표본과
증가한 host 시간도 JSON에 그대로 남겼다. 모든 저장소·작업이 일정 비율로 빨라졌다고
주장하지 않으며, 전체 지연 목표 달성 값은 false다.

## 11개 작업 관찰

다음 표는 항목당 기준·후보 각 1회다. 기준 실행은 일부 UI/회귀 검사와 겹쳤고 후보 실행의
초기에도 다른 검사가 남아 있어 인과적 개선율 산출에 사용하지 않는다. 행렬 뒤 작은 필터
목록의 기존 합친 조회를 유지하는 guard를 보강했고, 위 반복 비교와 최종 105개 검사는
그 보강이 포함된 source로 실행했다.

| 작업 | host Graph ms | 화면 반영 ms | 후속 Graph Git 수 | 동시 Git 수 |
| --- | ---: | ---: | ---: | ---: |
| push | 1644 → 776 | 2075 → 1063 | 6 → 6 | 2 → 3 |
| fetch-new-history | 1704 → 952 | 2188 → 1159 | 11 → 9 | 4 → 4 |
| pull | 2219 → 2009 | 2695 → 2329 | 6 → 7 | 2 → 3 |
| fetch | 863 → 1071 | 1205 → 1468 | 7 → 7 | 2 → 3 |
| rebase | 2055 → 1413 | 2427 → 1732 | 12 → 11 | 4 → 4 |
| merge | 2636 → 1099 | 2880 → 1323 | 12 → 12 | 4 → 4 |
| merge-no-ff | 1582 → 812 | 1881 → 983 | 12 → 12 | 4 → 4 |
| pr-squash-cherry-pick | 2114 → 946 | 2892 → 1198 | 11 → 12 | 4 → 4 |
| pr-cherry-pick | 3637 → 1847 | 4422 → 2120 | 11 → 11 | 4 → 4 |
| cherry-pick | 4748 → 965 | 5194 → 1339 | 11 → 12 | 4 → 4 |
| checkout | 2893 → 1304 | 4115 → 1761 | 7 → 7 | 2 → 3 |

11개 모두 native 새 조회와 host 커밋·부모·refs가 같았고, 실제 300행 DOM의 HEAD/ref도
일치했다. 새 object fetch는 Graph log 정확히 1회를 검사했다. 행렬의 push는 upstream이
없는 첫 게시이고, pull은 앞선 fetch가 가져온 알려진 이력을 사용한다. 원격은 로컬 bare
저장소이므로 실제 GitHub 네트워크 지연을 측정한 것은 아니다.

이력 재사용 경로의 동시 실행은 2→3개가 된 항목도 있다. 전체 행렬과 반복에서 관찰한
최댓값은 4개였으며 이를 모든 경합 상황의 scheduler 상한으로 주장하지 않는다. 새 준비는
한 요청만 보관하고 종료 중의 준비와 다시 겹치지 않는다.

## 후보 검증과 재현

- 후보 관련 Node 검사 105개, headless UI 검사 23개, TypeScript·production build·diff 검사 통과.
  기능 검사의 성공만으로 성능 후보를 채택하지 않았다.
- Native scoped 조회, upstream 변경, 긴 UTF-8 ref, 손상 ref, 같은 OID checkout, 다른
  서비스 객체, 한 번만 소비, 오류·취소·실제 자식 종료를 검사했다. 대기하는 Git 대역
  실행파일 세 개를 공통 실행기/소유 레지스트리로 시작해 취소 뒤 실제 PID 종료도 확인했다.
- 정상 Git 화면과 긴 경고를 390·768·1440px에서 각각 촬영·육안 확인하고 commit 클릭,
  Escape, 늦은 상태, 선택·스크롤·웹뷰 내부 focus 유지를 검사했다.
- OS 포커스 이동, visible Extension Host, 강제 다시 로드, 전체 저장소 테스트, ESLint,
  밝은 테마 전체 및 실제 터치 장치 검증, Marketplace 상태 점검은 하지 않았다.
- 상세 UI 감사는 [감사 보고서](graph-branch-preparation-evaluation-2026-10-20-audit.md)에 있다.

원복한 제품에서는 관련 회귀 검사 72개, TypeScript, production build, diff 검사를 다시
통과했다. 런타임 파일 124개의 현재 원본·기존 VSIX·설치본 해시도 모두 같았다.
유지한 VSIX SHA-256은 `6c166e56769c0c6c80a1b73166f3bb3446997d235e35168793e6f7e395a22c4e`,
런타임 bundle SHA-256은 `6dac264f51e037cca7b28d2796fd196a1cbde1cd4bd461f71eea8c707906e601`다.

재현은 `scripts/benchmark-git-operations.mjs`를 사용한다. 공통 환경은
`GSC_BENCH_BRANCHES=300 GSC_BENCH_MONITOR_POLICY=1 GSC_BENCH_LIVE_RENDERER=1`이다.
반복은 `GSC_BENCH_OPERATIONS=checkout,checkout,checkout,checkout,checkout`를 지정하며,
화면 안 tip 경로는 `GSC_BENCH_CHECKOUT_LOADED_TARGET=1`을 더한다. 기준에는
`GSC_BENCH_SOURCE_REF=f865d9d8cf6ea5c1ea1c8403f73fff4afd7389ef`를 사용한다.
행렬은 `GSC_BENCH_OPERATIONS=push,fetch-new-history,pull,fetch,rebase,merge,merge-no-ff,pr-squash-cherry-pick,pr-cherry-pick,cherry-pick,checkout`다.
