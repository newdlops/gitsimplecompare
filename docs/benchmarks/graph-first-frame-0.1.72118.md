# 0.1.72118 Graph 첫 표시와 브랜치 상세 분리

Graph의 첫 이력이 이미 준비되어도 브랜치 상세를 기다리는 의존성을 제거했다.
기존 Native log의 symbolic HEAD와 새 fingerprint의 전체 ref/OID가 일치할 때만
그 페이지를 조기 게시하고, ahead/behind/upstream은 실제 상세가 도착한 뒤 표시한다.
추가 Git log, 별도 선행 조회, 새 타이머나 세대를 넘는 데이터 캐시는 만들지 않는다.

## 측정 조건

- 비교 기준: `c58405e002809fe3768289e6430326f6c8e99c9e` (0.1.72117).
- 파일 1,000개, 기본 이력 1,000개, 브랜치 300개, 공통 upstream 8개.
- 각 표본은 새 임시 Git 저장소와 로컬 bare remote를 사용한다. 사용자 저장소와 OS 창 포커스는 변경하지 않았다.
- 같은 계측 코드를 이전 commit의 source와 작업 트리 source에 연결했다.
  실행 순서는 before1 → after1 → after2 → before2 → before3 → after3이다.
- 실제 production HTML/CSP/JS를 headless Chromium에서 실행했다. 지연을 인위적으로 넣지 않았다.
- 아래 시간은 조회 시작부터 첫 Graph frame 및 최종 local-only frame까지다.
  전경 VS Code Extension Host의 사용자 체감 시간을 직접 잰 결과는 아니다.

## 최초 Graph 표시: 각 3회 중앙값

| 관측 항목 | 이전 | 후보 |
|---|---:|---:|
| 첫 이력 frame | 2,339 ms | 2,046 ms |
| 최종 표시 frame | 4,495 ms | 3,211 ms |
| Node CPU | 375 ms | 428 ms |

이 표본에서 첫 frame은 약 12.5%, 최종 frame은 약 28.6% 짧았다.
Node CPU는 약 14.1% 늘었다. 시간 편차가 크고 표본이 작으므로 전체 작업의 속도 향상이나
CPU 절감을 주장하지 않는다. 후보의 3회 중 2회에서 실제 frame이 Native 브랜치 상세 읽기의
완료보다 먼저 도착했다. 상세가 먼저 준비되면 기존 게시 경로를 사용한다.

전체 프로세스 수에는 비동기 원격 태그 조회도 포함된다. idle 관측 경계에 따라 완료 시점이
달랐으므로 총 프로세스 수 감소를 성과로 주장하지 않는다. 첫 페이지 log는 한 번이며,
취소·HEAD가 페이지 밖인 경우·검증 불가 시에도 기존 페이지의 재사용 또는 기존 fallback을 따른다.

## 적용하지 않은 경로

기존 local-only 표시를 지우고 모든 ref 갱신을 조기 게시한 시안도 측정했다.
실제로 다른 OID로 이동하는 loaded-page checkout 3회 중앙값은 다음과 같았다.

| 시안 관측 항목 | 이전 | 무조건 조기 게시 |
|---|---:|---:|
| 첫 frame | 1,554 ms | 1,103 ms |
| 최종 frame | 1,554 ms | 3,178 ms |
| Node CPU | 215 ms | 282 ms |

첫 표시와 함께 최종 갱신·CPU 비용을 보아야 한다. 이 시안은 채택하지 않았다.
최종 코드는 ref 갱신 전체를 기존 경로로 유지한다. 표시가 비어 있는 경우에도 완료된
빈 marker 캐시를 무효화할 필요가 없도록, 조기 게시를 새 첫 페이지에만 적용했다.
guarded checkout과 전체 작업 측정은 기존 marker가 있는 행의 기존 경로를 확인한 결과이며,
최초 표시 측정은 이 ref 갱신 분기와 독립적이다.
같은 OID로 checkout한 초기 탐색 표본도 별도로 보존했으며, 실제 HEAD 이동 표본과 합치지 않았다.

