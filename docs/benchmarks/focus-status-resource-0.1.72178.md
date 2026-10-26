# 0.1.72178 표시 소비자 수명의 Native 비용 비교

## 범위와 방법

고정된 0.1.72177 source(`db9ed98`)와 0.1.72178 제품 source(`0111964`)를 비교했다.
두 비교점의 Native Git backend는 같고 변경된 source는 표시 수명에 관한 5개 파일이다.
현재 source·helper가 candidate와 같아야 재현기를 실행할 수 있다.

한 Node harness에서 main·linked 두 작업트리를 사용했다. 같은 공용 저장소를 쓰므로
서로 독립적인 머신/저장소 반복으로 취급하지 않는다. 각 작업트리에는 tracked 10,000개,
tracked directory 320개, untracked 2,000개/16 directory와 tracked 수정 1개가 있다.
core.fsmonitor는 false이고 hook은 실행할 hook 파일이 없는 소유 parent 경로를 가리킨다.
global/system Git 설정은 비활성이다.
측정 root는 전부 새로 만든 임시 저장소이며 사용자 저장소를 변경하지 않는다.

실제 `GitService`, 공유 snapshot, private index, Explorer provider와 Changes 상태
명령을 실행한다. 창 이벤트는 mock 객체에만 보낸다. 실제 VS Code 활성화 전체,
Native Explorer 렌더링, Graph DOM·frame이나 다른 확장의 소비자는 이 harness에 없다.
변경된 extension wiring은 release에 존재하는 pause API를 blur 때 호출하는 방식으로
모델링했다. 실제 데스크톱 입력·포커스 변경·강제 reload는 하지 않았다.

- 초기 private cache가 없는 경우와 동일한 persisted cache를 복제한 경우를 나눴다.
  cold는 OS 파일 cache가 비어 있다는 뜻이 아니다. 모든 warm sample의 cache 복원을 확인했다.
- 포커스 유지, 최초 Native status spawn 5ms 뒤 blur 후 200ms 복귀, 10ms 복귀를 비교했다.
  비활성화와 함께 status generation을 무효화했다. 64개 blur sample 모두 첫 status가
  Node child handle 기준 아직 실행 중인 상태였다. 실제 callback 시각도 원본에 보존했다.
- 조건마다 같은 round의 before/after를 연결하고 4회 순서를 교차했다. 총 96회/48쌍이다.
- Node CPU와 `getrusage(RUSAGE_CHILDREN)`의 종료·wait된 자식 CPU를 분리했다.
  소유 CPU는 둘의 합이며 Native 자식에는 Git뿐 아니라 소유권 검사 ps도 포함한다.
  scope는 표시 요청부터 awaited read disposal까지다. source 번들, fixture 준비,
  warm template, oracle 호출·비교와 fixture 삭제는 제외했다.
- 별도 Native 전체 status 호출을 기존 공통 parser로 해석해 최종 path/XY 목록과 비교했다.
  parser 독립 증명이나 HEAD/branch/line-stat 전체 검증은 아니다. 모든 결과 목록과 M 배지가
  일치했고 실제 index의 byte·inode·mtime·ctime 보존을 각 조건 뒤 확인했다.

호스트 CPU 부하를 따로 만들거나 고정하지 않았다. 실제 load average는 원본에 있지만
제어된 busy/idle 실험이나 실제 Code 전체 CPU 계측이라는 주장은 하지 않는다.
Node는 22.22.2이며 같은 PATH의 Git 2.53.0을 실행 후 로컬에서 확인했다.

## 결과

아래 변화율은 **각 round 쌍의 `(after / before - 1) × 100` 중앙값**이다.
before/after를 따로 구한 중앙값의 비율과 다르다. 표시 시간은 포커스 유지 조건에서는
요청 시작→최신 목록·배지, 나머지에서는 복귀 이벤트→같은 상태 준비다. 물리 클릭·
실제 Graph frame의 시간은 아니다. 원본의 불리한 표본도 모두 유지했다.

