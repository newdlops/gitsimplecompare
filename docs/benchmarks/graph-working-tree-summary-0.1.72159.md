# Graph 작업트리 요약 — 0.1.72159

Graph의 가상 행은 HEAD와 변경 존재만 사용하지만, 이전에는 Changes와 같은
전체 미추적 파일 목록을 읽었다. 큰 작업트리에서는 cold status 분할 탐색과
별도 UNTR 준비까지 실행됐다. 이제 Graph만 요청하면 Native porcelain의
디렉터리 요약과 `--no-renames`로 필요한 값만 읽는다. Changes의 실행 중·완료
전체 조회는 공유하며, 요약 뒤 전체 목록이 필요하면 다음 한 번의 조회로
전환한다. 같은 private index에 동시 쓰기를 만들지 않고 반환 값은 격리한다.

또한 stage 의미와 저장소 identity가 같은 source index의 metadata 변경에도
준비한 private UNTR를 유지한다. 새 source의 stat 필드·checksum·racy-clean
시각을 다시 적용하고 Native Git이 파일 수정·ignore 변경을 검증한다.
실제 stage 변경, 미지원 형식·flags·metadata 교체는 기존 검증·복구로 돌아간다.
사용자 index와 Git 설정을 수정하지 않는다. 새 상태 전환은 OUTPUT의
`private status index metadata refreshed`에서 확인할 수 있다.

## 비교 조건과 결과

기준은 `f4f0745934d63e32601d19dad92614ecaf5e5a42`(0.1.72158)다.
같은 harness를 기준 archive와 고정한 후보에 연결했다. 일반 시간·CPU·메모리를
별도로 실행하고 각 규모·mode마다 B/A/A/B로 source당 두 번 비교했다.
각 실행은 initial, 새/기존 upstream push, pull 3종, fetch 4종, rebase,
squash merge, no-ff merge, PR squash·commit별 적용, cherry-pick,
로드된/로드되지 않은 checkout의 18개 시나리오를 포함한다.

일반 fixture는 파일 1,000개·이력 1,000개·side branch 100개다. 대형 fixture는
읽기 전용 원본의 객체를 빌린 별도 작업트리로 파일 30,311개(275MB),
캡처한 ref 2,665개·로컬 branch 164개를 재현한다. 모든 쓰기와 원격 수신은
소유 임시 저장소 안에서만 수행한다. 실제 GitHub/WAN·사용자 dirty tree의
작업 시간을 측정한 것은 아니다.

아래 값은 실행별 합계의 중앙값이다. RSS는 각 실행에서 관측한 **같은 시점
프로세스 RSS 합계** 중 가장 큰 값의 중앙값이며, 서로 다른 프로세스 peak를
더한 값이 아니다.

| 비교 범위 | 0.1.72158 | 후보 |
|---|---:|---:|
| 일반: 서비스부터 최종 host-message frame 합계 | 8,170ms | 8,288ms |
| 일반: 별도 소유 CPU 합계 | 8,666ms | 8,813ms |
| 일반: 최대 관측 RSS 합계 | 728.6MiB | 638.8MiB |
| 대형: 서비스 처리시간 합계 | 16,482.5ms | 17,471.5ms |
| 대형: 서비스부터 최종 host-message frame 합계 | 33,990.5ms | 28,613.5ms |
| 대형: Git 실행 수 합계 | 350 | 285.5 |
| 대형: 별도 소유 CPU 합계 | 47,467ms | 36,709ms |
| 대형: 최대 관측 RSS 합계 | 871.2MiB | 812.7MiB |

대형 최종 반영 합계는 약 16%, CPU는 약 23%, 최대 관측 RSS 합계는 약 7%
감소했다. 일반 규모 시간·CPU는 각각 약 1%·2% 증가했다. 표본 수가 작고
시스템 부하에 따른 편차가 있어 통계적 유의성이나 모든 작업의 개선을
주장하지 않는다. 특히 대형 initial은 884.5→1,400ms로 늘었다. 첫 이력은
계속 별도로 게시하지만 단일 Native UNTR 준비가 첫 상태 반영까지 걸린다.

### 대형 작업별 서비스부터 최종 frame 중앙값

