# 전체 작업과 Graph 최신성의 교차 검증 — 0.1.72166

기준은 `d8c1351eaf7843a8e2deabb2a848a533ec7c5488`(0.1.72128), 후보는
`027ae26798360ac4afebd771d38b81db9fdec1f6` 이후의 작업 트리다. 후보 제품 변경은
`media/graph/graph.js`의 상태 알림 기하 보존이다. 비교 시 버전 metadata는
0.1.72165였고 검증 후 0.1.72166으로 변경한다. 이 비교는 0.1.72128 이후의 누적
차이이며 이번 한 파일 수정의 효과로 모두 해석하지 않는다.

## 입력과 범위

소유한 합성 저장소의 1,000파일·1,800커밋·100개 side branch·8개 공통 upstream을
사용한다. 두 source의 별도 Node가 fixture 준비를 끝낸 뒤 각 작업을 B/A 순서,
두 번째 pair는 A/B 순서로 실행한다. 대기 source에는 브라우저나 주기적 polling이
없다. 각 source 내 18개 작업 순서는 같고, 다음 작업의 실제 상태는 독립 Native
oracle로 확인한다. commit 날짜는 고정하고 loaded/unloaded checkout의 branch+tree
fingerprint는 모든 실행에서 각각 하나로 같음을 확인했다.

일반 시간·CPU counter·RSS 표본은 별도 mode다. mode/source당 독립 Node 두 개,
총 12개 수명의 **216개** 작업을 완료했다. 마지막 작업도 source launcher가 실제로
close된 뒤 반대 source를 허용한다. 제품 649개 파일의 전체 SHA-256 fingerprint가
전후 같았다. source 준비·probe build·초기 Graph frame·사후 Native 검증은 측정
구간 밖이다. 사용자 Captain, stash, snapshot, 보존 PR worktree는 접근하지 않는다.

서비스와 production HTML/CSP/JS를 사용하며 Native 결과·HEAD·부모·참조·remote tag·
local-only 표시를 독립 Native 첫 페이지 oracle과 대조한다. 모든 사후 oracle은
측정한 마지막 실제 renderer frame 뒤에 시작한다. unavailable/paused status나
실패 toast를 성공으로 처리하지 않는다. `merge-no-ff`만 직접 Native CLI이고 나머지는
제품 서비스 경로다. 실제 UI 컨트롤 검증은 별도 기록이다. GitHub 네트워크나 활성
VS Code 창의 전송 시간을 측정한 것은 아니다.

## 집계

각 수명의 18개 값을 먼저 합친 뒤 source별 두 수명의 중앙값을 비교한다.
RSS는 각 수명의 같은 시점 합산 RSS 중 최대 관측 표본을 선택한 뒤 중앙값을 낸다.

| 항목 | 기준 | 후보 |
| --- | ---: | ---: |
| 일반 작업→settle 합계 ms | 4,172.0 | 4,088.0 |
| 일반 서비스 합계 ms | 1,905.0 | 1,876.5 |
| 마지막 메시지 frame 합계 ms | 1,959.0 | 1,909.5 |
| Git 호출 합계 | 255 | 236 |
| 최대 소유 Git 슬롯 | 4 | 3 |
| 별도 소유 CPU 합계 ms | 5,666.865 | 5,489.555 |
| Node/Playwright CPU 합계 ms | 1,034.036 | 1,056.053 |
| 종료·wait된 Native 자식 CPU 합계 ms | 2,648.033 | 2,560.900 |
| Chromium CPU 합계 ms | 1,984.797 | 1,872.603 |
| 별도 최대 관측 RSS MiB | 726.813 | 678.617 |

이 입력의 완료 시간 합계는 약 2.0%, 소유 CPU는 3.1%, 최대 관측 RSS는 6.6%
줄었다. Node CPU는 약 2.1% 늘었다. 외부 머신 부하를 통제하지 않은 두 수명
표본이며 모든 작업·모든 환경의 속도와 자원이 줄었다는 결론으로 확대하지 않는다.

