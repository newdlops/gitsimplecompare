# Graph local-only 데이터 적용 — 0.1.72142

기준은 `89ff822ee6a664a62aaa313c309778acb5a75b53`이다. Graph가 일부 커밋에 표시를 붙이기 위해 전체 local-only 결과를 복사하던 비용을 줄였다. 원래의 전체 Git 작업 지연·Graph 최신화·안정성·자원 목표는 계속 진행 중이다.

## 변경과 안전 경계

계산 함수가 새로 만든 결과 Map은 cache가 직접 소유한다. Graph 표시 서비스는 `getReadOnlyMap()`으로 검증된 결과를 조회하고, 표시할 commit의 배열만 별도로 복사한다. mutable 소비자의 기존 `getMap()`은 Map과 각 배열을 계속 복사하며, 중간 entry 배열 없이 한 번의 순회로 복사한다. 새 cache나 Native 조회는 없다.

동일 snapshot의 singleflight, 변경된 ref/history 검증, 무효화·취소, 오류 전파와 재시도 정책은 유지한다. cache Map을 UI에 직접 넘기지 않으며 표시 배열을 수정해도 cache는 바뀌지 않는다. 이전/현재 performance harness는 실제로 사용되는 mutable/readonly 읽기 경로를 선택해 기다리고, metadata 오류가 성공으로 숨지 않게 한다.

관련 Node **37개**와 타입 검사가 통과했다. 새 mutable/readonly 동시 소비, 배열·Map 격리, 실패 복구, 오래된 generation 취소와 표시 부분집합의 keyed lookup을 검사했다. 기존 Native upstream·shallow 변경, 같은 이력의 fetch/checkout 재검증과 DAG 읽기 0회, 그룹별 Native 범위·자식 취소/close도 통과했다. 같은 부분집합 검사는 이전 코드에서 전체 Map 순회 1회 때문에 실패했고, 수정 후에는 순회하지 않는다.

사용자가 보고한 PR 행 이동도 현재 소스에서 다시 검사했다. Native 후보 탐색·필터·로컬 object·취소 검사 **6개**, 390×844·768×1024·1440×900의 기존 production renderer 브라우저 검사 **9개**가 통과했다. 일반 키보드/버튼 입력으로 로드된 행과 미로드 행 이동, 로딩·한국어 실패·재시도, merge 결과 우선순위, 이전 응답 무시와 metadata 갱신 이후 강조를 확인했다. 성공 화면 세 크기도 직접 확인했다. 이 검사는 fixture transport를 사용하며 실행 중인 사용자의 VS Code 세션을 검증한 것은 아니다. 이전 릴리스의 화면 증거를 보존하고 새 캡처는 별도로 저장했다.

## 큰 Native 결과의 적용 비용

동일한 Native Git fixture에 local 이력 30,000개, 과거 이력 1,000개, branch 32개를 만들었다. 독립적인 Native 부모 DFS oracle과 전체 membership을 대조한다. 결과 30,033개 중 실제 표시 300개에 대해 `GitLogService.attachLocalOnlyBranches`를 호출했다.

이전/수정/수정/이전 순서이며 source당 warm 표본 10개다. 표본 하나는 cached 적용 10회다. fixture·oracle·사후 검증과 표본 전 GC는 시간/Node CPU 구간 밖이다. cold 계산도 source당 2개 보존했다. 모든 warm 적용은 추가 Git 조회 0회였다.

| cached 적용 10회 중앙값 | 이전 | 수정 |
| --- | ---: | ---: |
| 시간 | 66.276ms | 0.765ms |
| Node CPU | 125.250ms | 2.625ms |
| await 직후 힙 증가량 | 134,707,672bytes | 1,225,584bytes |
| await 직후 RSS 증가량 | 10,264,576bytes | 0bytes |

힙/RSS 수치는 await 이후 증가량이며 peak나 정확한 retained 메모리가 아니다. Node CPU는 해당 process의 V8/GC 작업을 포함하고 Git/Chromium/OS 전체 CPU를 뜻하지 않는다. 이 수치를 전체 Git 작업이나 최종 UI 지연의 개선율로 환산하지 않는다. 모든 원시 표본은 JSON 증거 경로에 보존했다.

## 전체 작업과 실제 버튼

초기 로드, push/tracked push, pull/fetch의 새·알려진 이력·무변경, rebase, merge/no-ff, PR squash·commit별 적용, cherry-pick, loaded/unloaded checkout의 **18개 시나리오를 전후 각각 실행**했다. 36개가 Native HEAD·refs·부모·local-only 및 production HTML/CSP/JS의 최종 DOM 비교를 통과했다. fixture는 1,000개 파일·1,000개 commit·100개 branch·공유 upstream 8개이며 monitor 정책을 활성화했다.

이 별도 한 쌍의 소유 Node/Git/Chromium 전체 CPU는 **36,083.229→43,214.676ms**로 증가했고, RSS 합계 관측 최대는 **695,648,256→638,451,712bytes**로 감소했다. fixture·사후 검증을 포함하고 archive/build·observer/ps는 제외한다. RSS는 50ms+ps 간격의 관측 합계라 공유 페이지 중복과 짧은 peak 누락이 가능하다. 전반적인 자원 절감이나 전체 작업 속도 개선은 입증하지 못했다. 느려진 전체 작업 결과도 보존했다.

30,311개 파일·72,720개 commit·164개 branch의 읽기 전용 원본 object를 빌린 소유 fixture에서도 실제 PR squash·commit별 적용 버튼과 등록된 확장 callback을 전후 각각 실행했다. 4개 모두 Native tree/parent/count, 깨끗한 작업트리와 최종 DOM이 정확했다. squash 최종 frame은 9,094→7,847ms, commit별 적용은 5,645→5,661ms로 혼재한다. source·mode당 1회이며 실제 GitHub·사용자 저장소 지연의 근거로 사용하지 않는다. 목록/transport/picker만 fixture로 대체했다.

UI 코드는 바꾸지 않았고 새로운 디자인 감사 완료를 주장하지 않는다. 기존 PR 이동 재검증에는 `ui-design-workflow`와 기존 디자인 지침을 적용했다. Marketplace 상태 조회, OS 포커스 변경, foreground Host와 강제 reload는 하지 않았다. 실제 Captain 및 stash·복구 ref·보존 worktree는 변경하지 않았다. 기존 lint는 eslint 미설치/미선언으로 실행 불가 상태다. 같은 이름의 JSON은 소스와 증거 SHA-256을 기록한다.