| 작업트리 | 초기 cache | 조건 | 소유 CPU 변화 | 표시 시간 변화 | Git 호출 before → after |
| --- | --- | --- | ---: | ---: | --- |
| main | cold | 포커스 유지 | -5.9% | -5.5% | 7 → 7 |
| main | cold | 200ms 복귀 | -50.0% | -39.9% | 14–20 → 10 |
| main | cold | 10ms 복귀 | -43.4% | -53.0% | 14 → 10 |
| main | warm | 포커스 유지 | -6.8% | -5.9% | 3 → 3 |
| main | warm | 200ms 복귀 | -26.6% | -19.5% | 5 → 5 |
| main | warm | 10ms 복귀 | -22.2% | -41.3% | 5 → 5 |
| linked | cold | 포커스 유지 | **+3.0%** | **+4.7%** | 7 → 7 |
| linked | cold | 200ms 복귀 | -57.8% | -21.7% | 20 → 10 |
| linked | cold | 10ms 복귀 | -38.1% | -29.0% | 14 → 10 |
| linked | warm | 포커스 유지 | **+0.2%** | -2.8% | 3 → 3 |
| linked | warm | 200ms 복귀 | -41.9% | -10.6% | 7 → 5 |
| linked | warm | 10ms 복귀 | -3.4% | -19.8% | 5 → 5 |

비활성/빠른 복귀 32쌍 모두 소유 CPU가 감소했다. Native 호출 수가 같아도 필요 없어진
첫 status를 일찍 종료하면 그 프로세스가 사용한 CPU는 줄 수 있다. 포커스 유지에서는
Git 호출 수가 같고 CPU 16쌍 중 11쌍이 감소·5쌍이 증가했다. 일반 조회의 통계적 동등성,
모든 조건의 wall 개선, 실제 앱 전체 CPU 감소를 증명하지 않는다.

원본의 `hiddenStage`/`resumedStage` Native CPU는 종료 시점에 누적되는 counter의
차이다. 경계를 가로질러 실행한 프로세스 CPU는 close 뒤 잡히므로 실제 시간대별
CPU 분할로 해석하지 않는다. 위 CPU 비교에는 완료·정리까지의 전체 lifecycle만 사용했다.

## 불리한 진단 결과 보존

정식 비교 전에 main 한 개·조건별 1쌍으로 흐름을 점검한 별도 pilot도 보존했다.
pilot에서는 200ms 복귀 표시 시간이 cold 103.42→157.95ms, warm 88.47→107.88ms로
느려졌다. warm 포커스 유지 소유 CPU도 192.08→214.83ms였다. 이 결과를 삭제하거나
96회 정식 비교와 한 통계로 섞지 않았다. 반복 자료에서는 좋아졌더라도 잠깐 미리
끝낸 작업을 버리고 복귀 후 다시 읽는 비용과 환경 변동을 계속 확인해야 한다.

## 재현과 남은 검증

```sh
node scripts/benchmark-focus-status.mjs /tmp/gsc-focus-status-resource.json
```

POSIX process 검사와 동일 Node 설치본의 C header/compiler가 필요하다. 권한이 제한된
sandbox는 ps 소유권 검사를 막을 수 있다. 이번 실행은 해당 검사가 가능한 환경에서
끝났고 모든 소유 조회의 dispose와 임시 fixture 정리를 기다렸다. user worktree/실제
창을 조작하지 않는다. source를 고정 release와 다르게 편집했다면 실행기는 중단한다.

[96회 원본](focus-status-resource-0.1.72178.json),
[12회 pilot](focus-status-resource-pilot-0.1.72178.json),
[짝별 CPU·시간·호출 수 요약](focus-status-resource-summary-0.1.72178.json).

제품 runtime은 변경하지 않았다. 0.1.72178의 실제 활성화, 실제 Native Explorer
포커스 전환, 동시 호스트 부하에서의 Graph 응답·전체 앱 CPU 검증은 여전히 남아 있다.
