# 0.1.72122 새 브랜치의 이미 게시된 이력을 다시 분할하는 낭비 제거

새 목적 브랜치가 없으면 이전 계획은 원격 전체가 빈 것처럼 source의 전체 이력을 크기 계산에 넣었다.
기본 이력은 main 등에 이미 게시돼 있어도 합계가 50MiB를 넘으면 root부터 커밋별 push를 만들 수 있었다.
같은 source를 다른 이름으로 PR 게시하는 경우에도 이미 있는 이력을 다시 전송 단계로 구성했다.

이번 변경은 큰 새-브랜치 계획에서 실제 push URL의 다른 branch tip을 조회한다.
로컬에서도 commit으로 검증한 tip만 새 객체 크기와 first-parent 목록의 제외 집합으로 사용한다.
fetch URL/tracking ref로 서버 상태를 추측하지 않으며 알 수 없는 객체를 fetch하지 않는다.
목적 ref의 상태와 lease는 이 제외 집합과 분리한다. 새 목적 ref의 첫 sequential lease는 계속 빈 문자열이다.

## Native 재현과 반복 측정

기준 commit은 `829a698b3f0eebbd168b9096cc2eae54610ba5ef`(0.1.72121)이다.
같은 계측 코드·Node·Git 설정으로 기준1 → 후보1 → 후보2 → 기준2 순서로 실행했다.
각 실행은 별도 임시 저장소와 로컬 bare remote를 쓴다. 원격은 기본 32개 커밋을 이미 갖고,
아직 없는 feature 목적지에 신규 3개 커밋을 게시한다. post-receive hook이 성공한 실제 ref 변경을 기록한다.

반복 측정은 크기 경계를 **시험용 2KiB**로 줄여 기존 이력 분할을 작은 fixture로 재현한다.
Git 실행에 인위적인 지연을 넣지 않았다. production 50MiB의 전송 처리량, 실제 GitHub 속도,
모든 push의 대기시간 개선으로 해석하지 않는다. 외부 머신 부하는 통제하지 않았으며 Graph는 측정 구간에 없다.
각 모드/버전당 표본은 2개다. 아래 시간·호출 수·CPU는 두 표본의 중앙값이다.

| 지표 | 작은 신규 변경: 이전 → 후보 | 큰 신규 변경: 이전 → 후보 |
|---|---:|---:|
| 버튼 실행 API 완료 시간(ms) | 74423.5 → 10269.0 | 83021.5 → 15945.0 |
| 전송 계획 ready까지(ms) | 3663.0 → 5453.0 | 3310.5 → 5896.5 |
| 직접 Git 실행 | 122.0 → 23.0 | 122.0 → 31.0 |
| 실제 push / 원격 ref 변경 | 35.0 → 1.0 | 35.0 → 3.0 |
| benchmark Node CPU(ms) | 309.5 → 98.5 | 331.0 → 97.5 |
| 신규 객체 추정 바이트 | 8386.0 → 1044.0 | 19650.0 → 12308.0 |

이 fixture의 API 완료 중앙값은 작은 변경 **86.2%**, 큰 변경 **80.8%** 줄었다.
새 변경이 작으면 35회 대신 1회, 새 변경도 실제로 크면 35회 대신 신규 3개 커밋만 순서대로 push했다.
원격 main·최종 feature OID와 로컬 index·미추적 파일은 8개 표본 모두 정확했다.
Node CPU는 Git·SSH/receive-pack/hook 등 자식 CPU를 포함하지 않으므로 전체 OS CPU 절감률로 사용하지 않는다.

서버 이력 확인으로 ready까지의 시간은 늘었다. 이는 원격 전체 조회와 재계산의 추가 비용이다.
작은 전체 이력과 기존 목적 ref는 이 새 조회를 하지 않는다. 느린 표본도 모두 원본에 보존했다.
최초 계측 준비 시 빈 init template에 hooks 디렉터리가 없어 실패한 실행은 완료 표본이 아니다.
동일한 fixture 수정 후 수행한 4개 실행만 비교했으며 실패 경로도 JSON에 기록했다.

