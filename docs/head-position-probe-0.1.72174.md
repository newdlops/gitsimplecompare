# 초기 HEAD 위치 선행 적용 — 채택하지 않은 진단 기록

## 판단

0.1.72174의 실제 읽기 전용 데이터로 CPU 프로파일을 수집했다. HEAD 자동 이동 함수가 DOM 생성 뒤 `offsetTop`을 읽는 위치를 후보로 찾았다. V8 표본은 idle·Native 작업을 포함한 wall time이며 전체 CPU나 layout만의 시간으로 해석하지 않는다.

전체 canvas 높이를 먼저 설정한 뒤 행 모델의 좌표로 HEAD 위치를 적용하는 시안을 만들었다. 실제 사용 창의 포커스·reload·저장소 쓰기는 실행하지 않았다. 시안은 배포하지 않았고 제품 소스·패키지·설치된 런타임 81개가 다시 일치함을 검증했다.

## 별도 비계측 비교

같은 Native 입력과 같은 Node harness, 버전별 독립 수명2개, renderer CPU6배 제한으로 B/A/A/B 순서의 pilot을 실행했다. 각 수명은 새 Node와 headless 문서이며 실제 VS Code 응답 수치가 아니다.

| baseline → 시안 수명 | 기존 렌더+frame(ms) | 시안 렌더+frame(ms) | 감소율 |
|---|---:|---:|---:|
| 0 → 1 | 4988 | 4118 | 17.4% |
| 3 → 2 | 1914 | 2075 | -8.4% |

렌더링 함수 안의 시간은 줄었지만 후속 frame이 늘었고, 전체 렌더+frame의 인접 두 쌍은 서로 반대 방향이었다. Native 읽기와 변경하지 않은 Node의 CPU도 변했다. 이 표본으로 전체 표시 지연이나 CPU 개선을 주장하지 않고 시안을 채택하지 않았다. 불리한 표본도 그대로 보존했다. 시안의 UI 기능·시각 QA를 통과한 것으로 간주하지 않는다.

전체 최초 frame은 Native/Node 대기를 포함하므로 렌더링 변경에 모두 귀속하지 않는다. 실제 창4개는 이번 확인에도0.1.72173을 실행 중이었으며, 0.1.72174의 실제 고부하 응답 검증은 남아 있다.

[원본 표본·시안 patch·판단](benchmarks/head-position-probe-0.1.72174.json), [진단 CPU profile](benchmarks/head-position-render-0.1.72174.cpuprofile).
