# 장기 사용 세션의 Git 검증 — 2026-10-05

Mac과 보안 서비스를 재시작하지 않고 현재 세션에서 측정했다.
측정 시점의 저장소 코드는 `af9833e`, 설치 버전은 0.1.72079였다.
이번 검사에서 찾은 감시자 정리 검사 오류의 수정 버전은 0.1.72080이다.
추가 실사용 검사에서 발견한 종료 검사 범위의 최적화 버전은 0.1.72081이다.

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

뒤의 실제 사용자 창 검사와 0.1.72081 검사 결과는 아래에 별도로 기록한다.
추가 Extension Development Host나 브라우저 시험 창은 실행하지 않았다.

## 실제 VS Code와 저장소 검사

기존 Code 종료 뒤 별도의 일반 사용자 창이 실행돼 있었으며, 20:28 KST에
Default 프로필의 `payroll-statement-for-hrm-emp` 일반 사용자 창을 하나 열었다.
이 창의 extension host는 20:28:13 KST에 시작했고 Git Simple Compare는
20:28:23 KST에 활성화됐다. 설치 버전은 0.1.72080이었다. 따라서 Mac은 1일 이상
실행 중이었지만 이 host가 24시간 계속 열린 상태라고 해석하지 않는다.

초기 status는 읽기 제한 30초 뒤 종료를 요청했고, 그룹 검사 실패에 대한 fallback은
실행 시작 후 약 45.65초에 기록됐다. 실제 close는 46.053초, 실행 관찰 종료는
46.062초였다. 프로세스 식별 조회에 설정된 timeout은 2초이며, 이 기록만으로
약 15.6초의 추가 대기를 특정 보안 서비스나 OS 계층의 원인으로 단정하지 않는다.

이후 실제 그래프와 변경 목록을 읽기 전용 명령으로 갱신했다.

| 실제 창의 작업 | 관찰 결과 |
| --- | --- |
| 300개 커밋 그래프, 최초 표시 | 로그 조회 603ms, 레이아웃 3ms, 전체 paint 1,167ms |
| 그래프의 후속 증분 표시 | 기존 302행 재사용, DOM render 10ms |
| Changes 새로고침 | status 적용 181ms, 파일 통계 적용 663ms |
| PR 80개 목록, 최초 완료 | 8회 요청, 6,516ms |
| 후속 PR 80개 목록 완료 | 6회 요청, 8,100ms, 커밋 2개 재사용 |
| PR 상세, 파일 134개와 파일 댓글 23개 | 본문/댓글 1,720ms + 파일 1,130ms; 반복 조회 1,506ms + 913ms |

그래프 300개 커밋의 실제 표시를 해당 Code 창 ID로 캡처해 확인했다.
Changes와 PR 상세의 수치는 서비스 적용·전송 로그이며 각 화면의 paint 시간은
별도로 측정하지 않았다. 선택이 바뀐 PR 조회는 취소 후 실제 프로세스 close가
확인됐고, 다른 소비자를 계속 유지하는 경로도 기록됐다.

느렸던 4개 저장소를 따로 검사했다. 모든 status 출력과 실제 index SHA-256은
전후 일치했다. payroll의 첫 status는 12.481초였지만 Trace2의 미추적 디렉터리
탐색이 10.918초를 차지했고 fsmonitor 질의는 297ms였다. 뒤의 감시자 우회 실행은
0.988초였다. 실행 순서와 캐시 상태가 달라 감시자만의 속도 차이라고 해석하지 않는다.
다른 3개 저장소는 0.279~1.431초 범위였고 우회가 항상 빠르지도 않았다.

실제 확장 Git의 Trace2도 잠시 수집했다. 확장 전용 index를 사용한 첫 status는
3.629초, 그중 미추적 파일 탐색은 3.462초였으며 뒤의 status는 54~413ms였다.
이 기록은 앞선 46초 초기 조회 뒤 수집했으므로 초기 지연을 설명하는 증거로 쓰지 않는다.
임시 `gitPath` 설정은 21:03:53 KST에 원래 파일과 바이트 단위로 일치하도록 복원했다.

## 종료 검사 최적화 — 0.1.72081

기존 종료 처리는 직접 소유한 Git 그룹을 확인할 때도 전체 시스템 프로세스 목록을
읽었다. macOS에서는 해당 그룹만 OS에 조회하도록 바꿨다. 강제 종료 전에는 기존
구성원 PID와 현재 그룹의 합집합을 읽어 새 자식을 포함하고, 부모 close 뒤에는
알려진 자식 PID만 읽는다. 다른 POSIX 구현의 그룹 조회는 기존 전체 조회를 보존한다.
사용자·시작 시각·실행 파일·그룹 대조, 쓰기 작업 보호와 종료 확인은 유지한다.

