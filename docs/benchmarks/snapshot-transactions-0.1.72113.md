# 0.1.72113 PR 복구 기록·Git 작업 검증

기준은 0.1.72112(`b9d8ed66f58156095e094f2ec1d5e4ac4d07cd9b`)다.
동일한 harness를 이전 commit과 작업 트리 source에 연결했다. 실행별 source 지문,
두 snapshot 측정쌍, Git 작업 원본, 실제 renderer 결과와 테스트 로그는
[JSON](./snapshot-transactions-0.1.72113.json)에 보존했다.

## PR snapshot 기록 비용

지원 Git에서는 immutable snapshot과 latest symbolic pointer 두 개를 한 transaction으로
기록한다. ref 쓰기 프로세스는 3→1이다. 인덱스를 쓰지 않는 `update-ref`, `commit-tree`,
`mktree`에는 파일 감시자 준비를 요청하지 않는다. 인덱스 명령의 기존 정책은 유지한다.

실제 snapshot ref와 Undo JSON을 기록하는 전체 `createSnapshot`을 측정했다.
워밍업 1회 뒤 각 5개 표본의 중앙값이며, 같은 main에 반복 기록하고 모든 이전 snapshot,
최신 포인터, HEAD 및 index 보존을 확인했다. 임시 저장소의 `core.fsmonitor=false`를
확인하고 production monitor 정책을 활성화했다. 네트워크는 사용하지 않았다.

| 측정쌍 | 기록 시간 ms | Node CPU ms | Git 프로세스 수 |
| --- | ---: | ---: | ---: |
| 첫 측정 | 2605.69 → 300.00 | 11.29 → 5.57 | 5 → 2 |
| Git별 완료 시간·성공 여부를 추가한 최종 측정 | 470.78 → 1195.44 | 10.22 → 6.31 | 5 → 2 |

두 측정쌍 모두 ref 쓰기 두 번과 감시자 config 조회 한 번이 사라졌다. Git 프로세스는
60% 감소했고, Node CPU 중앙값은 각각 약 51%, 38% 감소했다. Node CPU는 호출 조립과
결과 처리만 포함하며 Git CPU·전체 확장·전체 시스템 자원 수치가 아니다.

기록 시간은 반대 방향으로 변했다. 최종 측정의 개별 Git 명령은 모두 성공했고
monitor fallback도 없었다. 따라서 snapshot의 보편적인 지연 개선율은 주장하지 않는다.
프로세스 실행 지연이 달라지는 환경에서 호출 수·Node CPU 감소와 경과 시간을 구분한다.

재현: `node scripts/benchmark-pr-snapshots.mjs <result.json>`.
기준 source는 `GSC_BENCH_SOURCE_REF=b9d8ed66f58156095e094f2ec1d5e4ac4d07cd9b`를 지정한다.

## Git 작업 9종과 Graph

파일 1,000개·기본 commit 1,000개·곁가지 100개의 임시 저장소와 로컬 bare 원격을 썼다.
다른 Git 회귀 검사와 겹치지 않게 CLI 측정을 차례로 실행했다. 아래는 각 작업 1회 표본이며
전송 네트워크가 없고 머신 부하는 통제하지 않았다. 전체 Git 수에는 Graph 후속 조회도
포함한다. 감시자 config cache 만료와 비동기 보조 조회로 총 프로세스 수가 달라질 수 있다.

| 작업 | 작업 시간 ms | Graph 갱신 ms | 전체 Git 수 |
| --- | ---: | ---: | ---: |
| push | 2935 → 4434 | 187 → 178 | 25 → 25 |
| pull | 1053 → 1103 | 287 → 390 | 16 → 16 |
| fetch | 382 → 380 | 213 → 203 | 8 → 8 |
| rebase | 2235 → 1935 | 311 → 300 | 28 → 28 |
| 브랜치 squash merge | 2419 → 1933 | 499 → 281 | 29 → 29 |
| PR squash cherry-pick | 3113 → 2517 | 401 → 612 | 39 → 37 |
| PR cherry-pick | 2793 → 2262 | 319 → 306 | 40 → 39 |
| cherry-pick | 86 → 71 | 313 → 296 | 13 → 14 |
| checkout | 345 → 251 | 246 → 173 | 10 → 10 |