## 정확성·안전·자원 확인

- 관련 Node 검사 **97개 통과**, 실패·취소·skip 0개. metadata fixture 조정 후 해당 3개를 다시 통과했고 고유 검사 수에는 중복 합산하지 않았다.
- 실제 **50MiB** sparse 파일을 기본 이력에 commit·게시한 Native 검사에서도 신규 작은 변경 3개는 한 번의 push로 완료했다.
- 실제 새 데이터가 큰 경우 신규 3개만 전송하고, 첫 lease는 빈 목적 ref, 이후 lease는 직전 성공 OID임을 실제 Git 인자로 확인했다.
- 계획 뒤 다른 쓰기가 새 목적 ref를 만들면 첫 전송을 거부한다. 기존 원격 main과 다른 ref, staged/unstaged/untracked 작업을 보존했다.
- 별도 push URL이 더 적은 이력을 가진 경우 fetch remote의 tracking tip으로 제외하지 않는다.
- 알 수 없는 원격 object는 로컬에 생기지 않았고 비commit ref도 제외 증거로 채택하지 않았다.
- 빈 remote의 root부터 순서 전송, 부분 실패/재시도, 취소, 다중 URL, replace/graft, force 정책과 PR/remote-branch 게시도 회귀 검사했다.
- source가 다른 원격 branch에 이미 게시된 PR 재게시 검사는 마지막 source tip으로 새 ref를 한 번 생성한다. 첫 빈 원격 게시의 순서는 유지했다.
- metadata stdout은 streaming으로 읽고 마지막 미완성 행은 128바이트, 선택한 제외 tip은 64개로 제한한다. 모든 원격 출력/입력 OID와 확장 전체 RSS의 상한을 뜻하지 않는다.
- OUTPUT에 검증한 published tip 수, 원래 이력 크기와 재계산한 신규 객체 크기를 남긴다. URL은 로그 필드에 넣지 않는다.
- 타입 검사 통과. production HTML/CSP/JS에서도 새 공유-이력 경로를 거친 push와 tracked push의 최종 ref·HEAD 배지·local-only가 Native Git과 일치했다.
  파일 128개·기본 커밋 400개·side branch 40개·2KiB 경계의 기능 검사이며 이미 읽은 이력에 추가 log는 없었다.
  Node 검사와 겹친 기능 대조 시간/CPU/RSS는 성능 비교에 사용하지 않는다. 사용자 창 포커스는 필요하지 않다.

## 남은 범위와 재현

`node scripts/benchmark-published-push.mjs <output.json>`을 실행하고 이전 source에는
`GSC_BENCH_SOURCE_REF=829a698b3f0eebbd168b9096cc2eae54610ba5ef`를 지정한다.
이전/후보 모두 같은 harness를 복사해 source만 격리한다. 사용자 저장소를 입력으로 받지 않는다.
[원본 표본·source SHA-256·검사 결과](published-push-0.1.72122.json)에 모든 완료 표본이 있다.

기존 목적 ref의 일반 push는 이번 변경의 대상이 아니며 모든 push가 빨라졌다는 증거로 쓰지 않는다.
다른 원격 tip의 object를 로컬에서 확인하지 못하면 보수적으로 기존 전체 이력 계획을 유지한다.
처음의 전체 객체 크기 조회도 아직 남아 있으므로 큰 저장소의 초기 walk/메모리 비용은 추가 개선 대상이다.
나머지 명령·interactive rebase의 전체 대기시간/자원 목표는 [0.1.72121 감사](operation-audit-0.1.72121.md)의 미완료 범위를 유지한다.
전체 목표를 이번 새-브랜치 성과만으로 완료 처리하지 않는다. 강제 reload나 Marketplace 상태 조회는 하지 않았다.
