# Git restart cleanup implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline; request one scoped review after implementation.

**Goal:** VS Code 종료·재실행 때 Git 감시자가 누적되는 실행 경로를 막고, 검증된 미사용 감시자를 회수한다.

**Architecture:** Git 실행 경계에서 builtin fsmonitor 시작을 직접 소유하고 준비 실패 시 명령 범위에서 우회한다. 직접 소유한 조회와 감시자는 정상 종료 때 close까지 기다린다. macOS 감시자 검사는 IPC 소켓과 Git directory/backlink로 저장소를 입증하고, 자동 정리를 켠 경우 같은 사용자의 분리된 감시자도 연속 유휴 관찰 후 공식 stop으로 정리한다.

**Tech Stack:** TypeScript, Node child_process, Git CLI, macOS ps/lsof, node:test.

**Spec:** 사용자 요청: “vscode를 종료 재실행을 반복하면 git 프로세스가 쌓인다. 이걸 방지하거나 필요없거나 사용량이 없는 프로세스는 종료해야한다.” 기존 `2026-10-04-git-long-session-performance-design.md`의 사용 보호·PID/소켓 재검증·설정 범위를 유지하며 자동 정리 대상에 검증된 PPID 1 감시자를 추가한다.

## Global constraints

- commit/fetch/push/rebase/merge 및 hook은 자동 종료하지 않는다.
- CPU 0%·프로세스 나이만으로 종료하지 않는다. index/lock/config를 삭제하지 않는다.
- 활성 Code 창·터미널·Git 작업·불완전한 사용 관찰은 보호한다.
- 기존 사용자/워크스페이스 옵션과 5분 기본 유휴 시간, OUTPUT 로그를 재사용한다.
- 추가 VS Code 테스트 창을 띄우지 않고 실제 Node/Git 자식으로 종료·재실행을 검증한다.

## Review focus

- 홈 디렉터리로 이동한 detached daemon도 정상/linked worktree 소켓으로 매핑되는가.
- 준비가 느리거나 실패해도 status가 별도 detached daemon을 경쟁 생성하지 않는가.
- 종료 도중 새 준비 작업이나 PID 재사용이 다른 프로세스를 종료하지 않는가.
- 다른 창·터미널의 사용과 쓰기가 정리 직전 재개되면 그대로 보호되는가.
- macOS 미지원 Git/플랫폼 및 명시적 GIT_DIR/GIT_WORK_TREE 환경이 정상 결과를 유지하는가.

### Task 1: detached monitor inspection and idle recovery

**Files:** `src/git/gitMonitorInspection.ts`, `src/git/idleGitCleanup.ts`, `test/gitMonitorInspection.test.ts`, `test/idleGitCleanup.test.ts`.

- [x] 실패 테스트: cwd가 홈인 감시자의 normal/linked worktree 매핑, PID/소켓 교체, 다른 Code/terminal 보호, 분리된 외부 감시자 opt-in 자동 정리.
- [x] OS 어댑터 의존성을 주입해 실제 제품 판정 로직을 테스트하고 cwd 가정을 제거한다.
- [x] 공식 stop에 저장소·PID·소켓·사용 여부 재검증을 유지한다.
- [x] 관련 Node 테스트를 실행한다.

### Task 2: owned monitor startup and shutdown

**Files:** `src/git/ownedFsmonitor.ts`, `src/git/gitProcessRunner.ts`, `src/git/gitProcessRegistry.ts`, `src/ui/gitProcessSettings.ts`, `test/gitProcessLifecycle.test.ts`, `test/ownedFsmonitor.test.ts`.

- [x] 실패 테스트: 기본 자동 정리 OFF에서도 신규 builtin 감시자 소유, 준비 실패 fallback, 반복 세션 종료 뒤 조회·감시자 0개, 쓰기 보호.
- [x] 모든 일반 Git 실행에서 builtin 감시자 준비를 일관되게 적용하고 중첩 준비 호출은 제외한다.
- [x] dispose 완료 Promise와 정상 Host exit의 소유 자식 신호 정리를 연결한다.
- [x] 관련 Node 테스트와 타입 검사를 실행한다.

### Task 3: release and actual cleanup verification

**Files:** `package.json`, `package-lock.json`, `CHANGELOG.md`, `docs/git-long-session-verification.md`.

