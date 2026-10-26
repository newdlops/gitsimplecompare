# 0.1.72178 — 비활성 창의 표시용 공유 조회 해제

실제 0.1.72177 세션에서 같은 저장소의 초기 파일 스캔이 반복됐다. 기존 Explorer
공급자는 포커스 상실 뒤 자체 재시도는 막았지만, 이미 기다리는 공유 실행기의
소비자를 해제하지 않았다. `SharedGitRead.latest`는 무효가 된 결과를 반환하기 전에
내부에서 다음 세대를 읽으므로 공급자 바깥의 포커스 검사만으로는 충분하지 않았다.
Changes에도 진행 중 상태·통계·fallback을 포커스 상실과 연결하는 해제가 없었다.

## 변경

- Explorer의 저장소 수명과 현재 표시 조회 수명을 분리했다. 포커스 상실은 현재
  소비자만 해제하며 마지막 배지를 유지한다. 빠른 복귀는 이전 close를 기다린 뒤
  최신 조회 하나에 합류한다.
- Changes는 포커스 상실 시 요청 번호를 먼저 갱신하고 상태·통계·지연 fallback을
  취소한다. 늦은 결과가 화면을 덮거나 상위 세대 재시도를 시작하지 못하게 한다.
- 이미 queue에 들어간 자동 Changes pass에도 포커스 범위를 전달한다. 내부 세대
  재시도와 direct-file fallback도 이를 이어받는다. 수동 command와 직접 기다리는
  상태/API 호출은 비활성 중에도 시작할 수 있다.
- 공유 실행기의 다른 소비자와 `cancelUnused=false` 정책은 유지한다. 실제 Git
  쓰기 작업은 이 표시용 취소 신호를 사용하지 않는다. 복귀 시 기존 authoritative
  reconcile을 사용하고 마지막 정상 목록·provider fence를 보존한다.
- OUTPUT의 `working status reads paused`, `working status read deferred`,
  `working tree decoration reads cancelled`로 표시 수명 전환을 확인할 수 있다.

## 기능 검증

실제 `SharedGitRead`를 연결한 새 회귀 테스트에서 이전 공급자는 5개 중 4개가
실패했다. 무효화된 in-flight 조회가 숨겨진 소비자 때문에 loader를 두 번 실행하는
사례를 포함한다. 수정 후에는 숨겨진 후속 loader가 생기지 않고, 복귀 시 최신
결과 하나를 읽는다. 다른 API 소비자가 남아 있으면 필요한 실행·재시도를 보존한다.

Explorer와 Changes가 같은 조회에 합류한 통합 사례, 빠른 포커스 왕복과 close 대기,
늦은 provider·통계 결과, queued 자동 조회, 비활성 중 명시적 요청을 검증했다.
관련 Node 140개와 타입 검사가 통과했다. Native fixture의 index 보존, hostile 파일명,
rename·미추적 항목, 실제 자식 프로세스 종료와 쓰기 deadline 구분도 포함한다.

첫 sandbox 실행은 자식 프로세스 소유권 검사를 포함한 종료 테스트에서 실패했다.
실패한 그룹을 중단한 뒤 해당 테스트의 고아 자식 1개만 실행 파일과 PID로 확인해
회수했고 종료를 재검증했다. 같은 소스·같은 14개 파일을 sandbox 밖에서 실행한
140개 검증이 전부 통과했다. 실패·중단 로그도 로컬 진단 기록에 보존했다.

`eslint.config.*`가 없어 source lint는 완료할 수 없었다. 관련 없는 lint 설정이나
의존성은 추가하지 않았다. [검증 기록](benchmarks/focus-status-verification-0.1.72178.json).

실제 VSIX의 runtime 81개가 빌드 결과와 모두 일치한다. 이전 버전과 달라진 runtime은
`dist/extension.js` 하나이며 웹뷰·스타일·번역 바이트는 동일하다. package 기여·설정도
version 외에는 동일하다. [패키지 바이트 검증](benchmarks/release-artifact-0.1.72178.json).

## 실제 관찰과 남은 범위

[0.1.72177 실제 세션](benchmarks/actual-target-runtime-0.1.72177.md)은 최신 실행
조건을 해소하고 추가 수정 경로를 찾은 근거다. 180 ms의 첫 Graph와 9,340 ms의
다른 ready 기록은 저장소와 포커스 상태가 달라 서로 비교하는 벤치마크가 아니다.

이번 변경은 불필요한 공유 실행을 없앤 기능 검증이며 전체 앱 CPU 감소율이나
busy 상태의 짝지은 지연 개선량을 측정한 결과는 아니다. UI 작업 절차에서 기존
Native 테마·배지·표시 캐시를 유지하는 변경으로 분류했다. DOM·스타일·버튼·번역을
추가하지 않았으며 새 버전의 Native Explorer 포커스 전환 시각 검증은 아직 없다.
사용자 창 입력·포커스 이동·강제 reload와 Marketplace 점검은 수행하지 않는다.

## 배포와 설치 확인

제품 커밋 `0111964845245cb54d330bc58e971de000a35663`을 origin/main에 푸시하고
검증한 937,800-byte VSIX 그대로 업로드·설치했다. 패키지·빌드·설치본의 runtime
81개가 일치하고 등록된 버전은 0.1.72178 한 개다.
[배포 기록](benchmarks/deployment-0.1.72178.json).

2026-10-26 04:34:39 UTC에는 실제 세션 4개가 0.1.72177이었다. 이후 호스트 권한으로
0.1.72178 창 6개의 실행을 확인했고 사용자는 체감이 “많이 나아짐”이라고 답했다.
[실제 실행 기록](benchmarks/actual-target-runtime-0.1.72178.md)에 Graph 첫 표시,
읽기 전용 CPU 관찰 및 관찰 범위의 정정을 보존했다. 추가 reload 대기는 해소됐으며
[완료 기준과 검증 한계](benchmarks/goal-progress-0.1.72178.json)를 구분한다.

추가로 고정 release source와 소유 Native 작업트리의
[96회 CPU·복귀 비용 비교](benchmarks/focus-status-resource-0.1.72178.md)를 수행했다.
비활성·빠른 복귀의 불필요한 작업 감소를 확인했고, 포커스 유지의 혼재 결과와
복귀가 느려진 pilot도 함께 보존했다. 이 자료는 실제 Code 전체 부하 검증과 구분한다.
