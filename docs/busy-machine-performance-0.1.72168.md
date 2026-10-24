# 바쁜 머신의 Git 탐색 폭증과 Graph 대기 축소 — 0.1.72168

같은 작업트리의 서로 다른 폴더를 탐색할 때 폴더마다 Native Git을 실행하던 비용을
줄인다. Graph renderer·사용자 설정·Git 쓰기·안전 검사·조회 timeout은 바꾸지 않는다.
검증 기준은 설치된 `0.1.72167`, `b8b453b508d07cbe1fb20bf8dc340bc675d804f4`다.

## 실제 관찰과 변경

기존 0.1.72167 활성화 로그에서 서로 다른 cwd의 느린 `rev-parse` 34건을 찾았다.
보고된 실행 창 34개가 겹쳤고 각각 1,030~4,107ms였다. 동기 spawn은 최대 6ms다.
현재 filesystem의 가장 가까운 작업트리 후보도 34개 경로에서 하나로 같았다.
이는 reported begin-to-close 창의 겹침이며 OS process-table peak나 모든 실행이
정확히 같은 Git argv였다는 증거는 아니다. 경로·branch·내용 없이
[관찰 기록](benchmarks/busy-startup-observation-0.1.72168.json)을 남겼다.

`RepositoryDiscoveryAnchors`는 physical cwd에서 가장 가까운 `.git` 후보를 찾는다.
실제 root/branch는 기존 Native Git으로 검증한다. 같은 후보의 진행 중 읽기를
공유하고, 완료 뒤 각 alias의 경계를 다시 확인한다. Native가 직접 확인한 root만
기존 5초 root cache에서 재사용하며 branch의 완료값은 시간 기반으로 캐시하지 않는다.
최신 branch는 계속 Native로 읽는다. clone/init 무효화가 이전 결과의 cache 적용과
새 세대의 pending 해제를 막는다.

파일시스템 확인은 진행 중 항목만 공유하고 완료 뒤 해제한다. 상위 탐색은 64단계,
공유 pending map은 512항목으로 제한한다. nested repo·linked worktree·symlink·bare
경계를 구분하며, custom Git executable·명시적 discovery 환경·상대 config·불확실한
filesystem은 기존 Native 경로를 사용한다. 설정 조회 실패도 기존 결과 계약을 유지한다.
`Git Simple Compare` Output에는 공유한 그룹을 한 번 기록한다. 새 상시 worker·
감시자·polling·시간 제한 증가는 없다.

## 최종 Native 비교

소유 저장소의 서로 다른 34개 폴더를 동시에 요청했다. root-only와 root/branch 혼합
요청을 각각 두 round 실행하고, source별 독립 Node 두 개를 B/A/A/B 순서로 비교한다.
latency·Node+waited-Native CPU·별도 합산 RSS mode는 분리한다. 총 12개 Node 수명의
48개 burst에서 Native identity와 HEAD/index/config/refs 보호 검사가 모두 통과했다.
warmup·fixture·probe build·독립 Native oracle은 측정 구간 밖이다.

각 Node 내 두 round 중앙값을 먼저 구한 뒤 source별 두 Node의 중앙값을 비교한다.

| Native 탐색 지표 | 기준 | 수정 |
| --- | ---: | ---: |
| root-only 일반 시간 ms | 181.52 | 34.78 |
| 혼합 요청 일반 시간 ms | 201.28 | 30.31 |
| 두 유형의 Git 호출·최대 실행 슬롯 | 34 / 34 | 1 / 1 |
| root-only 별도 소유 CPU ms | 453.26 | 29.17 |
| 혼합 요청 별도 소유 CPU ms | 405.98 | 29.97 |
| root-only 최대 관측 합산 RSS MiB | 56.49 | 54.70 |
| 혼합 요청 최대 관측 합산 RSS MiB | 70.00 | 55.18 |

Native 탐색 CPU는 이 조건에서 약 93% 줄었다. CPU는 Node/observer와 OS가 wait한
Native 자식의 합계이며 시스템 전체 CPU가 아니다. RSS는 같은 시점의 소유 process
합산 표본으로, 공유 page 중복·짧은 child 누락 가능성이 있어 물리/실제 peak나
retained heap의 근거가 아니다. 원시 counter·표본·source fingerprint는
[JSON](benchmarks/busy-discovery-0.1.72168.json)에 있다.

처음 관찰한 순간의 머신 CPU는 약 88%, load average는 약 25였다. 최종 비교 중
기록된 1분 load는 4.33~8.98로 낮아졌다. 따라서 아래 일반 비교를 전부 같은 88%
CPU 부하에서 수행한 실험으로 해석하지 않는다. 재현 가능한 제한 조건은 따로 둔다.

## 실제 Graph와 동시 실행