선택 조회에 프로세스가 없을 때만 빈 결과를 허용하고 OS 오류는 전파한다.
OUTPUT에는 실제 그룹 검사 시간과 프로세스 수를 기록한다. 이 변경은 전체 조회의
불필요한 비용을 줄이며, 모든 OS 실행 대기의 원인을 제거했다고 주장하지 않는다.

실제 분리된 부모·자식의 그룹 선택, PID와 그룹 합집합, 식별 필드 보존, 빈 선택,
잘못된 선택, 종료된 PID, OS 오류 전파의 신규 7개 검사를 포함해 관련 46개 검사가
모두 통과했다. SIGTERM에 저항하거나 별도 stdio를 쓰는 자식 종료, 조회 timeout,
쓰기 보호와 반복 세션의 소유 감시자 회수도 포함한다. 최종 타입 검사와 production
패키징도 통과했다.

## 0.1.72081 적용 뒤 확인

21:56 KST에 검증 대상 payroll 창만 다시 로드했다. 확장 등록 경로는
`newdlops.gitsimplecompare-0.1.72081`이고 새 OUTPUT 기록에서 활성화를 확인했다.
사용자·전역 Git 실행 경로도 원래 Apple Git을 사용했다.

- 실제 소유 Git 세 건의 그룹 검사는 12~18ms, 구성원은 각각 1개였다.
  이후 1~3ms 안에 각 프로세스의 close가 기록됐다. 추가 Git·GitHub 취소에서도
  11~23ms의 그룹 검사와 실제 close가 확인됐다.
- 새 그래프의 최초 paint는 1,275ms, PR 80개 목록의 최초 완료는 5,413ms였다.
  반복 목록 완료는 5,382~6,740ms였으며 기존 커밋 2개를 재사용했다.
- 파일 41개·파일 댓글 28개의 PR 상세는 1,304ms, 파일 85개·파일 댓글 6개의
  상세는 1,323ms에 전송됐다. 목록의 후속 메타데이터 변경으로 상세 조회가
  다시 실행됐고, 취소된 실행의 close와 마지막 상세 전송도 확인했다.
- Changes의 실제 화면에서 변경 파일 87개와 stash 43개를 확인했다.
  status 적용은 176ms, 파일 통계 적용은 1,015ms였다.

Graph·PR 목록·Changes의 실제 화면은 검증 대상 Code 창 ID만 캡처해 확인했다.
PR 상세의 완료 전송은 기록됐지만 각 상세의 최종 paint 시간은 측정하지 않았다.

같은 새 host에서도 status 5,734ms·5,651ms·7,261ms의 성공 기록이 있었다.
실제 index 변화 감지로 전용 status index를 무효화한 기록도 한 번 있었다.
그 작성 주체나 위 실행의 내부 단계는 이 새 host에서 확인하지 않았으므로,
앞선 미추적 파일 탐색의 지연과 동일 원인이라고 단정하지 않는다.
간헐적인 초기 조회 지연까지 완전히 해결됐다는 결론은 내리지 않는다.

마지막 프로세스 snapshot에는 정리 뒤 남겼던 같은 Git PID 16개만 있었고,
새 일반 Git 실행은 없었다. 이는 해당 관찰 시점의 결과이며 무제한 기간의
누적 방지를 입증하지 않는다. 읽을 수 없는 Code workspace가 있을 때 감시자
정리가 보호 모드로 보류되는 동작도 관찰했다. 사용 여부가 불확실한 다른
프로세스를 강제로 종료하지 않았다.

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
- `affected-repositories/measurement.json`: 초기 지연이 있던 4개 저장소와 index 보존
- `actual-extension-git.trace.jsonl`, `actual-git-trace-summary.json`: 실제 확장 Git 내부 기록
- `trace-setting-backup.json`: 임시 경로 설정의 원본과 정확한 복원 확인
- `scoped-process-final-tests.log`, `scoped-process-final-types.log`: 최종 46개 검사와 타입 검사
- `scoped-package-verification.json`, `scoped-installed-verification.json`: 0.1.72081 패키지·설치 확인
- `scoped-release-verification.json`, `scoped-marketplace-final.json`: 공개 VSIX 일치와 최신 버전 조회
- `actual-ui-72080.log`, `actual-ui-72081.log`: 실제 사용자 창의 OUTPUT 보관본
- `graph-72081.png`, `pr-list-native-72081.png`, `changes-72081.png`: 검증 대상 창의 실제 표시

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
게시 직후 일반 Marketplace 버전 조회에는 0.1.72079가 표시됐고, 뒤의 재조회에서
최신 버전 0.1.72080 반영을 확인했다. 최초 설치 시에는 Code가 닫혀 있었으며,
이후 일반 사용자 창을 열어 위 실제 창의 검사를 진행했다.

