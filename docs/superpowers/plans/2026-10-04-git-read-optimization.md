# Git 조회 비용 최적화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앞서 확인한 세 우선 항목을 개선해 Git 실행과 OS 검사 중복을 줄이고 오래 사용해도 사용하지 않는 blame 작업을 남기지 않는다.

**Architecture:** 기존 실행 정책에 참조 조회의 index 비사용 분류를 추가한다. OS 검사는 사용자별 임시 디렉터리의 완료 snapshot/단일 검사 lease로 공유하고, 창별 소유권·보호 경로는 소비 시 적용한다. 종료 검사는 공유 캐시를 사용하지 않는다. blame은 직접 읽은 저장소/파일 identity로 캐시하고 표시 컨트롤러를 창 focus 수명에 연결한다.

**Tech Stack:** TypeScript, Node child_process/fs, VS Code API, node:test, esbuild. 새 의존성 없음.

**Spec:** 사용자 목표 `우선 개선할항목을 개선하자`와 대화에서 제시한 참조 준비 제거·창별 검사 공유·blame 재조회/비활성 창 작업 축소.

## Global Constraints

- Mac/SentinelOne 재시작과 추가 VS Code 개발 창 실행 없이 검증한다.
- 실제 쓰기/hook/다른 활성 Git, 열린 Code 저장소·문서·터미널 보호를 유지한다.
- 유휴 정리의 PID/start/UID/executable/socket 재검증을 종료 직전에 유지한다.
- Git 계층은 VS Code 비의존, 파일당 600행 이하, 함수 설명은 한글, 전환/스킵/오류는 OUTPUT에 기록한다.
- 기존 설정과 UI/i18n을 유지하고 새 의존성이나 별도 설정을 만들지 않는다.
- 캐시 identity 확인이 불가능하면 오래된 완료 값을 재사용하지 않는다.

## Review Focus

- 공유 결과에 다른 창의 `owned`/보호 경로를 그대로 사용하지 않는다.
- 검사 lease 소유자 종료·손상 캐시·동시 요청에서 안전한 복구와 제한된 대기를 보장한다.
- 캐시 판정 후 새 Code/터미널/Git/소켓 교체가 생기면 공식 stop을 보류한다.
- linked worktree, detached/unborn HEAD, packed refs와 index 변화에서 blame을 새로 읽는다.
- focus를 잃은 진행 중 조회는 마지막 표시 소비자가 해제하고 focus 복귀에서 최신 표시를 복구한다.

### Task 1: 참조 조회 준비와 실행 분류

**Files:** `src/git/ownedFsmonitor.ts`, `src/git/gitCommandPolicy.ts`, `test/ownedFsmonitor.test.ts`, `test/gitReadPolicy.test.ts`.
**Interfaces:** 기존 `gitCommandPolicy(args)`/`prepareGitOptions`를 유지한다.

- [x] `show-ref`, `reflog show/list/exists`, `ls-remote`, `check-ref-format`가 준비 config/status/daemon을 실행하지 않는 회귀 검사 작성. reflog 쓰기는 deadline/자동 종료에서 계속 보호한다.
- [x] `npm test -- test/ownedFsmonitor.test.ts test/gitReadPolicy.test.ts`에서 새 검사 실패 확인.
- [x] index 비사용 분류와 참조 조회 readOnly 판정 구현.
- [x] 같은 검사를 실행해 통과 확인.

### Task 2: OS 검사 절감·공유·실패 진단

**Files:** `src/git/gitMonitorInspection.ts`, 새 `src/git/sharedMonitorInspection.ts`, `src/git/idleGitCleanup.ts`, `src/ui/gitProcessSettings.ts`, `test/gitMonitorInspection.test.ts`, 새 `test/sharedMonitorInspection.test.ts`.
**Interfaces:** `inspectGitMonitors(protectedRoots, deps?)`는 항상 새 OS 관찰. `readSharedGitMonitorInspection(protectedRoots, directory?)`는 후보 관찰에만 쓰며 창별 보호와 소유권을 덧붙인다. `GitMonitorSnapshot`에 민감한 argv/환경/오류 본문 없는 진단 필드를 추가한다.