## 작업별 중앙값

시간과 CPU는 ms, RSS는 MiB다. 개별 작업 중앙값의 합은 위 합계와 다를 수 있다.

| 작업 | 완료 시간 기준→후보 | CPU 기준→후보 | 관측 RSS 기준→후보 |
| --- | ---: | ---: | ---: |
| initial | 197.5→193.0 | 365.250→386.438 | 544.023→540.008 |
| push | 358.0→333.0 | 372.963→395.725 | 576.406→573.438 |
| push-tracked | 300.0→333.5 | 336.565→359.417 | 591.914→587.367 |
| pull | 278.5→283.0 | 373.158→348.169 | 615.781→613.203 |
| pull-new-history | 283.0→260.5 | 356.926→344.468 | 632.750→630.047 |
| pull-known-history | 187.0→208.0 | 248.477→234.803 | 642.141→643.352 |
| fetch | 187.5→166.5 | 228.277→222.331 | 642.211→647.516 |
| fetch-new-history | 225.0→241.5 | 331.600→317.656 | 654.992→663.438 |
| fetch-known-history | 166.0→145.5 | 225.256→206.011 | 653.531→660.125 |
| fetch-no-change | 160.5→132.0 | 192.730→180.074 | 659.102→661.047 |
| rebase | 354.0→341.5 | 411.006→414.245 | 675.531→671.555 |
| squash merge | 254.0→270.0 | 383.126→365.047 | 679.203→668.141 |
| Native no-ff merge | 178.5→188.0 | 287.543→306.309 | 688.664→669.195 |
| PR squash | 333.0→320.0 | 435.387→425.839 | 698.141→669.664 |
| PR replay | 316.0→300.5 | 431.585→409.490 | 709.555→671.852 |
| cherry-pick | 120.5→108.0 | 210.198→181.221 | 706.500→663.484 |
| loaded checkout | 109.5→109.0 | 180.951→152.571 | 711.570→663.023 |
| unloaded checkout | 163.5→154.5 | 295.868→239.739 | 724.563→675.977 |

tracked push, 알려진 이력 pull, 신규 fetch, merge의 더 느린 표본도 보존한다.
신규 이력은 정확히 한 Graph log 읽기, 표시된 checkout은 기존 페이지 재사용,
페이지 밖 checkout은 한 이력 읽기를 검증했다. 안전 검사나 최종 상태를 생략해
시간을 줄이는 변경은 포함하지 않는다.

## 자원 범위와 재현

CPU는 benchmark Node/Playwright, OS가 종료·wait한 Native 자식, 시작 PID가 모두
같은 type과 단조 counter로 남은 Chromium의 합계다. Node와 Chromium root의
수명을 분리해 자식 CPU를 중복 합산하지 않는다. CPU mode에는 RSS observer가 없다.

별도 메모리 72개 구간의 원문 393개 표본을 JSON에 함께 보존했다. 구간당 최소
4개이고 최대 실제 간격은 115.509ms다. 관찰자와 ps는 합산에서 제외한다. RSS는
같은 시점의 소유 프로세스 합이며 공유 page를 중복 계산하거나 짧은 자식/peak를
놓칠 수 있다. 실제/물리 peak와 retained heap의 증거가 아니다. memory mode의
시간/CPU는 진단 자료이며 일반 비교에 섞지 않는다.

```text
node scripts/benchmark-git-operations-paired.mjs docs/benchmarks/cumulative-operation-0.1.72166.json
```

[원시 결과와 표본](cumulative-operation-0.1.72166.json)은 source commit, fingerprint,
bundle/report hash, Native/DOM 검증, 모든 mode와 process counter를 포함한다.
최초 36개 기능 pilot은 Native/DOM이 일치했지만 마지막 frame 계측 옵션 누락을
coordinator가 발견해 시간 비교에서 제외했다. 해당 원인과 checksum은
[별도 pilot 기록](cumulative-operation-0.1.72166-pilot.json)에 보존한다.
