# 장기 사용 Git 지연 수정 검증 — 2026-10-04

## 구현 범위

- 확장 소유 조회의 제한 시간·취소·자식 종료·close 대기를 공통 실행기에 적용했다. 기본 조회 제한은 30초이며 쓰기·hook·fetch·push는 자동 조회 제한에서 보호한다.
- 유휴 Git 정리의 사용자 전역·워크스페이스 설정, 5분 기본 유휴 관찰 시간, 수동 다중 선택을 추가했다. 자동 정리는 기본 꺼짐이며 켠 경우 1분마다 확인한다.
- CPU나 프로세스 나이만으로 종료하지 않는다. PID 시작 시각·사용자·실행 파일·감시 소켓·저장소·현재 사용을 재검증하며 감시자는 공식 Git stop으로 종료한다.
- Changes·Graph·Tab Manager가 작업 상태를 공유한다. private index와 경로 제한된 미추적 파일 열거로 전체 파일 목록을 유지하며 실제 index를 수정하지 않는다.
- 상태·통계·blame 소비자의 취소와 종료 시 캐시·구독 정리를 연결했다. 공개 비교 API version 1은 유지하고 선택적인 상태 API version 1을 추가했다.

## 기능 검증

- 전체 Node 검사: 889 passed, 0 failed, 0 skipped. 소유 프로세스 그룹, TERM 저항 자식, 읽기 timeout, 쓰기 보호, PID 재사용, 정리 취소, 공유 조회의 독립 취소·강제 새로고침, private index 정확성·racy-clean·split/sparse/linked worktree를 포함한다.
- VS Code 시험 호스트에서 사용자/워크스페이스 상속, 유휴 설정, 자동 정리 off 상태의 수동 명령, 기존 비교 API, 공유 API, API 전용 저장소의 metadata 변경, staged 목록과 index 보존을 확인했다.
- Tab Manager와 GSC를 함께 실행한 시험에서 별도 v1 status가 실행되지 않고 공유 API를 사용하는 것을 확인했다. 기본 Git을 끈 상태의 PR 파일/댓글·삭제 항목·변경 필터, 비활성 창의 파일 이벤트 지연, 수동 새로고침, Git on/off 전환, 유휴 시 polling 없음도 통과했다.
- GSC 프로세스 소유권·취소·캐시 정리의 집중 검토에서 중요도가 높은 잔여 지적이 없었다.
- Tab Manager 추가 검토에서 외부 변경의 세대 누락과 선택적 GSC 활성화 실패 시 CLI fallback 차단을 발견해 수정했다. 추가 VS Code 창 없는 Node 계약 검사 5개가 수정 전 3개 실패, 수정 후 5개 통과했다.
- GSC에서 이미 forced 조회가 시작된 경우도 실제 `SharedGitRead`로 재현했다. 실제 변경을 나타내는 `changed` 옵션과 loader 시작 경계로 최신 pass를 예약하며 시작 전·예약 중 변경은 합친다. 실제 서비스 검사 6개가 통과했고, native 통합 시험은 이 추가 경계 수정 전에 수행했다. 최초 전체 889개 결과에는 이후 추가한 검사 2개가 포함되지 않는다.
- 최종 경계 수정 뒤 공유 조회·상태 캐시·private index·CodeLens 관련 검사 28개를 worker 1개로 실행해 모두 통과했다. GSC 타입 검사와 마지막 범위의 재검토도 통과했다.
- 실제 QuickPick/InputBox 시각 캡처는 완료하지 못했다. 첫 캡처 도구의 placeholder 인식이 실패했고 후속 시험은 기존 기본 Git 상태 전환 대기에서 timeout됐다. 이를 시각 QA 통과로 간주하지 않는다. 사용자 메모리 압력 관찰 이후 추가 시험 창 실행을 중단했다.

## 실제 저장소 순차 조회

추가 VS Code 창 없이 제품의 `PrivateStatusIndex` 코드를 실행했다. 저장소마다 authoritative 전체 조회, private index 최초 조회, 재사용 조회를 순차 수행했다. 각 결과의 branch/HEAD/upstream·파일 상태를 대조하고 조회 전후 실제 index의 SHA-256이 같은지 확인했다.