- [x] 잘못된 lsof OR 선택으로 일반 open file을 cwd로 오인하는 회귀 검사 작성 후 실패 확인.
- [x] `-a`를 적용하고 검사 단계·오류 코드·시간 초과 진단을 보존한다.
- [x] 실제 임시 디렉터리를 사용하는 두 coordinator 및 두 Node 자식의 동시 요청에서 loader 1회/창별 보호 독립/새 검증을 검사한다.
- [x] 완료 snapshot 15초 공유, 실패 시 1/2/4/8분(최대) retry backoff, 원자적 lease/완료 파일, 30초 대기 상한과 죽은 소유자 복구를 구현한다. 캐시는 사용자 소유 0700 디렉터리/0600 파일에만 둔다.
- [x] `npm test -- test/gitMonitorInspection.test.ts test/sharedMonitorInspection.test.ts test/idleGitCleanup.test.ts test/gitCleanupScheduler.test.ts` 통과 확인.
- [x] 실제 OS 검사 한 번을 실행하고 complete/이유/소요 시간/공유 재사용을 확인한다. 공식 stop은 항상 새 OS 검사를 사용한다.

### Task 3: blame identity 캐시와 창 focus 수명

**Files:** 새 `src/git/blameCacheIdentity.ts`, `src/git/blameService.ts`, `src/git/sharedBlameReads.ts`, `src/providers/blameDecoratorController.ts`, `src/providers/blockBlameCodeLensController.ts`, `test/helpers/vscodeMock.ts`, 새 `test/sharedBlameReads.test.ts`, 새 `test/blameFocusLifecycle.test.ts`.
**Interfaces:** 기존 `getFileBlame(fsPath, range?, {signal?})`와 공유 소비자별 취소를 유지한다. identity를 얻은 결과는 최대 60초 재사용하며 변경/무효화 시 새 세대로 읽는다.

- [x] 1초가 지난 같은 identity의 blame 재사용, 파일/HEAD/index 변경 재조회, linked/detached/unborn/packed refs를 검사하고 실패 확인.
- [x] 파일 통계와 Git metadata identity를 Git spawn 없이 읽는다. 완료 캐시의 LRU/수량/큰 결과 메모리 상한을 유지한다.
- [x] 비활성 창의 신규 표시 조회 스킵/진행 중 소비자 취소/focus 복귀 재요청을 검사하고 실패 확인.
- [x] 라인 decoration·블록 CodeLens 컨트롤러를 focus 이벤트에 연결하고 OUTPUT에 상태 전환을 기록한다.
- [x] 위 검사와 기존 `test/blockBlameCancellation.test.ts` 통과 확인.

### Final verification and integration

- [x] `npm run check-types`, production bundle, `git diff --check`, 전체 `npm test` 통과 확인.
- [x] 변경 전체를 별도 reviewer로 한 번 검토하고 중요 문제는 재현 검사→수정→전체 검사로 검증한다.
- [ ] 소스 변경과 실제 측정/제약을 기록하고 기존 설치·배포 흐름으로 적용한다. main 통합 직전 현재 상태를 다시 확인한다.

## Evidence and decisions

- 시작 상태: clean main/origin `20a1996`, 설치/배포 `0.1.72075`.
- 읽기 전용 현장 probe: 동일 사용자 lsof cwd 출력 2,742,088 bytes/540ms; `-a` 결합 28,141 bytes/379ms. Git 17, Code 93개 프로세스.
- 과거 초기 활성화의 검사 실패는 현재 probe에서 재현되지 않았다. 실패 상세를 버리지 않고 다음 실제 재현에서 경계를 확인한다.
- 작업 공간: `/private/tmp/gsc-git-read-optimization`, branch `perf/git-read-optimization`, 원본 의존성 재사용. 추가 Code 창은 실행하지 않는다.
- Ruling: 이미 승인된 개선 범위를 직접 구현·검증한다. 새로운 UI/설정 변경은 없으므로 UI 설계/시각 검사를 추가하지 않는다.

### Progress ledger

