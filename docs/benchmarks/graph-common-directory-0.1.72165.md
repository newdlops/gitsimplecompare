# Graph 공통 Git 디렉터리 동시 조회 — 0.1.72165

기준은 `0.1.72164`, `f93454d51025a165853ad0ed6821fd2d404f7ed0`다.
이번 수정은 Graph 카탈로그의 동시 초기 요청에만 적용한다. 기존 Native ref 이름
조회·완료 캐시·작업트리 생성과 정리는 유지한다. 전체 작업·Graph 지연 개선의
완료를 주장하지 않는다.

## 동작

기존에는 원격 ref 읽기를 공유하기 전에 같은 root의 모든 소비자가 각각
`rev-parse --git-common-dir`을 실행했다. 새 구현은 기존 `SharedGitRead`를 사용해
진행 중인 같은 root의 경로 조회 한 번을 공유한다. 소비자 수와 실제 Native 실행
상태를 함께 기록하므로 마지막 취소 뒤에도 close 전에는 교체 프로세스를 시작하지
않는다. 소비자와 실행이 모두 끝나면 진행 중 레코드를 해제한다. 성공한 경로의
기존 캐시 범위와 Native 이름 해석은 바꾸지 않는다.

orphan 확인은 이미 예약한 sweep 한 개로 합친다. 읽기 취소·timeout·버퍼 제한·
종료 대기 오류는 fallback 성공으로 바꾸지 않는다. 이미 캐시가 있어도 취소된
소비자는 성공 결과를 받지 않는다. 일반 경로 해석 실패의 기존 root 격리는 유지한다.
동시 경로 조회가 실제 공유되면 OUTPUT에 `graph common directory read shared`를
한 번 남긴다. 새로운 상시 worker·감시자·장기 결과 캐시는 추가하지 않는다.

## 비교 조건

실제 Captain의 원격 ref 2,113개를 읽기만 했다. 원본 index·HEAD·설정·packed refs의
바이트와 inode·mtime·ctime, 전체 Native ref의 fingerprint가 모든 실행에서 같아야
성공으로 인정했다. 원격 카탈로그는 독립 Native 출력과 모든 반환값을 비교했다.
사용자의 refs·index·설정·작업 파일에 쓰는 명령은 실행하지 않았다.
양쪽 실행에서 system/global Git 설정은 격리하고 저장소의 local 설정은 유지했다.

동시 소비자 1/4/32개, 일반 지연·CPU·별도 RSS에 대해 각각 B/A/A/B 순서로 실행했다.
조건·source당 독립 프로세스 두 개이며, 프로세스당 세 round의 중앙값을 사용했다.
각 round는 새 catalog 인스턴스와 새 Native ref 조회를 사용한다. 파일시스템은 warm이다.
36개 프로세스·108개 round가 모두 완료됐고 반환 객체의 소비자 간 분리도 확인했다.
소스 656개 파일의 해시를 고정했다. 실제 고정 파일 수는 JSON/원시 state의 manifest를
기준으로 하며 버전 metadata는 검증 후 변경했다.

## 결과와 한계

아래 값은 두 독립 프로세스 중앙값의 중앙값이다. CPU는 Node와 종료·wait된 Native
자식의 합계이며 시스템 전체 CPU가 아니다. 시간과 CPU는 별도 실행 결과다.

| 동시 요청 | 일반 지연 ms, 기준 → 후보 | 소유 CPU ms, 기준 → 후보 | Git 호출/round, 기준 → 후보 |
| ---: | ---: | ---: | ---: |
| 1 | 100.95 → 58.54 | 41.79 → 45.43 | 2 → 2 |
| 4 | 58.46 → 75.77 | 77.00 → 64.76 | 5 → 2 |
| 32 | 155.52 → 45.54 | 257.00 → 52.34 | 33 → 2 |

32개 동시 요청은 이 표본에서 지연 -70.7%, CPU -79.6%였다. 반대로 4개 요청의
지연은 +29.6%, 단일 요청 CPU는 +8.7%였다. 호스트 부하를 통제하지 않은 두
프로세스 표본이므로 모든 조건의 속도·CPU가 줄었다고 해석하지 않는다. 특히
32개는 stress 조건이며 실제 사용자 요청 빈도를 측정한 것이 아니다.

별도 RSS에서 round별 **관측 최대**의 세 round 중앙값, 다시 두 프로세스 중앙값은
1개 요청 68.99 → 71.24MiB, 4개 75.75 → 72.20MiB, 32개 95.77 → 84.94MiB였다.
모든 observer가 complete로 끝났지만 round당 표본은 2~4개뿐이고, 최대 실제 간격은
210.929ms, scan은 171.714ms였다. 짧은 Native 메모리 증가는 놓칠 수 있다.
실제 peak·물리 메모리·전체 Graph 보유 heap 감소의 근거로 사용하지 않는다.

실험·프로세스별 원문 수치와 hash는 [JSON](graph-common-directory-0.1.72165.json)에
보존한다. 전체 원시 기록은 `/private/tmp/gsc-goal66-common-paired-state.json`과
각 report에 있다. 처음의 작은 pilot은 기능 확인용이며 정식 표에 섞지 않았다.

## 기능 검증

- 새 회귀 8개는 기준 소스에서 모두 assertion 실패했고 후보에서 통과했다.
  Native cold burst, 한 소비자 취소, 마지막 취소 후 실제 close 대기, timer burst,
  timeout·버퍼 제한·종료 대기 및 취소된 cached consumer를 포함한다.
- 관련 검사 85개와 Apple Git에서 추가 31개가 통과했다. linked worktree의 지연된
  소비자 합류, remote epoch, snapshot·PR 이동·lifecycle 경계도 포함한다.
- 실제 production HTML/CSP/JS의 버튼과 등록 callback에서 push·pull·fetch·interactive
  rebase·무변경 fetch·checkout·PR squash·PR replay 8개를 수행했다. 각 사례의
  80개 PR 목록, Native 결과·HEAD·ref·local-only와 로컬 변경 보존이 일치했다.
  소유한 1,000파일·1,800커밋·100브랜치 fixture이며 성능 비교로 사용하지 않았다.
- PR replay 완료 화면을 390/768/1440px에서 직접 확인했다. HEAD와 staged/ongoing
  표시를 확인했으며 좁은 화면의 기존 가로 canvas는 유지된다. 레이아웃·스타일을
  변경하거나 새로운 접근성/모바일 디자인 감사를 수행한 것은 아니다.
- TypeScript 검사 통과. 사용자 VS Code 창의 포커스 전환이나 강제 reload는 하지 않았다.

Native 결과는 `/private/tmp/gsc-common-dir-related.log`, Apple 결과는
`gsc-common-dir-apple.log`, 실제 버튼 결과는 `gsc-goal66-functional-buttons.json`이다.
처음 취소 fixture의 잘못된 대기를 고친 기록은 보존했으며 취소된 첫 실행을 제품
회귀 근거로 세지 않는다. 최종 기준 회귀 기록은 `gsc-common-dir-baseline-eight.log`다.