| 저장소 | 전체 조회 | private 최초 | private 재사용 | 목록·staged 일치 | 실제 index 보존 |
| --- | ---: | ---: | ---: | --- | --- |
| gitsimplecompare | 209ms | 103ms | 99ms | 확인 | 확인 |
| vcmninth (linked worktree) | 1049ms | 331ms | 153ms | 확인 | 확인 |
| payroll-statement-for-hrm-emp | 2192ms | 299ms | 257ms | 확인 | 확인 |

각 행은 이번 관측의 단일 비교다. Graph 렌더링 시간이나 장시간 실행 후의 성능을 측정한 결과는 아니다. 원시 측정 기록은 `/private/tmp/gsc-final-status-measure.json`에 보관했다.

## 메모리와 남은 진단

- 물리 메모리는 48GiB다. 초기 관측의 swap 사용량은 6376MiB(약 6.23GiB), 이후 7692.44MiB(약 7.51GiB)였다.
- 첫 구간에서는 새 swapout이 없었지만 후속 관측까지 swapout이 813923에서 898175로 84252 pages 늘었다. page size 16384 기준 약 1.29GiB다. swapin도 183047에서 183205로 증가했다. 메모리의 디스크 이동이 실제 발생한 근거지만 특정 앱이나 Git의 지연 원인을 단독 입증하지는 않는다.
- 한 프로세스 스냅샷에서 VS Code 관련 95개 프로세스의 RSS 합계가 약 8.07GiB였다. RSS 합계는 공유 메모리 중복을 포함하며 압축·swap된 앱 메모리 전체를 나타내지 않는다.
- 확인한 잔존 Git 20개는 모두 `fsmonitor--daemon run --detach`였다. 멈춘 일반 status/commit/push로 식별된 프로세스는 없었다. 감시 데몬의 존재만으로 병목을 단정하거나 모두 종료하지 않는다.
- 이번 시험 호스트들은 종료된 상태였다. 시험 프로필을 가리키는 단독 crashpad helper를 신원 재확인 후 종료했고 후속 PID 조회에서 사라진 것을 확인했다. 사용자 VS Code 창, Mac, SentinelOne은 재시작하지 않았다.
- 과거 관측에서 Git 진입 전 OS 보안 계층의 실행 대기도 확인됐다. 담당 제품과 메모리 압력의 기여도를 아직 분리하지 못했다. 이번 수정은 확장에서 발생시키는 중복 조회·전체 파일 탐색·버려진 프로세스를 줄이며 OS 메모리·보안 대기를 해결했다고 주장하지 않는다.

수정 버전 적용 후 같은 창을 오래 사용하면서 Output의 Git startup/전체 실행시간, 활성 조회 수, 동시간대 swapin/swapout 증가량을 대조해야 장기 사용 개선을 판정할 수 있다.

## 릴리스 확인

- GSC 0.1.72074: `93b4060` 기능 커밋과 `a838996` 최신성 경계 수정 커밋을 origin/main에 푸시했다.
- Tab Manager 0.1.6619: `2b0f0d3`을 origin/main에 푸시했다.
- 두 VSIX를 `code --install-extension … --force`로 설치했다. manifest 버전과 빌드·패키지·설치된 `dist/extension.js`의 SHA-256 일치를 확인했다.
- 설치한 동일 VSIX를 `vsce publish --packagePath`로 배포했으며 두 버전의 성공 응답과 exit 0을 확인했다. TLS 검증을 유지하고 Node의 macOS system CA를 사용했다.
- 현재 열린 사용자 창은 강제로 reload하지 않았다. 이미 활성화된 이전 코드를 교체하려면 사용자가 `Developer: Reload Window`를 한 번 실행해야 한다. Mac이나 보안 서비스를 재시작하는 단계는 아니다.

## 0.1.72075 — 종료·재실행 때 Git 감시자 누적 수정

실제 잔존 Git은 일반 status/commit/push가 아니라 분리된 `fsmonitor--daemon run --detach`였다. 이 감시자들은 cwd가 `/Users/lky`였으므로 기존의 “cwd가 저장소 안에 있어야 한다” 검사가 모두 제외했다. 상대 IPC 소켓을 사용하는 이전 시험 저장소도 실제 `.git/HEAD`와 소켓이 남아 있었으며, 삭제된 저장소라고 추정해 종료하지 않았다. 감시자가 연 worktree 디렉터리·소켓·Git marker/backlink로 저장소를 입증하도록 수정했다. 보조 webview renderer는 workbench와 같은 window config로 묶어 Code 창 수를 계산한다.