1,000파일·1,800커밋·100 side branch·8 공통 upstream 입력에서 위 34개 폴더 탐색과
production HTML/CSP/JS의 첫 Graph 로드를 동시에 시작한다. 마지막 실제 renderer
frame 뒤 독립 Native 첫 페이지 oracle로 HEAD·부모·refs·remote tags·local-only를
확인한다. latency/CPU/RSS 각 B/A, A/B 순서로 총 12개 Native/DOM 사례가 통과했다.

| Graph 동시 시작 지표 | 기준 | 수정 |
| --- | ---: | ---: |
| 일반 첫 frame ms | 258.0 | 181.5 |
| 일반 마지막 메시지 frame ms | 305.0 | 215.5 |
| 일반 settle ms | 322.0 | 233.0 |
| Git 호출 / 최대 소유 슬롯 | 44 / 36 | 11 / 3 |
| 별도 소유 CPU 합계 ms | 1,066.74 | 659.25 |
| 별도 최대 관측 합산 RSS MiB | 544.31 | 541.64 |

첫 frame은 약 30%, CPU는 약 38% 줄었다. RSS 변화는 작다. source/mode당 독립
표본은 두 개이고 외부 부하를 통제하지 않았다. 모든 저장소·Git 액션의 개선율로
확대하지 않는다. [전체 counter와 Native/DOM 결과](benchmarks/busy-graph-startup-0.1.72168.json)를 보존한다.

## 혼잡 상황을 재현한 제한 검사

머신 전체를 포화시키지 않고 소유 benchmark Node에 read-start 준비 대기 75ms와
준비 slot 3개를 적용하고, headless Graph에 Chromium CPU throttling 6배를 적용했다.
이는 OS CPU/core 수나 살아 있는 Git process 수를 제한한 것이 아니다. Native Git과
argv·환경·결과는 그대로이며 실제 제품에 이 simulator를 추가하지 않는다.

같은 34-directory/Graph 입력의 B/A, A/B 네 사례가 모두 Native와 최종 DOM에 일치했다.
첫 frame 중앙값은 **1,578.5→787.5ms**, 마지막 frame은 **1,794.5→1,008.0ms**다.
최대 준비 대기열은 33→1, Git 호출은 44→11이다. 별도 CPU/RSS 개선 근거로 쓰지 않는다.
gate의 readStarts 47/14에는 측정 뒤 검증 조회 3건도 포함되며 제품 구간의 명령 수는
각각 44/11이다. 원문은 [제한 조건 기록](benchmarks/busy-graph-constrained-0.1.72168.json)에 있다.

첫 payload 자체의 renderer 처리 시간은 이 제한 조건에서 전후 약 273/272ms로
거의 같다. 이번 수정은 renderer 계산량을 줄였다는 결과가 아니라 불필요한 Git
탐색이 대기열을 늘리는 비용을 제거한 결과다. single Native 작업·GitHub 전송·
활성 VS Code 전체의 모든 지연을 제거했다는 주장도 하지 않는다.

## 검사와 배포

관련 Node 검사 64건이 실패·취소·skip 없이 통과했다. cold/sibling 공유, fresh branch,
nested/unborn·linked worktree·physical symlink·bare·ceiling·custom executable·상대 config,
늦은 경계 변경·clone/init generation, Output/설정 오류, 기존 blame·파일 장식과 Git
안전성을 포함한다. 타입 검사와 production package도 통과했다.

기존 80개 PR·stale local-change hint를 둔 실제 Git 컨트롤 11개도 통과했으며 결과는
[기능 기록](benchmarks/busy-functional-controls-0.1.72168.json)에 있다. 새 UI 컨트롤이나
스타일 변경은 없다. 사용자 창 focus 전환·강제 reload·별도 Marketplace 상태 조회는
하지 않는다. 검증한 같은 VSIX를 게시/설치하고 runtime 바이트를 대조한다.

최종 소스 650개 파일의 fingerprint가 세 정식 비교 모두에서 같음을 확인했다.
[QA 기록](benchmarks/verification-0.1.72168.json)과
[패키지 기록](benchmarks/release-artifact-0.1.72168.json)에 checksum을 남긴다.
136개 package 파일 중 126개 runtime을 소스와 대조했고 이전 설치 대비 변경은
`dist/extension.js` 한 개다. 테스트용 대기/CPU 제한 코드와 개발 파일은 포함하지 않는다.

제품 커밋 `320649a`를 origin/main에 푸시했고 검증한 같은 VSIX의 게시·설치가 성공했다.
설치 registry는 0.1.72168이며 126개 runtime이 패키지·소스와 같은 바이트다.
[배포 기록](benchmarks/deployment-0.1.72168.json)과
[범위별 감사](benchmarks/goal-audit-0.1.72168.json)에 최종 상태와 한계를 남겼다.
기존 활성 Host가 새 버전으로 다시 시작했는지는 확인하지 않는다. 현재 창에 적용되는
시점은 정상적인 다음 확장/창 reload이며 강제로 실행하지 않았다.