- Task 1: complete — 참조 준비/분류 2개 회귀 실패 확인 후 수정. `/private/tmp/gsc-optimization-refs-green.log`: 14 passed.
- Task 2: complete — cwd 과잉 선택/진단 누락 실패 확인 후 수정. 두 실제 Node host 포함 `/private/tmp/gsc-optimization-inspection-green.log`: 25 passed. Native 관찰 complete=true, 17/17 protected; 공유 최초 4861ms, 재사용 20ms.
- Task 3: 기본 구현 검증 — 캐시/metadata/메모리 회귀 6개와 focus 3개, 상위 CodeLens HEAD 변경 회귀의 실패를 확인 후 수정. `/private/tmp/gsc-optimization-blame-final-focused.log`: 11 passed.
- Typecheck/compile/diff-check: 최종 제품 변경 뒤 모두 passed. VSIX `0.1.72076` 패키징 exit=0.
- First full suite: 248개 개별 검사가 통과한 뒤 전체 900000ms 제한으로 종료(exit=1). 개별 실패 없음; 전체 통과로 취급하지 않는다. 종료 뒤 OS 확인 Git 17개, 추가 fixture/테스트 Git 잔류 없음.
- Full suite retry: 사용자 global/system config를 격리한 `env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm test`로 검증했다. 실제 사용자 설정 파일은 수정하지 않았다.
- Final review: 별도 read-only reviewer 1회, Critical/Important 없음. 최종 전체 검사 완료를 조건으로 통합 가능.
- Final: minor (deferred): 공유 lease의 PID 재사용 때 cleanup 관찰 가용성이 일시 중단될 수 있다. 종료 안전성에는 영향 없음; 다음 개선에서 시작 identity를 함께 확인한다.
- Final: minor (deferred): 외부 blame.ignoreRevsFile 등 내용 변화는 최대 60초 TTL 뒤 반영될 수 있다. 외부 입력 경로 추적은 후속 범위다.
- Final: Ruling: reviewer가 보류한 reftable은 파일-ref identity를 적용하지 않고 완료 캐시를 우회한다 — 새 저장 형식에서 HEAD 변화를 파일 refs만으로 입증할 수 없기 때문이다. `a repository with reftable metadata bypasses the unsupported file-ref identity cache`의 1 !== 2 실패 재현 후 수정; 최종 전체 suite에서 통과했다.
- Final: Ruling: 기존 마지막 OS 관찰과 stop 사이 race는 동일한 새 PID/socket/Git/Code/terminal 재확인으로 유지한다. 공유 cache는 stop에 쓰지 않아 경계가 넓어지지 않는다.
- Final: Ruling: 일반 손상 cache만 복구하고 고의적인 동일 사용자 cache 조작은 종료 직전 새 OS 검증으로 차단한다. 악의적인 동일 사용자의 파일 변조 자체를 별도 방어하는 제품 범위는 추가하지 않는다.
- Final: Ruling: 활성 소비자가 필요한 blame 결과는 일시적으로 메모리 상한을 넘을 수 있으나 완료/미사용 결과부터 해제한다. 필요한 작업을 중단해서 상한을 맞추지 않는다.
- Final: Ruling: 살아 있으나 느린 검사 lease는 훔치지 않는다. 기다리는 창은 30초 상한 이후 불완전 관찰로 정리를 보류한다.
- Final: Ruling: 전체 suite 성공은 실제 최종 출력으로만 확인한다. 추가 VS Code 창/장기 사용 UI 재현은 실행하지 않았고 native probe의 단기 측정을 그 결과로 대신 주장하지 않는다.
- Isolated full suite 1: 936 tests, 934 pass/2 fail, 212806ms. 실패 이름: `a completed CodeLens snapshot is refreshed when HEAD changes before its TTL`, `file and HEAD changes produce fresh blame even within the shared cache period`. `/dev/null`을 실제 설정 파일처럼 mtime/ctime 비교한 것이 원인이다.
- Null config regression: `a null global config stays stable when another process writes to the null device`에서 hash 변화 실패를 재현했다. null device를 빈 고정 설정으로 식별하고 다른 비정규 metadata는 완료 캐시에서 제외하도록 수정했다. 최종 관련/전체 검사에서 통과했다.
- Actual native blame: `.gitignore` 두 요청 사이 1200ms 후 Git 실행 1회, 최초 446ms/재사용 2ms, 동일 15 lines. `/private/tmp/gsc-optimization-blame-probe.json`. 사용자 파일·설정은 변경하지 않았다.
- Final focused: 52 passed, 0 failed, 0 skipped, 14122.949ms. 기록: `/private/tmp/gsc-optimization-final-focused.log`.
- Final full suite: 937 passed, 0 failed, 0 skipped, exit=0, 537575.392ms. 기록: `/private/tmp/gsc-optimization-full-tests-final.log`. 타입 검사와 패키징도 최종 변경 뒤 exit=0으로 확인했다.
- Pre-integration: origin fetch exit=0; main/origin/main은 모두 `20a1996`이며 main 작업 트리는 clean이다. 설치·배포는 기존 사용자 요청에 따라 같은 검증 VSIX로 진행한다.