PR 작업 단계의 Git 수는 squash 27→24, cherry-pick 28→26이었다. 두 경우 모두
기존 symbolic pointer 쓰기 두 번이 없어졌다. 단일 표본에서 모든 작업이 빨라졌다고
일반화하지 않는다. 이번 변경은 Graph renderer의 레이아웃이나 UI 코드를 바꾸지 않는다.

별도 headless Chromium 실행에서도 9종 모두 production Graph HTML/CSP/JS를 사용했다.
새 Git 조회와 host의 HEAD·부모·refs가 같고, 실제 300행 DOM의 HEAD 배지·refs도
일치했다. 이 실행은 복구 검사와 병렬이었으므로 정확성 근거로만 사용한다.
OS 창·포커스를 요청하지 않았고 실제 VS Code Host 검증을 수행했다고 주장하지 않는다.

재현: `GSC_BENCH_MONITOR_POLICY=1 node scripts/benchmark-git-operations.mjs <result.json>`.
실제 renderer를 연결할 때만 `GSC_BENCH_LIVE_RENDERER=1`을 추가한다.

## 실패·호환성·패키지

- 실제 Git에서 잠긴 latest pointer와 reference-transaction hook 거부가 기존 snapshot,
  latest pointer, Undo 기록을 변경하지 않는지 확인했다. 반복 기록은 이전 immutable
  commit을 보존한다. `--no-deref`로 symbolic pointer 자체를 갱신하고 snapshot 생성은
  기존 ref 덮어쓰기를 허용하지 않는다.
- hook이 미지원 명령과 같은 문구를 출력해도 재실행하지 않는다. 정확한 parser 미지원
  한 줄만 기존 경로로 전환한다. 미지원 증거 cache는 최대 32개·10분이며 실행 경로와
  관련 환경의 해시로 구분한다. 실제 구버전 binary를 설치하지 않고, 실제 Git을 호출하는
  wrapper로 `start`와 `symref-update` 미지원 응답을 각각 검증했다.
- transaction의 prepare는 ref 잠금·검증 실패 때 함께 중단한다. 구버전 fallback은 기존
  개별 쓰기 계약이다. 동시 reader의 전체 ref 조회가 하나의 원자적 snapshot이라고
  주장하지 않는다. Git의 계약은 [공식 update-ref 문서](https://git-scm.com/docs/git-update-ref/2.50.0)를 따른다.
- 관련 복구·Undo 100개 사례를 완료했다. 첫 묶음은 92개 통과 뒤 runner의 900초 제한으로
  중단됐고, 통과한 이름을 제외한 나머지 8개만 별도로 실행해 모두 통과했다. 첫 묶음을
  전체 통과로 보고하지 않는다. 최종 snapshot·구버전·hook 보호 7개 재검사도 모두 통과했다.
- 실제 index-free 명령 3개가 인덱스·HEAD를 보존하고 추가 monitor probe/daemon을 만들지
  않는지 확인했다. 기존 index 조회의 monitor 시작·실패·취소 검사도 통과했다.
- TypeScript, production bundle, VSIX 생성과 런타임 파일 124개의 원본 일치 확인을 통과했다.
  개발 source·test·scripts·docs는 패키지에서 제외했다. 전체 저장소 `npm test`, 새 UI 시각
  감사, visible Host 실행 및 Marketplace 상태 점검은 수행하지 않았다.

이전 Graph coordinator의 CPU·복사·heap 개선과 포커스 간섭 제거는
[0.1.72112 검증](./graph-refresh-0.1.72112.md)에 별도로 기록되어 있다.