0.1.72081 수정 커밋은 `05a0140`이고 `origin/main`에 푸시했다. 패키지는 124개 파일이며
소스·테스트·개발 문서를 포함하지 않는다. 사용자 VS Code 설치가 성공했고 설치된
package version과 번들 SHA-256은 production VSIX의 내용과 일치한다.

- 0.1.72081 VSIX SHA-256: `39145f7122d1163fd63a99db59aa2d275260007b431013addd4beecb82a544db`
- 0.1.72081 번들 SHA-256: `acd608e877b6d9c90ff2c5f87a769ec0b6fec31d8e04fbde76f265a3f27a1b3d`

같은 VSIX의 `vsce publish --packagePath`가 0.1.72081 게시 성공을 반환했다.
버전 지정 공개 VSIX의 SHA-256도 위 로컬 패키지와 일치했다. 초기 최신 버전 조회에는
0.1.72080이 남아 있었으나 마지막 재조회에서 최신 0.1.72081 반영을 확인했다.
Marketplace `lastUpdated` 값은 `2026-10-05T12:59:10.823Z`였다.

## 0.1.72082 후속 원인 확인과 수정 — 2026-10-06

0.1.72081에 남아 있던 재로드 후 간헐적인 status 지연을 계속 추적했다.
Mac과 SentinelOne은 재시작하지 않았으며, 수정 적용에는 검증 대상 Code 창의
Reload Window만 사용했다. 최초 0.1.72082 후보는 설치해서 계측했지만 게시하지 않았다.

### 확인한 원인

- 기존 상위 status 경로 외의 읽기 API가 실제 index의 stat 정보를 갱신할 수 있었다.
  text·buffer·stdin·stream의 실제 Git 회귀 검사 8개 중 7개가 수정 전 실패했다.
  모든 읽기 실행의 최종 환경에서 optional index 쓰기를 막고, 등록된 확장 소유
  index를 명시적으로 허용한 호출만 캐시 쓰기를 할 수 있게 수정했다.
- 세션 안에서 준비된 전용 index는 다음 Host로 이어지지 않았다. 미추적 파일의
  첫 디렉터리 탐색이 반복되었으며, 실 저장소의 초기 탐색은 수초가 걸렸다.
  이전 세션에서 Git이 준비한 전용 index를 확장 global storage에 원자적으로
  보존한다. 조회 결과를 저장하는 방식이 아니므로 이후 수정·stage·ignore·미추적
  파일은 매번 Git으로 다시 확인한다.
- 처음에는 실제 index의 전체 bytes·stat 식별자로만 복원을 허용했다. 실제 linked
  worktree index 31,803개 entry의 staging 의미는 동일한데 inode·크기·hash만 달라져
  준비된 탐색 캐시를 잃는 사례를 확인했다. 작성 주체는 확인하지 않았다.
  경로·OID·mode·merge stage·assume-valid·intent-to-add로 복원 가능 여부를 판별해
  metadata-only 갱신을 구분하고, 실제 Git index 경로가 바뀌면 재사용하지 않는다.
- 복원한 index의 tracked stat을 그대로 쓰면 늦어진 index mtime 때문에 racy-clean
  수정을 놓칠 수 있었다. 실제 index의 tracked stat으로 다시 맞추고 원본보다
  늦지 않은 mtime을 적용했다. trustctime을 껐을 때 같은 크기의 수정도 Git의
  전체 조회와 일치하는 회귀 검사로 확인했다.

전체 index v2/v3/v4와 SHA-1/SHA-256은 지원한다. split·sparse·skip-worktree 및
알 수 없는 형식은 세션 간 복원을 적용하지 않고 기존 조회 경로를 유지한다.
캐시는 32개 파일·128MiB·단일 32MiB·7일로 제한한다. 손상·쓰기 실패·동시 게시를
복구하며, 한 시간 지난 우리 UUID 게시 임시 파일만 회수한다. 실제 repository
index나 다른 프로세스의 파일은 캐시 저장·정리 대상으로 사용하지 않는다.

