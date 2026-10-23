# Graph 변경 요약의 경로 우선 확인 — 후보 제외

기준은 0.1.72163, `fcaba63fe4615121bf099c7b6632ba2ead278dfe`다.
요약 서비스만 빨라진 결과를 전체 Graph 개선으로 해석하지 않고 실제 버튼을
비교했다. 두 비교 모두 네 작업 중 세 작업의 최종 frame 중앙값이 증가했다.
이 후보는 제품에서 제외했고 버전업·추가 VSIX 게시·설치를 하지 않았다.
제품 소스·media·package/lock은 배포된 0.1.72163과 동일하다.

## 후보와 안전성 검사

Graph에 필요한 HEAD·변경 존재만 Native porcelain-v2로 읽을 때, 기존의 최근
경로 후보를 먼저 확인했다. 실제 변경이 확인된 경우만 true로 사용하고 miss는
전체 Native 조회로 전환했다. 원본 index·저장소 경계 검증을 유지하고 부분
결과로 전체 Changes나 warm metadata를 대체하지 않았다. 새 장기 cache,
timer, watcher는 만들지 않았다.

후보 상태에서 관련 Node 검사 50건과 macOS 기본 Git의 새 검사 8건이 통과했다.
최신 HEAD, 동시 index 교체, 부분→전체 전환, 원본 index 보존, cold-scan,
literal 경로, cache-off, timeout을 포함한다. 새 회귀 6건은 기준에서 실패했다.
첫 fixture의 750ms 제한은 status 실행 전에 만료돼 시험 제한만 5초로 고쳤다.
제품의 기본 30초 제한은 변경하지 않았다.

이는 제외한 후보의 검사 기록이다. 후보 전용 코드는 소유 tmp archive에 보존했다.
예정했던 추가 72건 기능 행렬은 후보 제외 결정 이후 실행하지 않았다.

## 실제 Captain의 읽기 전용 서비스 비교

30,311개 index 항목·Native 변경 항목 1개의 원본에서 비교했다. 원본 optional
locks는 0이며 전용 index만 tmp에 썼다. Local Git 설정을 유지하고 공통 runner가
system/global 설정을 격리했다. Command-scope fsmonitor=false로 원본 daemon
호출을 막았다. 원본 파일·index·config·ref에 쓰기를 하지 않았다.

앞뒤 Native 전체 status와 index/config/HEAD·모든 ref·변경 경로 fingerprint가
같았다. 이 fingerprint는 일반 파일 내용과 symlink 대상, 경로 metadata를
포함하며 디렉터리 내부를 재귀적으로 fingerprint하지는 않는다.

시간과 CPU는 별도 B/A/A/B 프로세스로 측정했다. Source·모드당 독립 프로세스는
2개이며 각 프로세스의 warm 반복 3회 중앙값을 먼저 구했다. 첫 전체 요약과
oracle은 구간 밖이다. UI·GitHub·실제 VS Code 창의 시간이나 메모리 측정은 아니다.

| 항목 | 기준 | 후보 | 변화 |
| --- | ---: | ---: | ---: |
| 요약 조회 ms | 365.6 | 139.6 | -61.8% |
| Node+wait된 Native 자식 CPU ms | 684.5 | 95.1 | -86.1% |

## 실제 Graph 버튼 비교

Production HTML/CSP/JS 버튼과 등록 callback, Native Git, 최종 DOM을 연결했다.
두 비교 각각 시간 16건·CPU 16건·별도 RSS 16건, 총 96건이다. 서로 다른 모드의
표본을 시간 표본으로 합산하지 않는다. 아래 각 중앙값은 source·모드당 독립
프로세스 2개의 값이다. 별도 pilot의 실제 버튼 8건도 기능 검사를 통과했지만
pilot 시간은 비교에 사용하지 않는다.

입력은 소유한 30,311파일·72,720커밋·164개 원래 로컬 브랜치, PR 카드 80개,
미추적 편집 하나다. 원본 object는 읽기 전용 alternate로 사용한다. 실행마다
root와 bare remote의 Git metadata 및 private object store 전체를 복원하고
ref/index/config/HEAD/Native 상태와 object inventory를 검증했다.

Captain의 post-checkout과 Husky 헬퍼를 읽어 소유 hook으로 복사했다. Native
인수와 cwd는 유지하며 pre-commit은 복사하지 않았다. 소유한 작은 로컬 문맥
파일로 worktree 연결을 검사했다. Hook 때문에 PR 재생은 전체 checkout을 쓴다.
이 후보는 그 비용을 줄이지 않는다. 네 작업의 hook 호출과 WIP 내용 보존,
Native 결과, 정확한 HEAD/ref/local-only 최종 화면이 모두 일치했다.

