# 장기 사용 최적화 검증

버전: 0.1.72079. 기준: 0.1.72078 (`b2019a9`). 날짜: 2026-10-05.

| 작업 | 구현 | 검증 |
| --- | --- | --- |
| 1. 이전 PR·커밋 상세 취소 | 선택 변경·drawer 닫기·패널 숨김·창 포커스 해제 시 소비자 해제, 다른 공유 소비자 보호 | `graphDetailLifecycle`, PR drawer 닫기·재개·늦은 응답 검사, Git/GitHub 실제 자식 종료 회귀 검사 |
| 2. PR DOM 부분 갱신 | keyed DOM 재사용과 프레임 병합, 검색·IME·포커스·스크롤·파일 subtree 유지 | PR 목록·상세 브라우저 검사, 105개 파일 유지, 조회 횟수와 노드 identity 확인 |
| 3. 저장소 이름 warm cache | 설정 origin/include·HEAD·인증·환경 metadata로 무효화, warm 시 Git spawn 제거 | 동시 24건에 추가 `git config`/`gh repo view` 0회, 설정·인증·conditional include·linked worktree 변경 검사 |
| 4. Graph fingerprint 공유 | 진행 중 자동 조회 보존, 알림 폭주를 최신 후속 조회 한 번으로 병합 | 20건 burst에서 native 조회 2회, force·PR 게시 강도·수명 취소 회귀 검사 |
| 5. 커밋 헤더 중복 제거 | 요약과 전체 상세가 같은 헤더 Promise 사용 | 실제 Git `show -s` 1회, 요약/전체 메시지·해시 일치 |
| 6. 미추적 파일 I/O 제한 | 가상 커밋·hunk 모두 최대 4개 worker, 순서·전체 결과·취소 보존 | 실제 350개 파일의 결과·줄 수·hunk 유지와 최대 동시 읽기 4개 확인 |
| 7. Hunk 조회 공유·파일별 무효화 | 같은 파일의 진행 조회 공유, 문서 이벤트는 파일 단위, HEAD/index는 전체 무효화, 이전 실행 close barrier | 두 editor의 실제 Git diff 호출 4회, 한 파일 변경 후 2회만 추가, 다른 파일 line ID 유지, 종료 대기 검사 |
| 8. Graph 증분 계산·전송·렌더링 | 128행 checkpoint, revision delta, 변경 행/간선만 DOM 갱신, 누락 시 현재 모델 재게시 | 독립된 이전 commit의 전체 layout과 동일성, merge/가상 행/압축/HEAD/순서 변경, DOM·SVG·포커스·스크롤 유지와 resync 검사 |
| 9. 완료 캐시 상한 | 미추적 통계 4,096개/1MiB, PR 상세 32개/8MiB/30초 | 4,300개 실제 파일과 80개 상세 방문, byte 상한·LRU·큰 현재 상세·계정 전환 확인 |
| 10. GitHub metadata 비동기화 | 동시 metadata probe 공유, 요청 환경은 await 전에 복사, 관찰 실패 시 공유·완료 캐시 우회 | queued 환경 고정, 인증 파일 변경, 대기·수명·슬롯 회귀 검사 |
| 11. gh PATH 우선 탐색 | 명시 실행 파일 → 요청 PATH → login shell → 기본 경로 | shell 초기화 없는 PATH 조회, override, 상대/빈 PATH, 잘못된 directory 후보, 취소·fallback 검사 |

PR 80개 목록, 모든 커밋·파일·댓글의 pagination, Git 수정 명령의 보호 정책을 유지했다.
새 설정을 강제로 적용하거나 stash 표시 값을 바꾸지 않았다.

## 성능 비교

`node scripts/benchmark-graph-layout.mjs b2019a9`는 이전 소스와 현재 소스를 따로 번들해
같은 5,000개 커밋을 250개씩 20페이지로 처리한다. 최종 행·간선·색·레인이 완전히 같아야 성공한다.

전체 재계산은 누적 52,500행을 처리하며, 증분 계산은 선형 이력 6,292행, 머지 이력 7,316행을 처리했다.
레이아웃 CPU 시간은 이 작은 fixture에서 대체로 비슷했다. 주요 효과는 전송과 실제 DOM 재생성 감소다.
4,000행 뒤 200행을 추가할 때 기존 행은 다시 전송하지 않으며 새 행 200개와 바뀐 경계 간선만 전송한다.
같은 최종 모델의 JSON은 전체 1,032,001바이트, 증분 49,634바이트로 전송량이 95.2% 줄었다.
이는 해당 fixture의 전송량 비교이며 실제 사용 중 지연 전체가 같은 비율로 감소한다는 뜻은 아니다.

## 기능·시각 검증

최종 `npm test`는 1,006개 통과, 실패·건너뛰기 0개였다. `npm run check-types`도 통과했다.
전체 Chromium 검사는 99개 통과했다. 마지막 오류 화면 확인을 보강한 뒤 PR 목록·상세 검사
11개를 다시 실행해 모두 통과했다. 오류 화면은 drawer 진입 애니메이션이 완료된 뒤
제목·branch·관련 커밋·재시도 버튼의 좌표와 내부 가로 overflow를 확인하고 캡처한다.
실제 Chromium에서 390×844, 768×1024, 1440×900의 PR 목록·상세·오류·밀집 압축 그래프를 확인했다.
좁은 drawer에서 파일명은 기존 tooltip을 유지하며 줄이고, 댓글·줄 수·재시도 버튼은 표시 영역 안에 남긴다.
PR 상세 3개 크기에서 Axe 검사도 통과했다. 추가 VS Code 테스트 창은 띄우지 않았다.
Windows 실행은 이 macOS 검사에 포함되지 않는다. 사용자 환경의 장기 사용 지연은
배포 버전을 열린 창에 다시 로드한 뒤 별도로 확인해야 한다.

## 배포 패키지

`vsce package --no-yarn`의 production 빌드가 성공했다. `gitsimplecompare-0.1.72079.vsix`는
124개 파일, 862,786바이트이며, 번들과 신규 JS/CSS가 현재 빌드와 일치함을 확인했다.
소스·테스트·개발 문서는 패키지에 포함하지 않는다.

- VSIX SHA-256: `86974fe0b85deeb3621d73c546e0a415398fd959deb3e0420793f465121fdc68`
- 번들 SHA-256: `c3e6ffb6a337417a077b58446943f09132055167f082f89ebef2d4f03914fefc`