확장이 새로 시작하는 builtin 감시자는 자동 정리 옵션과 별개로 직접 소유한 foreground 자식이 된다. 모든 공통 Git 실행 경로에 준비를 연결하고 정상 종료 때 조회·감시자·검증된 자식의 close를 기다린다. 준비 실패·불명확한 별도 Git directory·다른 worktree 생성은 최종 command-scope 설정으로 detached 자동 시작을 우회한다. 명시적 사용자 hook과 마지막 config override는 보존한다. 준비가 끝나지 않는 감시자는 close 후 fallback하며, IPC 오류나 timeout은 반복해 시작 대기를 늘리지 않는다. 이미 실행 중인 외부 감시자 준비는 5초 동안 공유한다.

자동 정리를 켜면 같은 사용자의 검증된 PPID 1 감시자도 연속 유휴 관찰 후 회수한다. 최종 stop 직전에 PID·사용자·시작 시각·실행 파일·소켓·저장소·새 Code 창·terminal cwd·Git 작업을 다시 확인한다. 공식 stop은 선택한 Git directory와 socket directory에 고정하고 상속 `GIT_*` 환경을 제거한다. 확장 소유권은 생성 시 기록한 realpath 증거로 `/var`와 `/private/var` 별칭도 검증한다.

- 최종 전체 Node 회귀: 916 passed, 0 failed, 0 skipped. 기록: `/private/tmp/gsc-restart-full-tests-final.log`.
- 최종 집중 검사: 58 passed, 0 failed, 0 skipped. 종료·PID/소켓 재사용·active Code/terminal·상속 Git 환경·hook·config 우선순위·worktree 생성·never-ready/IPC 실패·상태 목록/index 보존을 포함한다. 타입 검사와 diff check도 통과했다. Production 빌드와 0.1.72075 VSIX 패키징도 exit 0으로 완료했다.
- 실제 native Git 세션을 세 번 시작·종료했다. 각 세션의 foreground 감시자가 제품 검사에서 owned로 확인됐고 dispose 완료 뒤 잔여 프로세스는 매번 0개였다. 기록: `/private/tmp/gsc-real-restart-lifecycle.json`.
- 제품의 유휴 서비스로 실제 대상 네 개를 5분 이상 연속 관찰하고 공식 stop으로 종료했다. 당시 Git은 21개에서 17개로 줄었으며 대상 PID 잔존 0, 실패 0이었다. 나머지 17개는 열린 Code 창·터미널이 있는 저장소라 보호했다. 기록: `/private/tmp/gsc-restart-actual-cleanup.json`.
- 한 번의 독립 검토에서 Important 네 개(never-ready 잔존, 설정 범위/hook 보존, 최종 사용 재검증, 상속 환경 redirect)를 발견했다. 각각 실패 재현 후 수정했으며 최종 검사를 통과했다. 수정 후 별도 재검토를 반복하지 않았다.
- 사용자 전역 `gitSimpleCompare.gitProcessCleanup.enabled=true`, 유휴 기준 5분을 적용했다. JSONC 주석과 다른 설정을 보존했으며 변경 전 파일을 `/private/tmp/gsc-settings-before-72075.jsonc`에 백업했다. 제품 기본값 off와 기존 workspace/folder override는 유지한다.

이번 검증에는 추가 VS Code 시험 창이나 실제 사용자 창의 반복 종료·재실행을 사용하지 않았다. 정상 Host 종료 경계와 native Git 자식의 반복 수명은 검증했으나 부모가 SIGKILL로 강제 종료되는 경우에는 다음 세션의 opt-in 유휴 정리가 검증된 잔존 감시자를 회수한다. 일반적으로 소유권을 알 수 없는 Git을 CPU 0%나 나이만으로 종료하지 않는다. 이 수정으로 시스템 swap이나 보안 계층의 Git 실행 대기를 해결했다고 주장하지 않는다.

0.1.72075 VSIX를 사용자 VS Code에 설치했고 manifest 버전 및 빌드·VSIX·설치된 `dist/extension.js`의 SHA-256 일치를 확인했다(`7e3b465b6ff471704edfd35c860019731765cfa9dc7d96b26c55cb61e6ba81ac`). 설치된 동일 VSIX의 SHA-256은 `53da15c6e2df3725858d57e784e1db0053dbe395d114a45e2bbfc015aa3c0c25`이며 기록은 `/private/tmp/gsc-release-72075-verification.json`에 보관했다. 이미 활성화된 창의 새 코드 적용에는 `Developer: Reload Window`가 한 번 필요하다.
