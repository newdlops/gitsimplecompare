# PR 알림과 Git 완료 수명 분리 — 0.1.72137

PR 작업이 끝나도 완료 알림의 응답을 기다려 버튼과 Graph 갱신이 멈추던 문제를 수정했다. 늦은 Undo는 원래 snapshot과 before/after HEAD에 고정하며, 선택 순간과 확인창 이후의 Native 검증을 유지한다. 자동 선행 진단은 Git 완료 후 시작하고 저장소 전환/새 진단 요청에서 취소한다.

## 측정 조건과 범위

이전 commit은 `b38021fd0383c3be881f81249f67c9f2091ee770`이다. 같은 production HTML/CSP/JS, 등록 callback, 실제 Native Git과 로컬 bare remote로 B/A/A/B/B/A 순서의 세 표본씩을 얻었다. PR squash와 커밋 보존 replay 각각 3개 원본 커밋, 파일 1,000개, main 이력 1,000개, side branch 100개를 사용했다. GitHub PR 목록과 VS Code 알림/transport는 대역이다.

알림 응답을 **동일하게 2,000ms 보류**했다. [VS Code 알림 API](https://code.visualstudio.com/api/references/vscode-api#window.showInformationMessage)의 응답 수명을 재현한 값이며 실제 사용자의 알림 클릭 시간이나 Native Git 속도 향상으로 해석하지 않는다. Git 서비스 완료 시점을 별도로 관찰했다.

## 중앙값 (ms)

| 작업 | Git 완료 → handler/busy 해제 | Git 완료 → 최종 Graph frame | 클릭 → 최종 Graph frame |
| --- | ---: | ---: | ---: |
| PR squash | 2005 → 4 | 2234 → 299 | 2573 → 1586 |
| PR replay | 2006 → 2 | 2198 → 165 | 2585 → 387 |

이전 버전은 모든 사례에서 알림 응답 뒤에 끝났고 수정 버전은 모든 사례에서 미응답 상태로 완료됐다. 클릭 측정 구간의 host Git 호출 수는 Graph 후속 조회를 포함해 squash 30회, replay 31회로 유지됐다. 수정 버전 squash의 첫 클릭→최종 frame은 **5,021ms**로 이전 표본들보다 느렸다. 이 값과 모든 CPU/시간 표본을 [JSON 보고서](pr-action-notices-0.1.72137.json)에 보존했다.

## 검증

- 서로 다른 Node 테스트 82개 통과: 알림/취소/동시 실행/오래된 Undo 25개와 Native PR/복구/보존 57개. 최초 경고 기록용 mock 오류 1건과 수정 후 6개 Undo 테스트 재검증 로그도 보존했다.
- PR 실제 버튼 12개 사례에서 Native tree·부모·커밋 수, HEAD/ref/local-only와 마지막 renderer ACK 일치. push/pull/fetch/interactive rebase 버튼 4개도 일치.
- 390/768/1440px에서 진행·완료 화면 6장을 직접 확인했다. 키보드 실행/포커스, 중복 클릭 차단, aria-busy, tooltip, reduced motion과 문서 overflow를 검사했다. production renderer 자산을 쓰는 최소 DOM fixture이며, 네이티브 VS Code 배너 자체는 화면 검사하지 않았다.
- Impeccable detector 1회, 결과 0개. 디자인 검사는 타입/기능 검증과 별도로 수행했다. 기존 VS Code 토큰/컨트롤 외형은 유지했다.

## 한계

이번 개선은 알림이 Git 완료 상태를 붙잡는 대기를 제거한다. GitHub 응답이나 Native Git 연산 자체의 속도 향상을 증명하지 않는다. Node CPU는 squash 중앙값이 증가했으며 Git/Chromium/OS 전체 CPU·RSS는 측정하지 않았다. 전체 최적화 목표는 진행 중이다. 실제 Captain, stash, 복구 snapshot/worktree는 건드리지 않았다. foreground host, OS 포커스 변경, 강제 reload, Marketplace 상태 점검은 수행하지 않았다.
