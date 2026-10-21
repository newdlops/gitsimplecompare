# PR 후속 상태 탐색 — 0.1.72139

PR 적용 후 Graph가 큰 작업트리의 상태를 읽을 때 미추적 경로 탐색의 목표 묶음을 16개에서 4개로 줄였다. 동시 실행 한도는 기존 4개를 유지한다. 모든 경로를 탐색하며, 16,000bytes 인자 상한 때문에 필요한 추가 분할은 허용한다. Native ignore 규칙, 디렉터리 변경 fence, 실제 index 검증, 전체 timeout과 취소/close 처리는 유지한다.

## 실제 규모의 격리 비교

읽기 전용 원본의 object를 빌린 별도 저장소에 30,311개 파일(275MB), 72,720개 도달 가능 commit, 캡처한 2,665개 ref를 재현했다. 실제 사용자 작업트리·index·ref·설정·object에는 쓰지 않는다. checkout·합성 PR commit·bare 원격·작업 ref는 모두 임시 저장소가 소유한다. [Git 저장소 레이아웃 문서](https://git-scm.com/docs/gitrepository-layout)의 alternates 구조를 사용한다.

0.1.72138 소스와 수정 소스를 같은 harness로 B/A/A/B/B/A 순서, source당 3회 비교했다. GitHub 목록 정보와 VS Code transport/window/picker는 대체한다. 실제 충돌 PR이나 사용자 dirty tree, 인터넷 지연을 측정한 결과는 아니다.

| 서비스 완료 후 최종 Graph frame 중앙값 | 이전 | 수정 |
| --- | ---: | ---: |
| PR squash | 1,167ms | 786ms |
| PR commit별 적용 | 629ms | 758ms |

전체 서비스+frame 중앙값도 squash는 4,534→1,898ms, commit별 적용은 3,711→4,239ms로 혼재했다. Node CPU 중앙값은 각각 456→432ms, 294→471ms였다. 큰 squash 시간 차이를 이 변경만의 효과로 단정하지 않는다. 모든 표본과 느려진 결과를 [JSON 보고서](pr-cold-scan-0.1.72139.json)에 보존했다.

반복해서 줄어든 것은 Git 조회 수다. squash의 Graph 후속 조회는 26~27→14~15회, commit별 적용은 26→14회다. 미추적 파일 열거는 16→4회다. 일부 실행에는 별도 warmup status가 포함된다.

## 실제 버튼과 자원

production HTML/CSP/JS의 PR 버튼과 등록된 확장 callback으로도 squash·commit별 적용을 각각 검증했다. 실제 tree, 부모, commit 수, 깨끗한 작업트리, 최종 HEAD/ref/local-only/원격 tag 장식이 Native Git과 일치했다. 별도 자원 관측 전후 한 쌍에서 소유 Node/Git/Chromium의 전체 CPU는 71.74→66.87초, 관측 RSS 합계 최대는 694.6→706.6MB였다. fixture 생성과 사후 검증을 포함하며 per-operation CPU가 아니다.

healthy renderer 기준 0.1.72112와 비교한 전체 9종 작업 한 쌍도 모두 Native 상태와 production renderer를 통과했다. 이 쌍의 전체 CPU는 20.18→17.02초, RSS 합계 최대는 640.7→647.9MB였다. 표본 수가 작고 이전 18개 시나리오 비교에는 반대 결과도 있어, 일반적인 속도나 전체 자원 개선의 증거로 사용하지 않는다.

자원 observer는 source archive/build와 자신/ps를 제외한다. RSS는 50ms+ps 실행 간격으로 보이는 소유 자손의 합계라 공유 페이지 중복과 짧은 자식/peak 누락이 가능하다. 이전 범용 observer 설명의 “Chromium 제외”는 잘못된 문구였다. 실제 수집 알고리즘은 이미 소유 자손을 포함했으며 이번에는 설명만 수정했다.

## 검증과 한계

- 최종 관련 Node 28개 통과, 실패/취소/skip 0, 타입 검사 통과. 전체 Native status와 결과 동일성, ignore/nested repository/symlink/literal 이름, index bytes 보존, 경로·디렉터리 교체, warm cache, 취소와 전체 timeout을 확인했다.
- 전후 서비스 사례 12개, 자원 계측 실제 PR 버튼 사례 4개, 전체 9종 작업 전후 18개가 Native 결과와 실제 production renderer를 통과했다. 추가 버튼 진단 2개는 함수 래퍼 오버헤드가 있어 시간 비교에서 제외했다.
- 첫 실제 규모 검증에는 원격 tag overlay가 기준에서 빠져 있었다. 별도 Native `ls-remote --tags` 결과로 annotated tag를 peel하고 이동·삭제도 검증하도록 고쳤다. 정상 ref를 필터링해서 성공으로 처리하지 않는다. 별도 tag 게시 후 두 frame이 지난 DOM도 확인한다.
- 첫 전체 시나리오 실패는 앞선 fetch가 다음 fresh-history 객체를 미리 가져온 harness 문제였다. 시나리오마다 원격 전용 새 객체를 만들어 순서 의존을 제거했다. 첫 Node 그룹의 timeout 시험도 실행 시작 전에 만료되는 문제를 고쳐 차단한 Native 단계로 검증한다. 실패 기록은 남겼다.
- UI 소스는 변경하지 않았다. foreground host, OS 포커스 변경, 강제 reload, Marketplace 상태 점검, 사용자 stash·복구 snapshot·보존 PR worktree 삭제는 하지 않았다.

실제 버튼 진단에서는 대부분의 시간이 Native Git 안에 있었고, commit별 PR 적용 전 두 번의 동기 status가 큰 비중을 차지했다. 다음에는 그 비용과 dirty/conflict 경로를 확인한다. 오래된 UI snapshot으로 쓰기 전 검사를 대체하거나 ref/HEAD/index/operation/CAS·복구 검증을 줄이지 않는다. 원래 전체 최적화 목표는 계속 유지한다.
