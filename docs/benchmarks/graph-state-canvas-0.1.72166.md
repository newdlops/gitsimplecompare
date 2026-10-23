# Graph 상태 알림의 기하 보존 — 0.1.72166

변경 없는 `graphDelta`가 이미 측정한 canvas 폭을 `100%`로 초기화하던 문제를
수정한다. 긴 제목이 있는 실제 Graph에서 오른쪽 끝의 24px 여백이 사라지면서
가로 스크롤이 24px 이동했다. 390×844, 768×1024, 1440×900 모두 기준 소스에서
같은 assertion 실패를 재현했다.

빈 delta의 revision·색상 scope·행/간선·lane 검증은 기존 `graphDataUpdates.js`가
담당한다. 해당 경로에서 viewport 폭과 canvas 높이가 그대로인 경우에만 측정한
폭을 보존한다. tail 높이나 inspector/viewport 폭이 달라지면 기존 크기 계산과
행 내용 폭 측정을 수행한다. DOM 쓰기 전에 viewport를 읽어 불필요한 동기 layout을
피한다. loading·오류·최종 상태·revision·두 frame ACK와 자동 pagination은 유지한다.
새 cache 수명·worker·timer·감시자·Git 호출은 추가하지 않는다.

## 독립 renderer 비교

기준은 `027ae26798360ac4afebd771d38b81db9fdec1f6`의 `media/graph/graph.js`다.
나머지 Graph JS/CSS와 fixture는 공통으로 두고 해당 파일만 교체했다. 5,000행,
4,999간선, 1,000브랜치, 250태그를 실제 headless Chromium에서 렌더한다.
독립 browser/page를 B/A/A/B + A/B/B/A 순서로 실행해 source별 4개 수명을 비교한다.
각 수명은 8개 warmup 뒤 시간 32개, 별도 CPU 48개, 별도 GC 후 heap 48개 알림을
처리한다. 같은 page의 반복 알림을 독립 표본으로 계산하지 않는다.

| 수명별 중앙값의 중앙값 | 기준 | 수정 |
| --- | ---: | ---: |
| 동기 handler ms | 0.5 | 0.6 |
| 두 frame 표시 ms | 16.7 | 16.7 |
| 별도 Chromium CPU ms | 283.948 | 261.851 |
| 별도 Node/Playwright CPU ms | 1.380 | 0.747 |
| 별도 GC 후 JS heap bytes | 10,291,448 | 10,289,808 |
| GC 후 JS heap 증가 bytes | 0 | 0 |

Chromium CPU는 이 범위에서 약 7.8% 줄었다. handler는 0.1ms 늘었고 표시 시간은
같으므로 클릭 지연이나 모든 작업의 속도가 개선됐다는 근거로 사용하지 않는다.
안정된 모든 Chromium PID의 누적 counter를 확인했고 Native Git/fixture 준비는
이 비교에 포함하지 않는다. JS heap은 RSS·물리 메모리·실제 최대값의 대용이 아니다.
원시 표본은 [JSON](graph-state-canvas-0.1.72166.json)에 보존한다.

```text
node scripts/benchmark-graph-state-renderer.mjs /private/tmp/gsc-state-renderer-paired.json
node_modules/.bin/playwright test test/webview/graphStateOnly.spec.ts test/webview/graphWidthUpdates.spec.ts --workers=1
```

최종 관련 브라우저 검사 75건과 Node 검사 92건이 통과했다. 상태/너비 spec 19건은
세 크기의 동일 row/SVG·선택·focus·스크롤,
후속 metadata 변경, 오류·로딩·완료·revision 오류와 resync, 빈 화면·lane/scope/reset,
80개 PR 입력 DOM, 자동 load-more, in-place 행/annotation 변경에 따른 폭 갱신을
포함한다. tail 높이와 viewport 폭이 바뀌었을 때 측정 폭이 다시 확보되는 검사도
통과했다. 다른 spec은 초기 로드·checkout·incremental 갱신·PR 행 이동/재시도를
확인한다. Node 검사는 Native oracle 독립성, fsmonitor의 읽기/쓰기 경계와 PR
행 이동을 포함한다. 새 promisor 검사 2건은 준비 실패 전에 implicit fetch가
시작되지 않고, 준비 성공 뒤 필요한 원격 commit을 받아 정상 rebase하는지 확인한다.
기존 VS Code 토큰과 화면 구성을 유지하며 OS 포커스나 사용자 VS Code reload는
요청하지 않는다. 별도 Marketplace 상태 조회도 하지 않는다.
