# 장기 사용 세션의 Git 검증 — 2026-10-05

Mac과 보안 서비스를 재시작하지 않고 현재 세션에서 측정했다.
측정 시점의 저장소 코드는 `af9833e`, 설치 버전은 0.1.72079였다.
이번 검사에서 찾은 감시자 정리 검사 오류의 수정 버전은 0.1.72080이다.

## 실제 상태

- 부팅 시각: 2026-10-04 09:29:44 KST. 첫 상세 측정의 uptime은 33.77시간이었다.
- 물리 메모리: 48GiB. 첫 상세 측정의 swap 사용량은 13,323MiB였다.
- Git 17개는 모두 `fsmonitor--daemon`이며 PPID가 1이었다. 일반 status/log/commit/push 프로세스는 없었다.
- 실제 VS Code 본체·extension host·renderer는 0개였다. crashpad helper 2개만 남아 있었다.
- 기존 11개 extension host는 2026-10-05 19:02:17~19:02:19 KST에 exit 0으로 종료됐다.
  따라서 이 시점의 OS 장기 사용 상태를 확인했지만 계속 열린 확장의 메모리·UI 상태를 측정한 것은 아니다.

## 순차 Git 조회

현재 설정된 `/Library/Developer/CommandLineTools/usr/bin/git`을 사용했다.
Git Trace2의 내부 시간과 부모가 관찰한 실행 시간을 함께 수집했다.
status에는 `--no-optional-locks`, `core.fsmonitor=false`를 적용해 실제 index 갱신과 감시자 자동 생성을 피했다.

| 읽기 | 전체 시간 | Git 내부 시간 |
| --- | ---: | ---: |
| configured Git `--version`, 첫 실행 | 158.7ms | 1.6ms |
| configured Git `--version`, 두 번째 | 9.9ms | 1.7ms |
| configured Git `--version`, 세 번째 | 8.8ms | 1.2ms |
| 전체 미추적 파일을 포함한 status, 첫 실행 | 42.6ms | 33.6ms |
| 모든 ref에서 최대 500개 log | 202.2ms | 193.5ms |
| for-each-ref | 16.2ms | 7.8ms |
| 같은 status, 두 번째 | 17.9ms | 9.9ms |

Homebrew Git `--version`은 83.5/11.5ms, `/usr/bin/git` shim은 17.8/13.7ms였다.
이 측정은 현재 확장 저장소에 대한 단일 관측이며 다른 저장소나 실제 UI의 지연까지 입증하지 않는다.

11개 순차 실행 전후 실제 index의 SHA-256이 일치했고 Git 프로세스는 17개로 유지됐다.
같은 구간의 swapin 증가는 128KiB, 새 swapout은 0이었다. 누적 swap 사용량만으로
현재 Git 지연의 원인이나 해결 여부를 판정하지 않는다.

## 발견한 정리 검사 오류

수정 전의 실제 `inspectGitMonitors([])`는 `complete=false`,
`reason=code-window-usage-unavailable`로 17개 감시자의 후보 조회를 모두 보류했다.
`Visual Studio Code.app` 경로의 crashpad를 창이 열린 Code 프로세스로 분류한 것이 원인이었다.

실행 파일 이름이 정확히 `chrome_crashpad_handler`인 오류 보고 helper만 Code workspace 검사에서 제외했다.
처음 조회, 조회 도중 새 프로세스 확인, 공식 stop 직전 재검증에 같은 판별 함수를 적용했다.
실제 Code 본체·renderer·extension host와 알 수 없는 helper의 사용 검증은 유지했다.

같은 Mac에서 수정 후 검사한 결과는 `complete=true`, 17개 매핑, 910ms였다.
16개는 `active-terminal-or-process`로 보호됐고, captain 저장소의 PID 14912만 보호 사유가 없었다.
실제 제품의 유휴 판정으로 19:27:45~19:32:52 KST에 6회 관찰했다.
앞의 5회는 후보가 없었고, 5분이 지난 마지막 조회에서만 PID 14912가 후보가 됐다.
19:37:03 KST에 최종 PID·사용·소켓 재검증과 공식 `fsmonitor--daemon stop`을 통해 종료했다.
종료된 PID는 남지 않았고 감시자는 17개에서 16개로 줄었다. captain의 실제 index SHA-256은
종료 전후 일치했다. 16개의 사용 중인 저장소 감시자는 유지됐다.

## 정리 후 변동과 동시 부하 관찰

19:39 KST에 같은 11개 순차 조회를 다시 수행했다. status는 125.5/169.4ms,
log는 812.7ms, 첫 `--version`은 375.3ms였다. Git 16개와 실제 index가 유지됐고
그 구간의 새 swapout은 0, swapin 증가는 1.25MiB였다.
감시자 한 개를 줄인 직후 Git이 빨라진 것은 아니므로 프로세스 개수만으로 지연을 설명하지 않는다.