- [x] 실제 설치된 창·터미널과 unused daemon 매핑을 확인하고 검증 가능한 대상만 정리한다.
- [x] 전체 Node 회귀, build, scoped review를 확인한다.
- [x] 버전 0.1.72075 패키지·설치·커밋·푸시·vsce publish를 진행한다(기존 사용자 승인).
- [x] 설치 artifact/배포 manifest 및 검증 범위를 기록한다.

## Progress

- Base: `78d8fb7`, clean established checkout. 기존 사용자가 직접 커밋·설치·배포를 요청한 작업을 같은 checkout에서 이어간다.
- Inspection: 실제 Git 20개 모두 detached fsmonitor; cwd `/Users/lky`. 기존 cwd-in-repository 검사가 실제 대상 전체를 제외했다.
- 이전 테스트 저장소를 감시하는 PID 9695는 상대 IPC 소켓 이름을 사용했다. 실제 .git/HEAD와 소켓은 남아 있으므로 삭제된 저장소로 추정해 종료하지 않았다. Git이 연 worktree 디렉터리와 .git marker를 함께 검증해 매핑했다.
- Task 1 complete: 소켓·HEAD·linked backlink 검증과 Code window config 중복 제거를 구현했다. 종료 직전 새 Code 창·terminal cwd·Git 작업과 PID/소켓을 재검증한다. 상속 GIT_* 환경을 제거하고 소켓 Git directory에 공식 stop을 고정한다.
- Task 2 complete: 공통 실행기에서 foreground 감시자 준비와 close 대기를 연결했다. 명시적 hook·마지막 command-scope 설정을 보존하고, 다른 worktree 생성·불명확한 Git directory·실패한 준비에는 최종 argv override로 detached 자동 시작을 막는다. 외부 감시자 준비는 5초 동안 공유하며 /var symlink 소유권은 생성 시 realpath 증거로 확인한다.
- Final scoped review: Critical 없음, Important 4개(never-ready 감시자 잔존, 설정 범위/hook 보존, stop 직전 새 사용, 상속 GIT_* redirect)를 하나의 수정 pass에서 실패 재현 후 수정했다. 재검토를 반복하지 않고 최종 회귀로 검증한다.
- Actual cleanup: 5분 이상 연속 관찰한 미사용 감시자 4개를 공식 stop으로 종료했다. 실제 Git 수 21→17, 대상 PID 잔존 0, 사용 중인 17개는 보호했다. 기록: `/private/tmp/gsc-restart-actual-cleanup.json`.
- Actual native Git: 세 세션 모두 foreground owned 확인, dispose 완료 뒤 잔여 0. 기록: `/private/tmp/gsc-real-restart-lifecycle.json`.
- Final focused verification: 58 passed / 0 failed / 0 skipped, 타입 검사·diff check 통과. handshake IPC 오류를 반복 대기하지 않는 검사도 수정 전 실패·수정 후 통과했다. 기록: `/private/tmp/gsc-restart-final-focused.log`.
- User settings: 사용자 전역 `gitSimpleCompare.gitProcessCleanup.enabled=true`, 유휴 기준 5분. JSONC 주석과 다른 설정을 보존했고 변경 전 파일은 `/private/tmp/gsc-settings-before-72075.jsonc`에 백업했다. 제품 기본값 off와 기존 workspace/folder override는 유지한다.
- Final whole-suite verification: 마지막 handshake 수정까지 반영해 전체 Node 916 passed / 0 failed / 0 skipped, production 빌드·VSIX 패키징 exit 0. 전체 기록: `/private/tmp/gsc-restart-full-tests-final.log`.
- Release: 구현 커밋 `9dfdd90`을 origin/main에 푸시했다. 0.1.72075 VSIX 설치와 빌드·패키지·설치 binary SHA-256 일치를 확인했다. 설치한 동일 VSIX로 `vsce publish --packagePath`를 실행했고 published 성공 응답/exit 0을 확인했다.
- Task 3 complete: 2026-10-04 10:08:31 UTC에 공개 Marketplace manifest HTTP 200 및 `newdlops/gitsimplecompare/0.1.72075` 일치를 확인했다. 기록: `/private/tmp/gsc-marketplace-72075-verification.json`. 추가 VS Code 창·Mac/SentinelOne 재시작 없이 완료했다. 기존 열린 창에는 한 번의 `Developer: Reload Window`가 필요하다.