## 정확성·기능 확인

- 최종 관련 순수/Panel Node 검사 71개 통과.
- 실제 Native Git의 첫 페이지 채택·containment와 손상 ref fallback 검사 2개 통과.
- headless 화면 검사 9개 통과, DOM 포커스·툴팁 수정 뒤 해당 4개 재확인.
- 실제 Native 작업 후 production renderer의 HEAD·현재 브랜치 chip·부모·ref·local-only를 대조한다.
  최초 표시와 최종 표시의 정확한 frame ACK를 각각 확인한다.
- UI는 390×844, 768×1024, 1440×900에서 loading → ready, paused/error,
  커밋 선택, Escape, 선택 유지 및 스크롤 위치를 확인했다.
- 타입 검사와 최종 산출물/설치 파일 검증은 별도로 수행한다.

표시할 수치가 없을 때 0이나 upstream 없음으로 바꾸지 않는다. 원격 버튼은 실제 상세가
준비될 때까지 비활성이며, title/data-tooltip/접근성 라벨에 같은 이유를 제공한다.
동일 OID의 다른 checkout, 이동·삭제·추가 ref, 취소된 세대와 다른 저장소의 결과는
현재 상세를 덮어쓰지 않는다. ref 이름이 모호하거나 log에 HEAD가 없으면 조기 게시를 하지 않는다.

## UI 검토

`ui-design-workflow`로 기존 DESIGN.md/PRODUCT.md, VS Code theme token/Codicon과
밀도·가로 스크롤 규칙을 유지했다. Impeccable audit/polish 및
[Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)를
변경 경로에 적용했다. 지원되는 detector 실행은 성공했으며, 자동 결과와 실제 화면 확인을 별도로 다뤘다.

| 검토 항목 | 범위 내 평가 | 근거/한계 |
|---|---:|---|
| 접근성 | 3/4 | 실제 chip 포커스, 상태 안내, disabled 라벨 확인. 스크린리더 세션은 미실행 |
| 성능 | 3/4 | 첫 표시 선행과 중복 log 없음 확인. CPU 절감은 미확보 |
| 반응형 | 3/4 | 세 크기와 overflow 확인. 물리 터치 장치는 미검증 |
| 테마 | 4/4 | 기존 token/icon/레이아웃 유지, 새 색상 체계 없음 |
| 구현 일관성 | 4/4 | 실제 ref만 조기 게시, 상세 불명 상태 및 복구 경로 유지 |

변경 경로에서 확인한 주요 항목은 상세 갱신 때 chip 포커스가 사라지는 문제,
비활성 원격 버튼의 기존 툴팁, unknown upstream의 local-only 오분류, 동일 필터 옵션의
메뉴 재생성이었다. 이 항목들은 수정했다. 좁은 Graph의 의도된 내부 가로 스크롤과
VS Code의 조밀한 컨트롤 크기를 일반 모바일 웹 규칙으로 재설계하지 않았다.

## 재현 및 남은 한계

기존 `scripts/benchmark-git-operations.mjs`에
`GSC_BENCH_OPERATIONS=initial`, `GSC_BENCH_BRANCHES=300`,
`GSC_BENCH_SHARED_UPSTREAM_BRANCHES=8`, `GSC_BENCH_MONITOR_POLICY=1`,
`GSC_BENCH_LIVE_RENDERER=1`을 지정한다. 이전 source에는
`GSC_BENCH_SOURCE_REF=c58405e`를 추가한다. Native 검사는 한 worker로 실행했다.

원본 표본과 source provenance는 [JSON](graph-first-frame-0.1.72118.json)에 있다.
CPU 사용량, 선택 메뉴의 숨겨진 DOM 준비 비용 및 실제 사용자 창의 체감 검증은 후속 과제다.
push/pull/fetch/rebase/merge/PR/cherry-pick/checkout 전체의 속도·자원 목표가 완료되었다고 판단하지 않는다.
사용자 창 활성화, 강제 reload, Marketplace 상태 조회는 하지 않았다.
