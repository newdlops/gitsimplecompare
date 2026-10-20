# 0.1.72123 push 객체 목록의 메모리와 IPC 비용 감소

큰 outgoing 크기 조회에서 `rev-list`의 모든 객체 ID를 Buffer·문자열로 보관한 뒤
`cat-file` stdin으로 다시 보내던 경로를 bounded byte pipe로 연결했다.
숫자 합계·safe integer 검증, 실제 push URL, source OID, 목적 ref와 lease는 유지한다.
Git batch 출력에는 `--buffer`를 적용해 객체마다 flush하던 IPC 비용을 줄인다.
이는 일반 stdio 버퍼링을 사용하는 옵션이다. [Git 공식 cat-file 설명](https://git-scm.com/docs/git-cat-file).

## 같은 fixture의 반복 비교

기준은 `3afb68fd5cce9212b9a30a1dc761e0d3f868a5a2`(0.1.72122)다.
기준1 → 후보1 → 후보2 → 기준2 순서로 독립 임시 저장소에서 실행했다. 모드·버전당 표본은 2개이며
아래 값은 중앙값이다. 같은 Node·Git·계측 코드를 사용했고 기능 검사와 겹치지 않았다.
인위적인 지연은 없다. fixture 생성과 GC는 측정 구간 밖이다. 다른 머신 부하는 통제하지 않았다.

| 범위 | 완료 시간 ms: 이전 → 후보 | Node RSS 증가 MiB: 이전 → 후보 | Node CPU ms: 이전 → 후보 |
|---|---:|---:|---:|
| Synthetic 10만 ID | 946.0 → 461.0 | 24.5 → 10.0 | 53.5 → 44.5 |
| Synthetic 200만 ID | 1,531.0 → 989.5 | 303.0 → 9.0 | 465.5 → 406.0 |
| Native 객체 100,103개 조회 | 645.0 → 231.5 | 17.0 → 8.0 | 155.5 → 39.0 |
| 기존 목적 브랜치 Native push 서비스 | 4,251.5 → 3,232.5 | — | 197.5 → 56.0 |

Synthetic 200만 ID는 82,000,000바이트의 입력이다. 이 경우 Node RSS 증가 중앙값은
303.0 → 9.0MiB
(97.0% 감소)다. 숫자 출력의 행 수와 합계가 모두 일치했다.
이는 확장 측 transport를 재현한 수치이며 실제 Git 이력 walk나 GitHub 전송 속도가 아니다.

Native fixture는 blob 10만 개·하위 tree 100개·신규 커밋 2개를 실제 pack에 넣는다.
기존 목적 브랜치가 base를 갖는 로컬 bare remote에 일반 single push를 수행했다.
100,103개 객체·17,104,041바이트의 합계, 최종 로컬/원격 HEAD와 미추적 파일이 모든 표본에서 정확했다.
checkout은 생략하고 pack은 준비 과정에서 warm 상태다. push 수와 직접 Git 호출 수는 각각 1회·12회로 같다.
서비스 시간은 `pushBranchCommits`의 준비·전송 완료 범위이며 VS Code 버튼·Graph 반영 전체 시간은 아니다.

RSS는 각 측정 시작 시점 대비 증가량이다. Node CPU/RSS에 Git·receive-pack·Chromium·OS는 포함하지 않는다.
특히 Native RSS는 큰 fixture 생성 후 GC/heap 재사용의 영향을 받으므로 전체 메모리 상한이나 0 사용량으로 해석하지 않는다.
표본별 느린 값과 변동도 [원본 JSON](read-pipeline-0.1.72123.json)에 모두 보존했다.

## 취소·timeout·쓰기 보호

- 양쪽 read와 검증된 후손의 실제 close 뒤에만 성공·오류를 반환한다. 기존 프로세스 소유권 검사는 완화하지 않았다.
- 이미 exit한 producer의 stdout이 downstream 역압으로 남는 경우도 취소 시 unpipe·drain해 close를 완료한다.
- preparation 뒤에도 readonly를 재확인한다. 일부 ID 출력 뒤 producer 실패나 consumer 조기 성공을 정상 합계로 취급하지 않는다.
- 역압 때문에 원래 성공하던 두 조회가 일찍 timeout되는 경계를 재현하고 수정했다.
  합성 조회에는 기존 두 Native 조회의 합산 예산을 적용한다. 기본은 30+30초이며 명시적 0은 계속 제한 없음이다.
  다른 단일 조회·쓰기·hook의 정책은 바꾸지 않는다. timeout·취소·parser 오류도 원래 원인과 양쪽 정리를 보존한다.
- ID transport의 readable/writable high-water mark는 각각 64KiB다. 전체 Git 프로세스나 모든 메모리의 상한을 뜻하지 않는다.

## 확인한 범위

관련 Node 고유 검사 **145개**를 완료했다. 첫 통합 실행은 900초 상한으로 중단됐으며 완료 그룹으로 세지 않았다.
그전에 끝난 121개와 남은 23개 분리 실행을 확인했고, 추가 예산 경계 1개로 고유 수가 145개가 됐다.
최종 변경 경로는 pipeline 13개와 buffered Native/push metadata 15개를 다시 통과했다.
실제 50MiB 공유 이력, staged/unstaged/untracked 보존, 잘못된 metadata의 무변경,
서로 다른 push/fetch URL, 동시 목적 ref 생성, 원래 lease·원본 DAG 보호도 포함한다.
타입 검사는 통과했다. 로컬/글로벌 ESLint 실행 파일·의존성·설정이 없어 lint는 실행하지 못했으며 설치하지 않았다.

새 브랜치 push와 tracked push는 production HTML/CSP/JS의 headless Chromium에서도 확인했다.
파일 128개·base 400커밋·branch 40개·시험용 2KiB 경계에서 실제 Git의 ref·HEAD·local-only 표시와 일치했다.
사용자 창 포커스는 필요하지 않았다. 이 기능 검사는 다른 Chromium 검사와 겹쳤으므로 시간·CPU/RSS를 성능 비교에 사용하지 않는다.
초기 frame 검사는 첫 최종-state 게시를 선택했으나 renderer는 연속 게시의 오래된 ACK를 정상 생략한다.
마지막 게시를 검증하도록 계측을 고치고, 기존 두 frame/게시 대체 계약 검사 2개도 통과했다.
최종 frame·DOM 일치 assertion은 유지했으며 첫 실패 로그도 JSON에 남겼다.

## 재현과 남은 범위

`node scripts/benchmark-git-read-pipeline.mjs /tmp/after.json`으로 후보를 실행한다.
기준에는 `GSC_BENCH_SOURCE_REF=3afb68fd5cce9212b9a30a1dc761e0d3f868a5a2`를 지정한다.
같은 harness를 archive한 기준 source에 복사하므로 계측 차이를 피한다. 사용자 저장소를 입력받지 않는다.

중간 후보에서 Native Node CPU가 늘어 batch 버퍼링을 추가했으며 그 전 표본은 최종 표에 섞지 않았다.
중간 flat-tree fixture와 초기 pilot도 JSON의 제외 목록에 남겼다. 최종 source SHA-256과 전체 원본 표본을 기록했다.

첫 전체 이력 walk는 아직 존재한다. 알 수 없는 published tip, 보통 push의 버튼→Graph 전체 대기와
interactive message/squash 대기는 추가 개선 대상이다. 이번 transport 성과로 전체 목표를 완료 처리하지 않는다.
더 넓은 작업 범위는 [기존 감사](operation-audit-0.1.72121.md)를 유지한다.