### 검사와 실제 창 결과

최종 수정 범위의 실제 Git 및 단위 검사 76개가 모두 통과했다. 타입 검사와
diff 공백 검사, production 빌드·패키징도 성공했다. 새 검사는 원본 index 보존,
stage/flags 무효화, metadata-only 복원, racy-clean 수정, legacy 캐시 바인딩,
split·sparse·linked worktree 결과, 손상·제한·동시 게시를 포함한다.

같은 fixture에서 dispose·reopen을 40회 반복했을 때 캐시는 한 개만 남았고,
세션 전용 파일 및 실행 중인 등록 Git 읽기는 남지 않았다. 원본 index bytes와
metadata도 유지됐다. 실제 Code의 무제한 장기 실행을 대신하는 검사는 아니다.

앞선 넓은 Node 검사 실행은 15분 상한에 도달하기 전 886개가 통과했고, 완료하지
못한 파일 구간을 이어 실행한 141개도 통과했다. 경계 파일 일부가 겹치며 이
실행은 최종 semantic identity 보강 전이었다. 최종 버전의 전체 일괄 검사 성공으로
집계하지 않고 위 최종 수정 범위의 76개 결과를 별도로 기록한다.

임시 Git 경로 설정은 원래 bytes와 hash로 복원했다. 설치한 번들의 임시 Trace2
계측도 복원한 뒤 production VSIX로 교체했고, 설치 파일과 검증 패키지의 hash가
일치했다. 아래는 임시 계측 없이 일반 사용자 창에서 나온 OUTPUT 결과다.

- 새 Host 활성화: `2026-10-05T15:46:28.531Z` (한국 시간 10월 6일 00:46).
- 시작 후 전용 index cache 복원 두 번 모두 `identity: staging`이었다.
- 변경 목록 87개는 새 Host에서 1,620ms에 적용됐다. 이후 조회는
  1,894ms·243ms·1,561ms·841ms였다. 파일 통계는 별도 실행이다.
- 그래프 최초 paint는 698ms, local-only 후속 paint는 전체 경과 765ms였다.
- stash 43개, worktree 9개(그중 linked 8개)가 표시되는 기록을 확인했다.
- PR 80개 목록은 첫 page 준비 6,783ms, pagination까지 완료 8,101ms였다.
  이번 변경은 해당 GitHub 네트워크 구간을 추가로 줄이지 않는다.
- 이 관찰 구간에서 status timeout은 없었다. 활성 파일의 이력 조회는 여전히
  Git 실행 3,516~7,814ms가 걸렸다. 이력 탐색까지 즉시 완료된다는 결론은 내리지 않는다.
- 실제 창 실행 전후 snapshot은 모두 기존 fsmonitor 16개·일반 Git 0개였다.
  다른 창/터미널 사용 여부가 불확실한 감시자를 강제로 종료하지 않았다.

이번 변경에는 화면 구조나 컨트롤 변경이 없다. 그래프 paint는 제품의 런타임
로그로 확인했으며 0.1.72082의 새 화면 캡처나 다중 viewport 검사는 수행하지 않았다.

### 최종 패키지와 자료

0.1.72082 production VSIX는 124개 파일이다. src·test·개발 문서와 임시 계측은
포함하지 않으며, 추출한 번들과 production 빌드·실제 설치 파일이 일치한다.

- VSIX SHA-256: `c407756b0f63c2249f76b07a1616e3e979cabe8880cbb911cd837b74dd65a930`
- 번들 SHA-256: `cb90e5a49a270966af25d499bf299c6074f885bc97ad50425abb05d2ad4380ab`

후속 원시 자료는 `/private/tmp/gsc-remaining-20261005`에 보관한다.

- `actual-staging-comparison.json`: 실제 index가 달라져도 staging 의미가 같은 사례
- `metadata-identity-before.log`: metadata-only 갱신 후 복원 실패 재현
- `final-cache-tests.log`, `final-cache-types.log`: 최종 76개 검사와 타입 검사
- `full-release-tests.log`, `remaining-release-tests.log`: 앞선 넓은 검사 실행의 범위와 상한
- `final-package-verification.json`, `final-installed-verification.json`: 최종 패키지·설치 일치
- `actual-trace-setting-verification.json`, `direct-profile-verification.json`: 임시 설정·계측 복원
- `actual-production-72082.log`, `final-runtime-verification.json`: 일반 빌드의 실제 사용자 창 기록
- `final-process-*-ui.txt`, `final-git-*-ui.json`: 실제 창 실행 전후 Git 프로세스 snapshot