19:42의 후속 CPU 관찰에서는 시스템 CPU 사용률이 82~94%였고 Python·Node·esbuild가
CPU를 많이 사용했다. 계속 실행 중인 Python PID 15120의 cwd는 `Documents/imbed-speed`였으며,
시작 시각은 19:42:13 KST였다. 이 작업은 앞선 19:39 측정 이후 시작했으므로
앞선 지연을 이 Python 작업에 귀속하지 않는다.

19:50:24~19:50:30 KST에 CPU 관찰과 Git 실행을 함께 수집했다. Git 실행 구간은
19:50:27.016~19:50:27.780이었다. 같은 구간에서 시스템 idle은 약 27~46%,
Python의 CPU 표시는 366~407%였다. status는 77.5/21.5ms, log는 144.5ms,
첫 `--version`은 257.6ms, 이후 두 실행은 9.7/10.8ms였다. Git 구간의 swapin/out 증가는 0이었다.
CPU·스왑·최초 실행 비용이 변동할 수 있음을 확인했으며, 이 관측만으로 특정 앱이나
보안 서비스가 지속적인 Git 병목의 원인이라고 판정하지 않는다.

## 검증 범위

새 회귀 검사는 수정 전 3개 실패를 재현했다. 수정 후에는 관련 30개 검사가 모두 통과했다.
실제 renderer의 workspace 보호, 미확인 Code helper, 새 Code 창·터미널의 최종 stop 차단,
PID/소켓 변경, 연속 유휴 시간, 공유 관찰·실패 backoff를 포함한다. 소스 타입 검사도 통과했다.

실제 사용자 창의 Changes·Graph·PR 목록/상세 paint 시간은 아직 확인하지 않았다.
측정 대상으로 사용할 프로젝트와 실행 중인 VS Code 창을 확인해야 이 부분을 이어갈 수 있다.
추가 Extension Development Host나 브라우저 시험 창은 실행하지 않았다.

## 원시 자료

자료는 사용자 전용 임시 디렉터리 `/private/tmp/gsc-long-session-20261005`에 보관한다.

- `measurement.json`: OS 전후 snapshot, 11개 Git 실행, index 보존, swap 증분
- `*.trace.jsonl`: Git 내부 실행 시간
- `monitor-inspection.json`, `monitor-inspection-after.json`: 실제 제품 검사 수정 전후
- `crashpad-regression-before.log`, `crashpad-regression-final.log`: 실패 재현과 최종 30개 검사
- `idle-observation.json`, `idle-final-snapshot.json`: 5분 연속 유휴 후보 관찰
- `confirmed-cleanup.json`: 실제 공식 stop·PID 소멸·captain index 보존
- `after-cleanup/measurement.json`: 정리 뒤 같은 Git 실행과 OS 상태 비교
- `system-load.txt`: 후속 CPU·메모리 부하 관찰
- `paired-cpu-load/measurement.json`, `paired-system-load.txt`: 시각이 겹치는 Git·CPU 관찰

## 패키지 확인

0.1.72080의 production 빌드와 VSIX 패키징이 성공했다. 패키지는 124개 파일이며
소스·테스트·개발 문서를 포함하지 않는다. 추출한 `dist/extension.js`와 production 번들의
SHA-256이 일치했다.

- VSIX SHA-256: `bf481c05637a4e9b8ed7cdecec974dddd30b9cbe633d91087db8dd7abcebd8d0`
- 번들 SHA-256: `18198cd560a9f51a71532f36407425cbf2f690af58deeabd905fb41025408988`

## 설치·배포 확인

수정 커밋 `94b321cd531cd264bc7d9544c88fd53eb61d9490`을 `origin/main`에 푸시했다.
같은 VSIX를 사용자 VS Code에 설치했으며, 설치된 package version은 0.1.72080이고
`dist/extension.js`의 SHA-256은 위 production 번들과 일치했다.

`vsce publish --packagePath`가 0.1.72080 게시 성공을 반환했다. Marketplace의
버전 지정 공개 VSIX를 다시 다운로드한 SHA-256도 로컬 VSIX와 일치했다.
게시 직후 일반 Marketplace 버전 조회에는 0.1.72079가 표시됐으므로 검색·자동 업데이트
목록의 반영까지 확인했다고 주장하지 않는다. 설치 뒤에도 실제 VS Code 창은 닫힌 상태였고,
사용자 창의 장기 사용 UI 측정은 위 검증 범위에 적은 대로 남아 있다.
