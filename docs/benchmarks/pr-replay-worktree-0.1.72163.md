# PR 재생용 작업트리 준비 — 0.1.72163

기능·성능·산출물 검증 결과다. 기준 소스는
0.1.72162, `e6f02584f861abda1521c5f9a357241291bb16eb`다.

## 동작과 안전 조건

로컬 변경을 보존하면서 PR 커밋을 유지하는 cherry-pick/revert에서,
안전 조건을 확인한 큰 저장소의 임시 작업트리는 전체 파일 checkout을
생략한다. Native index와 skip-worktree 표시를 준비하고 기존 Native
cherry-pick/revert 엔진을 그대로 사용한다. 원래 작업트리의 index/config를
변경하거나 별도 patch 적용 엔진을 도입하지 않는다.

- 원래 index가 5,000~50,000항목이고 적용 커밋이 512개 이하일 때만
  검토한다. 실제 index 경로 출력은 NUL 바이트로 파싱하고 선택 경로를
  50,000개·8MiB로 제한한다. 지원하지 않는 index/출력은 전체 checkout이다.
- 원래 저장소와 새 detached 작업트리 양쪽의 유효 설정을 확인한다.
  conditional include, hook, 외부 filter/merge driver, attributesFile,
  sparse/split index, 서명과 사용자 지정 Git 환경 경계를 확인한다.
- 상대 hook 경로는 시작 tree와 적용 커밋의 모든 상위 경로까지 확인한다.
  추적 symlink를 거쳐 외부 hook으로 이어지는 경우를 허용하지 않는다.
  UTF-8 변환 중 바이트를 잃은 경로도 빈 디렉터리로 판정하지 않는다.
- 충돌·결과 반영 실패로 작업트리를 보존할 때는 남은 S-tag 파일을
  Native checkout-index로 펼친다. 이미 있는 수동 파일과 H-tag 삭제를
  덮지 않는다. 복원 실패 시 남은 의무를 v2 복구 기록으로 보존하며,
  해당 기록을 모르는 구버전은 자동 재개하지 않는다.
- 재개 때 같은 출처와 Native 작업 상태를 확인하고 파일 복원을 재시도한다.
  실패한 복구나 사용자 stash/snapshot을 지우지 않는다. 기존 branch/HEAD
  비교, 변경 보존, Undo 경계를 유지한다.

새 장기 cache, timer, 파일 감시자나 상시 worker는 추가하지 않는다.
준비·전체 checkout 선택·복원·복원 실패는 기존 OUTPUT 채널에 기록한다.

## 기능 검증

- 관련 Node 검사 81건 통과: Native 결과 tree·작성자·메시지·부모, revert,
  staged/unstaged/untracked 변경 보존, 실제 충돌·fresh service 재개,
  복원 재시도 중 수동 편집, Undo, 작은 저장소와 특수 설정 fallback.
- macOS 기본 Git에서 추가 hook 회귀 3건 통과. 이전 21건 호환성 검사도
  통과했으나, 보강된 최종 소스의 전체 24건 재실행으로 표기하지 않는다.
- 새 hook 회귀 3건은 보강 전 후보에서 실제 assertion 실패를 재현했다.
  Native 전체 checkout이 추적 symlink 경로의 hook을 실행하는 대조 사례를
  포함한다. raw 경로 fixture는 APFS의 파일명 생성 제약과 구분해 Git config
  원본 바이트 손실을 검증한다.
- TypeScript 검사 통과. 실제 브라우저 검증은 아래 비교와 최종 기능 행렬의
  완료 여부를 별도로 확인한다.

## 비교 조건

대상 입력은 30,311파일·72,720커밋·164개 원래 로컬 브랜치의 캡처된 이력에
합성 PR 3커밋과 미추적 변경 파일 하나를 둔다. 80개 PR 카드를 production
HTML/CSP/JS로 렌더한 뒤 실제 버튼·등록 callback·Native Git·최종 frame을
연결한다. GitHub 목록 metadata, VS Code 창/전송/picker는 대체한다.

원본 Captain object는 읽기만 하고 쓰기는 소유 임시 저장소에서 수행한다.
격리 입력의 hook은 비어 있다. **실제 Captain의 추적 Husky hook 설정에는
기존 전체 checkout을 유지하므로 이 조건의 속도 개선 근거가 아니다.**

준비 부하를 줄이기 위해 완전히 펼친 소유 입력 저장소 하나를 재사용한다.
성공한 각 별도 프로세스 실행 후 Native switch로 원래 브랜치로 돌아가고,
소유 Git metadata를 복원한다. 원래 index/config 바이트, 모든 ref와 HEAD,
전체 Native clean 상태, 외부 worktree 부재가 일치해야 다음 실행을 허용한다.
실패하면 해당 입력을 보존하고 이후 표본을 실행하지 않는다.

각 표본은 새 Node 프로세스에서 정상 초기 Graph/PR 로드를 마친 뒤 클릭한다.
이전 실행의 앱 cache는 공유하지 않으며 OS 파일 cache는 따뜻하다. 입력 검증과
복원은 클릭 구간 밖이다. cold-start 성능이나 실제 GitHub 전송 시간은 아니다.
기준의 임시 PR 작업트리는 매번 Native가 새로 전체 checkout·제거한다.