새 panel/browser는 작업마다 만들고 source 프로세스는 표본마다 분리했다.
초기 Graph/PR 조회는 클릭 전에 끝난다. OS 파일 cache는 따뜻하며 한 프로세스의
공통 불변 metadata cache는 앞 작업에서 남을 수 있다. GitHub 대신 소유 local
bare를 사용했다. 사용자 창의 포커스·강제 reload·Marketplace 점검은 하지 않았다.

첫 비교는 source별 네 작업을 연속 실행했다. Source 순서는 B/A/A/B다.
유리한 표본만 선택하거나 후속 결과와 합산하지 않는다.

| 작업 | 클릭→최종 frame ms, 기준→후보 | 소유 CPU ms, 기준→후보 |
| --- | ---: | ---: |
| Pull | 1,079.5 → 781.5 | 1,874.4 → 2,184.1 |
| Checkout | 721.0 → 881.0 | 1,628.1 → 1,341.0 |
| 커밋 유지 PR 재생 | 16,987.5 → 21,990.0 | 18,201.4 → 20,454.2 |
| 무변경 Fetch | 446.0 → 809.0 | 976.8 → 881.4 |

후속 비교는 두 source를 먼저 준비하고 작업별로 기준/후보를 바로 이어 실행했다.
첫 replicate는 B/A, 두 번째는 A/B로 미리 고정했다. 대기 source는 browser나
Native 작업 없이 fs.watch로 기다리며 active phase 자원 합계에서 제외했다.
첫 비교와 같은 입력 복원·시간/CPU/RSS 분리를 유지했다.
두 비교는 별도 소유 pool을 썼다. 입력의 바이트 동일성은 각 비교 안에서 검증했으며
서로 다른 비교 사이의 바이트 동일성을 주장하지 않는다.

| 작업 | 클릭→최종 frame ms, 기준→후보 | 소유 CPU ms, 기준→후보 |
| --- | ---: | ---: |
| Pull | 831.0 → 1,397.0 | 2,061.8 → 1,937.8 |
| Checkout | 836.0 → 869.0 | 1,658.0 → 1,346.0 |
| 커밋 유지 PR 재생 | 18,842.5 → 22,180.0 | 18,165.2 → 16,924.5 |
| 무변경 Fetch | 630.5 → 569.0 | 1,016.7 → 1,052.6 |

소유 CPU는 active Node·wait된 Native 자식·browser 합계이며 OS 전체 CPU가 아니다.
RSS는 별도 실행의 관측한 합계 최대값이다. 첫 비교의 최대 관측 간격은 781.7ms,
후속은 490.8ms로 실제 peak·physical memory·retained heap을 증명하지 않는다.
후속 Pull의 관측 RSS 중앙값은 672.3→749.2MiB로 증가했다. 원시 값과 실제 gap은
[결과 JSON](graph-summary-paths-evaluation.json)에 남겼다.

Native status는 빨라졌지만 fetch/worktree 등 다른 명령의 시간 변동이 컸다.
대표 계열의 화면 게시·Git 호출 증가로 지연을 설명할 수 없었으며 원인 분리는
끝나지 않았다. 이 변동을 근거로 불리한 표본을 버리거나 전체 개선을 주장하지 않는다.

## 보존과 현재 제품

원문은 `/private/tmp/gsc-goal64-buttons-summary.json`,
`/private/tmp/gsc-goal64-paired-buttons-summary.json`,
`/private/tmp/gsc-goal64-readonly-summary.json`이다. 각 비교의 모든 소유 프로세스는
종료됐고 입력 pool은 정리됐다. 실패·복구용 사용자 stash/worktree/snapshot은
정리 대상에 포함하지 않았다. 실험 소스와 원래 diff의 archive 위치·hash는
`/private/tmp/gsc-goal64-rejection-archive.json`에 있다.

반복 비교에 재사용할 버튼 benchmark의 작업별 gate, 기본 snapshot 정책·OUTPUT
연결, signed 마지막 source write→frame 관찰만 유지했다. Signed 값은 cleanup보다
앞선 frame일 수 있으며 전체 작업 시간으로 해석하지 않는다. 제품 런타임은
변경하지 않았다. [PR 행 이동 수정](../pr-row-jump-verification-0.1.72162.md)은
이미 게시·설치된 0.1.72163에 포함돼 있다.
