# 실제 0.1.72176 활성화와 수동 작업의 Graph 기록

2026-10-26 01:58:41 UTC 기준 열린 실제 창 4개의 활성화 버전이 0.1.72176임을
확인했다. OUTPUT 파일의 열린 OS handle로 살아 있는 세션을 구분했다. 이 활성화는
외부에서 발생했으며 agent의 native 입력·포커스 변경·강제 reload는 없었다.

## 확인한 동작

비활성 상태에서 활성화한 창 3개가 `working tree decoration reads deferred`를
기록했다. 그중 계속 비활성인 두 창은 캡처 구간에 decoration refresh가 0회였다.
다른 한 창은 포커스 복귀 후 412개 파일의 decoration refresh를 기록했다. 이는
수정한 조회 지연 동작의 실제 세션 증거이며 CPU 절감량이나 이전 버전과의 짝지은
속도 비교가 아니다.

실제 창의 같은 ready/checkout refresh 시작과 해당 trace의 frame을 연결했다.
`postFingerprintTraceTotalMs`만 전체 시간처럼 보고하지 않고 fingerprint 이전의
refresh 시작부터 직접 계산했다.

| 창 / 동작 | Graph refresh 시작 → frame | fingerprint 이후 trace | renderer handler |
| --- | ---: | ---: | ---: |
| window1 / ready | 2,269 ms | 944 ms | 17 ms |
| window5 / ready | 856 ms | 487 ms | 25 ms |
| window5 / checkout 후 refresh 1 | 886 ms | 426 ms | 19 ms |
| window5 / checkout 후 refresh 2 | 673 ms | 388 ms | 5 ms |

checkout 수치는 앞선 Git mutation 시간과 사용자의 물리 입력을 포함하지 않는다.
ready 수치도 앱 전체 기동 시간이 아니다. 두 ready에서 branch 상세와 301개 log의
선행 조회가 같은 세대에서 겹쳤고 300행을 게시했다. 후속 working-tree 게시까지는
각 refresh 시작에서 2,933 ms와 1,032 ms였다. 세대나 다른 원인의 시간을 합치지 않았다.

기존 데스크톱 Graph 화면도 입력 없이 읽었다. 300개 commit, HEAD·가상 staged/working
행, PR 패널과 Changes가 표시된 한 상태를 확인했다. 화면·원문 AX·경로·ref·commit·
저자 정보는 공개 기록에 넣지 않았다. 단일 상태의 관찰이며 Explorer badge의 포커스
전환·반응형·hover·키보드·전체 시각 QA를 통과했다고 주장하지 않는다.

## 한계와 다음 근거

짝지은 이전/이후 부하 실험이나 실제 앱 CPU 계측은 아니다. 사용자 작업으로 local/
remote ref 수가 뒤에 변했으므로 전체 캡처를 같은 저장소 상태의 성능 비교로 취급하지
않는다. 초기에 캡처한 고정 입력의 headless 실험은 그보다 앞서 별도로 완료됐으며,
각 실험 경계의 보호 대상이 같았다는 검증과 구분한다.

window1은 포커스 복귀와 첫 decoration refresh 사이에 약 15초 간격이 있지만 기록된
status refresh 자체는 22 ms였다. 이 간격만으로 Git status가 병목이라고 단정하지
않는다. 발견·소유권·스케줄링 경계를 다음에 확인할 근거로 남긴다.

최신 실제 버전의 실행 여부를 막던 조건은 해소됐다. 전체 CPU 감소와 동시에 바쁜
머신에서의 작업 응답 개선은 여전히 미검증이며 목표는 active다. 이번에는 제품 변경,
새 버전, 새 배포나 추가 설치를 수행하지 않았다. Marketplace 점검도 없다.

[익명화한 136개 실제 이벤트와 계산 근거](actual-target-runtime-0.1.72176.json).