일반 시간, 소유 CPU, 별도 합산 RSS 관찰은 각각 before/after/after/before다.
source·모드당 별도 프로세스 표본은 2개다. 메모리 실행의 시간/CPU는 진단용이며
일반 비교에 섞지 않는다. 외부 머신 부하는 통제하지 않는다.

## 측정 결과

아래는 source·모드당 두 별도 프로세스 표본의 중앙값이다. 시간·CPU 8건과
별도 RSS 4건 모두 Native 결과, 최종 HEAD/ref/local-only 표시, 변경 파일 내용과
상태가 일치했다. 다음 표본을 위한 입력 복원 12건도 검증했고 소유 입력은 정리했다.

| 항목 | 기준 | 후보 | 변화 |
| --- | ---: | ---: | ---: |
| 클릭→handler 완료 ms | 142,730.5 | 3,850.5 | -97.3% |
| 클릭→최종 frame ms | 145,050.5 | 5,221.0 | -96.4% |
| worktree 명령 누적 ms | 140,440.5 | 338.5 | -99.8% |
| 소유 CPU ms | 40,500.1 | 4,381.8 | -89.2% |
| 종료·wait된 Native 자식 CPU ms | 28,656.1 | 2,574.0 | -91.0% |
| benchmark Node CPU ms | 1,246.7 | 816.7 | -34.5% |
| Chromium CPU ms | 10,597.3 | 991.1 | -90.6% |

설정·index 안전 조건 확인 때문에 Git 호출 수는 기준 38/41회에서 후보
45/45회로 증가한다. 속도 이익은 전체 파일 생성·정리 I/O 감소에서 나온다.
기준 frame 원문은 153,034/137,067ms, 후보는 4,432/6,010ms다.
외부 머신 부하를 통제하지 않은 두 표본이므로 이 비율을 모든 환경이나
다른 Git 액션의 개선률로 사용하지 않는다. CPU 합계는 benchmark Node,
종료·wait된 Native 자식과 완전히 관측된 Chromium 누적 차이이며 시스템 전체 CPU가 아니다.

별도 실행에서 같은 시점의 Node·Chromium·소유 Native RSS 합계 중 최대
**관측 표본**의 중앙값은 934.6→691.9MiB(-26.0%)다. 실제 최대값, 물리 메모리나
retained heap의 측정은 아니다. 50ms 목표 간격의 관찰에서 표본 수는 순서대로
303/18/26/384개, 최대 실제 간격은 약 1,871ms였다. 후보 두 실행에도 약
944/648ms 공백이 있어 짧은 메모리 증가를 놓칠 수 있다. 원문 4개의 complete와
SHA-256을 확인했으며 전체 메모리 감소 완료를 주장하지 않는다.

최종 비교는 [JSON](pr-replay-worktree-0.1.72163.json)에 보존한다.
원문과 실행 기록은 `/private/tmp/gsc-goal63e-buttons-state.json`,
`/private/tmp/gsc-goal63e-measurements.json`에 있다. hook 조건을 보강하기 전
후보의 중단 표본과 sandbox 기동 실패는 위 수치에 포함하지 않는다.

## 최종 기능 검증과 산출물

0.1.72163 소스에서 소형·대형 저장소 각각 18개 변형, 총 36건의 Native Git과
production DOM 검사를 통과했다. push·pull·fetch·rebase·merge·PR squash/replay·
cherry-pick·checkout 및 각 이력/로드 변형을 포함한다. Native 작업 결과·브랜치·
HEAD/ref/local-only 표시가 일치하며 unavailable/paused status도 성공으로 세지 않는다.
이 기능 검사의 시간은 별도 성능 비교로 사용하지 않는다.

측정 후 버전 metadata만 변경했으며 고정한 검증 소스 667개 파일은 같은
바이트다. TypeScript·production build·diff 검사를 통과했다. 원문은
`/private/tmp/gsc-goal63d-final-matrix-state.json`에 남긴다.

검증한 `gitsimplecompare-0.1.72163.vsix`는 1,022,836바이트이며 SHA-256은
`ae572169aa7d5b87f0bb52a193eb79db8eca13ddb9ca78818f16e543865bf563`다.
126개 dist/media/l10n/NLS runtime 파일을 소스와 대조했고 이전 배포 대비
변경된 runtime은 `dist/extension.js`뿐이다. rebase helper와 웹뷰 자원은 같은
바이트이며 시험용 fixture 코드·개발 파일이 패키지에 없는지도 확인했다.

동일한 검증 VSIX를 CLI 게시와 로컬 설치에 사용한다. 산출물 검증은
`/private/tmp/gsc-release-72163-artifact.json`, 게시·설치 확인 경로는
`/private/tmp/gsc-release-72163-publish.log`,
`/private/tmp/gsc-release-72163-install.log`, `/private/tmp/gsc-installed-72163.json`이다.
별도 Marketplace 상태 조회, 사용자 창 포커스 전환이나 강제 reload는 수행하지 않는다.

원래 전체 작업 속도·Graph 최신성·안정성·자원 목표는 유지한다.
