# Graph 드래그와 렌더 자원 개선 — 0.1.72169

기준은 0.1.72168 (`5023e8ef36dd22a1256d60365b88b8bd241b2aa7`)이다.
이전 버전은 Graph를 만들거나 장식을 갱신할 때마다 새 행과 SVG 노드를 검색하고,
각 요소에 pointer listener와 `data-drag-bound` 속성을 등록했다. 5천 행에서는
행·노드 합계 약 1만 개의 등록 대상이 생겼다.

이제 Graph 컨테이너에 pointerdown을 한 번 위임한다. 기존 행과 새로 추가·교체된
행이 같은 경로를 사용한다. 행을 드래그할 때는 Native CSS selector로 SVG 노드를
찾아 전체 노드 배열과 dataset을 순회하지 않는다. ref·버튼·reflog 가상 행 제외,
pointer capture, 드래그 이벤트와 rebase preview transform 복구는 유지한다.
새 캐시·타이머·worker·백그라운드 Git 작업은 추가하지 않는다.

## 측정

실제 Graph DOM/JS/CSS에 300·1,200·5,000행과 브랜치 배지 100개를 렌더했다.
소스별 독립 Chromium 네 개를 B/A/A/B와 반대 순서로 실행했다. 지연·CPU·GC 후
JS heap은 서로 다른 구간에서 측정했다. 총 72사례다. 지연 구간의 테스트
renderer에만 CDP CPU 6배 지연을 적용했고 머신 전체 부하는 만들지 않았다.
아래 값은 독립 browser 수명의 중앙값이다.

| 행 수 | pointerdown → drag 시작, 이전 → 이후 | 전체 렌더 Chromium CPU, 이전 → 이후 | 렌더 후 JS heap 증가량, 이전 → 이후 |
| --- | --- | --- | --- |
| 300 | 2.55 → 3.00ms | 47.50 → 45.35ms | 505,268 → 466,008 bytes |
| 1,200 | 7.00 → 5.10ms | 111.36 → 108.79ms | 1,203,860 → 1,068,024 bytes |
| 5,000 | 35.10 → 7.45ms | 424.31 → 410.25ms | 3,876,632 → 3,314,364 bytes |

5천 행의 drag 시작 처리 시간은 약 79%, 렌더 후 JS heap 증가량은 약 14.5%
줄었다. CPU 감소는 약 3.3%다. 작은 페이지의 입력 차이는 0.45ms다.
입력 값은 실제 마우스 이벤트가 Graph에 도착한 뒤의 처리 시간이며 OS 입력
대기 전체가 아니다. JS heap 증가량도 Chromium 전체 RSS나 물리 최대 메모리가 아니다.

전체 첫 화면 시간은 일관된 개선으로 계산하지 않는다. 첫 1,200행 측정의 두 frame
완료는 971.95 → 1,183.30ms였고, 별도 교차 재측정 8사례에서는
675.45 → 592.10ms였다. 재측정의 1분 load average는 27.65–29.37이었다.
일반 화면 표시 시간의 편차와 별개로, 이번 변경의 성과는 반복 등록 제거와
입력 처리·CPU·heap 감소에 한정한다.

원문은 `benchmarks/graph-drag-renderer-0.1.72169.json`과
`benchmarks/graph-drag-followup-0.1.72169.json`에 있다. 두 기록의 개선 소스
해시는 패키지의 `media/graph/graphFeatures.js`와 대조했다.

## 기능과 시각 검증

- 웹뷰 검사 81개, Native Git·PR 검사 35개, 타입 검사와 production 패키징 통과.
- 실제 마우스로 행·노드 drag, pointer capture, transform 복구, 전체 갱신 뒤
  새 노드 drag를 확인했다. ref·행 버튼·우클릭·가상 행의 기존 동작도 검사했다.
- PR 행 이동, checkout 뒤 페이지 연속성, loading·실패·재시도, 키보드·검색·선택,
  가로 스크롤, 장식 갱신과 마지막 frame ACK를 기존 검사로 확인했다.
- production HTML/CSP/JS의 버튼 11종을 실제 클릭했다. push·pull·fetch·rebase·
  checkout·PR/branch squash·cherry-pick 결과가 Native Git과 일치한다. 각 사례의
  PR 카드 80개와 stale 경로 힌트가 있는 작업 파일 보존도 확인했다.
- 390×844, 768×1024, 1440×900의 실제 완료 화면을 직접 확인했다. 첫 촬영의
  drawer transition 중간 프레임은 안정된 화면으로 다시 촬영했다. 촬영 helper만
  유한 animation을 완료하며 제품의 animation이나 스타일은 바꾸지 않는다.

사용자의 VS Code 창 포커스를 바꾸거나 강제로 reload하지 않았다. 실제 GitHub
조회 지연이나 사용자의 활성 세션을 측정한 결과로 해석하지 않는다.

## 제외한 후보와 배포 범위

행의 offscreen CSS 처리, SVG 문자열 생성, 큰 행 HTML 일괄 생성도 실험했다.
최종 frame이 늦어지는 후보는 제외했다. HTML 일괄 생성의 72사례 원문은
`benchmarks/graph-row-batch-rejected-0.1.72169.json`에 보존했다.

배포 패키지의 runtime 파일은 126개이며 0.1.72168과 다른 파일은
`media/graph/graphFeatures.js` 하나다. Git 실행·안전 검사 bundle과 CSS는 이전
버전과 바이트가 같다. 제외한 renderer와 benchmark 코드는 VSIX에 포함하지 않는다.
패키지 해시는 `benchmarks/release-artifact-0.1.72169.json`에 기록한다.
