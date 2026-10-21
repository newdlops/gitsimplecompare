# 현재 조회 안의 source index 해석 재사용 — 0.1.72149

기준은 `cbebdf42e84bb16e8361a537cc343320c8c48485`(0.1.72148)다.
전체 Git 작업·Graph 최신화·안정성·자원 최적화 목표의 진행 결과다.
이번 변경이나 일부 CPU 표본만으로 전체 목표가 완료됐다고 판단하지 않는다.

## 확인한 비용과 변경

실제 PR 버튼 뒤 Graph working-tree 상태 준비를 조사했다.
기존 경로는 큰 source index의 형태, stage 차이, 최종 stat 복원에 같은 사본을 여러 번 해석했다.
두 실제 버튼의 Node CPU 프로파일에서도 parseIndex가 관찰됐다.
프로파일은 fixture·transport를 포함한 진단이며 특정 클릭의 벽시계 지연이나 GC 원인을
입증하는 자료로 사용하지 않는다. raw profile과 함수별 합계를 JSON에 보관했다.

`StatusIndexSource`는 한 번 읽은 source Buffer의 stage·형태·stat 위치를 현재 준비 동안만 보관한다.
전역이나 다음 상태 조회로 해석 결과를 넘기지 않는다. 동일 Buffer인지 확인하고,
재사용 때 전체 checksum 검증과 최초 checksum 대조를 모두 실행한다.
await 사이 Buffer가 변경되면 유효한 checksum을 새로 써도 재사용하지 않는다.
새 Native private index 결과는 독립적으로 파싱하고 stage 의미가 맞을 때만 stat을 복원한다.

offset은 entry 수에 맞춘 Uint32Array로 보관하고, v2/v3 연속 경로는 원본 범위를 해시한다.
padding은 모든 바이트를 검사하면서 불필요한 view·콜백을 생략한다.
반복 계획은 새 entry iterator를 사용한다. source·private Buffer를 직접 변경하지 않으며
기존 32MiB 형식 상한, 128개 변경/256KiB Native 입력 상한과 fallback을 유지한다.
Output의 `private status index transitioned`에 sourceInspectionReused를 기록한다.

실제 파일의 전후 stat·내용 hash·저장소 metadata fence, racy-clean mtime,
Native status, 취소·timeout·owned index 검증은 그대로다.
이 경로는 기존 Graph/Changes 표시용 private index 준비다.
이전에 폐기한 borrowed UNTR의 fresh 안전 검사 재사용을 도입하지 않았다.

## 검사

최종 관련 Node **95건**, 타입 검사와 diff 검사가 통과했다. skip은 0건이다.
Native SHA-1/SHA-256과 index v2/v3/v4에서 stat·encoding·stage 의미를 대조했다.
긴 경로의 0xfff 길이 포화, raw 비 UTF-8·탭·개행 이름, 유효한 checksum을 가진 잘못된 padding,
다른 source Buffer, checksum을 다시 쓴 변경, Native 실행 중 source 변경과 반복 계획을 검사했다.
외부 index·metadata 교체, 동시 stage, 같은 크기/racy 수정, ignored/untracked·rename,
split/sparse/skip-worktree fallback과 실제 자식 취소·시간 제한도 통과했다.
Graph 초기 상태·PR 행 이동·fresh boolean 안전 검사를 함께 실행했다.

```text
GSC_NODE_TEST_CONCURRENCY=1 node scripts/run-node-tests.mjs \
  test/statusIndexStagingIdentity.test.ts test/statusIndexTransition.test.ts \
  test/privateStatusIndexPath.test.ts test/privateStatusIndexWarmSessions.test.ts \
  test/privateStatusIndexColdScan.test.ts test/workingTreeSnapshot.test.ts \
  test/statusIndexWarmCache.test.ts test/workingTreeChangeFlag.test.ts \
  test/graphInitialLoading.test.ts test/pullRequestGraphJump.test.ts
npm run check-types
```

프런트엔드 소스·레이아웃·문구·VS Code 토큰은 변경하지 않았다.
실제 PR 작업 뒤 production HTML/CSP/JS를 390×844, 768×1024, 1440×900에서 촬영하고
기존 commit 선택·Graph 상태와 화면을 확인했다. 390px 촬영에는 포인터의 실제 PR hover 안내도
포함됐다. OS 창 포커스는 변경하지 않았다.
eslint는 프로젝트 의존성에 없는 기존 상태라 검사에 포함하지 않았다.

## 실제 상태 갱신 비교

읽기 전용 Captain snapshot(30,311파일·72,720commit·164branch)을 별도 소유 fixture에 재현했다.
같은 public PrivateStatusIndex.read를 **B/A/A/B** 순서로 비교했다.
각 source는 fixture 2개이며 각 fixture 안의 연속적인 단일 경로 stage 추가 5회를 측정했다.
총 **20개** 상태의 staged/unstaged 전체 그룹과 원본 index의 바이트·ino·mtime·ctime이
독립 Native status와 일치했다. Git은 매회 update-index와 status 두 번으로 같다.
이 10개/source는 독립된 cold 저장소 10개의 표본이 아니다.

