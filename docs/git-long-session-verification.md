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