| 시나리오 | 이전 ms | 후보 ms |
|---|---:|---:|
| initial | 884.5 | 1,400 |
| push | 2,826 | 879.5 |
| push-tracked | 1,480.5 | 1,016 |
| pull | 1,763 | 1,833 |
| pull-new-history | 1,850.5 | 3,084 |
| pull-known-history | 1,644.5 | 1,922.5 |
| fetch | 1,811 | 616.5 |
| fetch-new-history | 2,514 | 787 |
| fetch-known-history | 1,794 | 642.5 |
| fetch-no-change | 1,096.5 | 597.5 |
| rebase | 2,430 | 3,426 |
| merge | 1,967.5 | 1,967 |
| merge-no-ff | 1,178 | 872.5 |
| PR squash | 3,727 | 1,078.5 |
| PR commit별 적용 | 3,340 | 3,233.5 |
| cherry-pick | 854 | 1,653.5 |
| checkout | 925 | 697 |
| checkout-unloaded | 1,904.5 | 2,907 |

느려진 pull·rebase·cherry-pick·범위 밖 checkout을 원래 전체 목표의 남은
작업으로 유지한다. mutation 경로는 수정하지 않았다. 일반·대형의 모든
원시 per-case 값, 고정 source/harness hash와 측정 한계는
[JSON 보고서](graph-working-tree-summary-0.1.72159.json)에 보존한다.

## 검증과 한계

- 최종 시간·CPU·메모리 비교 432개 사례가 독립 Native branch·HEAD·tree·부모·
  원격 목적 ref와 최종 production HTML/CSP/JS의 HEAD/ref/local-only 검사를
  통과했다. 최신 frame 완료 뒤에만 사후 Native 검증을 실행한다.
- 관련 Node 84건과 타입 검사를 통과했다. 동시 전체/요약 소비자, 조회 전환,
  변경 세대, 취소, 전체 파일 목록, ignore, staged/unborn/conflicted index,
  원본 index byte·inode·mtime·ctime 보존을 포함한다. index 형식 검증은
  SHA-1/SHA-256·v2/v3/v4·미지원/손상·UNTR 요구를 다룬다.
- 이전 cold scan 검사 2회는 timeout으로 실패했다. 기록을 보존하고 deadline을
  완화하지 않았다. 별도 계측 없는 전후 B/A/A/B 4회와 최종 전체 관련 그룹은
  모두 통과했다. 첫 테스트 오타 실패도 최종 검증에 포함하지 않는다.
- 초기 후보 A의 metadata 캐시 손실, B의 사후 oracle/frame 겹침, C의 불완전한
  메모리 관측은 진단 자료로만 남겼다. C의 완료된 시간·CPU 비교는 유지하고,
  메모리는 오류 원문 보존을 보완한 D에서 전후 전체 8회를 완료했다. 불완전
  관측을 정상 peak로 사용하거나 실제 측정 실패 이유를 추측하지 않는다.
- CPU는 Node/Playwright transport, OS가 wait한 Native 자식과 같은 PID의
  Chromium counter다. RSS는 실제 표본 간격과 누락 한계를 함께 기록한다.
  짧은 자식·표본 사이 peak 누락과 공유 페이지 중복이 가능하며, 물리 메모리나
  retained heap을 증명하지 않는다. renderer는 시나리오마다 새로 연다.
- 실제 버튼·등록된 callback도 일반/대형 각각 8종, 합계 16건을 통과했다.
  모든 화면에 PR 80개를 표시하고 Native 결과·HEAD/ref/local-only를 확인한다.
  첫 대형 pull은 fixture에 합성 main의 remote-tracking ref가 없어 실패했다.
  준비 단계에서 원래 게시된 main ref와 Native upstream을 확인한 뒤 8종을
  모두 재검증했다. incoming 객체를 미리 fetch하거나 제품 액션을 대체하지
  않는다. 이 버튼 검사의 시간은 전후 성능 증거로 사용하지 않는다.
- UI 리소스·스타일은 바꾸지 않으며 foreground Host,
  OS 포커스 변경, 강제 reload와 별도 Marketplace 점검은 하지 않는다.

## 패키지

production build·패키징과 126개 runtime 파일 대조를 통과했다.
0.1.72158 대비 변경 runtime은 `dist/extension.js`뿐이며 rebase helper와
기존 웹뷰 리소스는 동일하다. VSIX는 1,019,601바이트이고 SHA-256은
`e258cbc582ba4cd0cda2c33a21a0403b849c4bf321ecc76d8043c6fbabb522c3`이다.
측정한 다섯 제품 소스 파일의 hash가 패키징 소스와 같은지 확인했다.