| 실제 상태 조회 중앙값(ms) | 이전 | 수정 |
| --- | ---: | ---: |
| 조회 완료 | 228.94 | 207.208 |
| Node CPU | 150.874 | 122.184 |

모든 raw 표본과 각 실행의 결과를 보존했다. 최초 할당 축소만 적용한 탐색에서는
181.235→195.159ms로 느려졌고 Node CPU 126.001→123.807ms로 차이가 작았다.
그 탐색과 최초 source inspection 실행은 최종 고정 소스 비교에 섞지 않았다.

## 실제 버튼과 최종 Graph

PR 80개가 실제 DOM에 표시됐는지 측정 전에 확인한 뒤 production 버튼 → 등록 callback →
Native Git → 최종 Graph를 연결했다. 첫 PR은 실제 3commit 작업 대상이며,
추가 metadata는 fixture의 실제 Native branch/OID를 사용한다.
GitHub 응답과 VS Code transport/window/picker만 대체했다.
source hash를 매 실행 전후 확인했으며 비교 중 다른 빌드나 테스트는 실행하지 않았다.

비계측 B/A/A/B의 **8건**과 별도 CPU B/A/A/B의 **8건**이 모두 Native/DOM과 일치했다.
각 source/작업/mode의 표본은 **2개**다. 개선 폭의 인과나 실제 GitHub 네트워크 시간,
모든 작업의 지연 감소를 이 소수 표본으로 일반화하지 않는다.

| 비계측 중앙값(ms) | 이전 | 수정 |
| --- | ---: | ---: |
| PR squash handler | 555.0 | 487.0 |
| PR squash 최종 frame | 984.5 | 869.0 |
| PR replay handler | 1534.0 | 1358.0 |
| PR replay 최종 frame | 2004.5 | 1771.0 |

| 별도 계측 CPU 중앙값(ms) | 이전 | 수정 |
| --- | ---: | ---: |
| PR squash Node/Playwright | 468.77 | 289.857 |
| PR squash 종료·wait된 Native 자식 | 1048.049 | 930.956 |
| PR squash Chromium | 406.077 | 302.728 |
| PR squash 합계 | 1922.896 | 1523.541 |
| PR replay Node/Playwright | 340.317 | 347.299 |
| PR replay 종료·wait된 Native 자식 | 3021.517 | 2990.788 |
| PR replay Chromium | 504.48 | 396.582 |
| PR replay 합계 | 3866.314 | 3734.669 |

PR replay의 Node CPU는 소폭 증가했다. 이 반대 결과도 그대로 보존한다.
각 구성요소 중앙값의 합은 합계의 중앙값과 다를 수 있다.
CPU 구간은 클릭 직전부터 최종 paint ACK와 settle까지이며,
fixture 준비·probe 빌드·Native 사후 oracle·screenshot은 제외한다.
Node에는 Playwright transport가 포함된다. 종료·wait된 Native 자식과
완전하고 안정된 PID의 Chromium delta를 각각 집계했다.
Chrome root는 counter 뒤 종료해 waited 자식과 중복 합산하지 않는다.
계측 실행 시간을 비계측 지연 근거로 섞지 않으며 전체 VS Code CPU의 절대값도 아니다.

최종 후보의 별도 **18개 Git 변형**도 Native HEAD·부모·refs·remote tag·local-only와
production 최종 DOM에 일치했다. initial, 일반/tracked push, pull/fetch의 신규·알려진·무변경
이력, rebase, squash/no-ff merge, PR squash/replay, cherry-pick, loaded/unloaded checkout이다.
이 matrix는 후보만 검사해 전후 속도·CPU 이득의 근거로 사용하지 않는다.
별도 CPU/FS 진단의 실제 PR 버튼 2건까지 포함하면 Native/DOM **36건**, 후보 **28건**이다.

## 한계와 보존

현재 조회 안의 해석 수와 배열 저장은 줄였지만, Node after-await heap/RSS는 retained heap·
전체 프로세스 메모리·peak 감소의 증거가 아니다. 원시 메모리 값은 로그에 남기고
전체 자원 최소화 완료의 근거로 사용하지 않는다. source 정렬·checksum 검사와
Native 조회 비용, 전체 Git 작업 지연의 남은 범위는 계속 평가한다.

실제 Captain 저장소, 사용자 stash·snapshot·보존 PR worktree는 변경하지 않았다.
계측 코드는 설치 확장에 포함하지 않는다. foreground Host, OS 포커스 전환,
강제 reload와 별도 Marketplace 상태 점검은 하지 않았다.
소스·원시 결과·화면·검사 로그 hash와 개별 표본은 같은 이름의 JSON에 보관한다.
