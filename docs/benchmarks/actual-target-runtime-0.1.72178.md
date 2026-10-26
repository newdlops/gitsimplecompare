# 0.1.72178 실제 실행 확인

호스트 권한으로 읽은 OUTPUT 파일 핸들과 해당 창의 살아 있는 extension-host PID를
연결해 **6개 창의 0.1.72178 실행**을 확인했다. 사용자는 실제 버전에서 머신이
바쁠 때의 Graph·PR 체감을 묻는 질문에 **“많이 나아짐”**으로 답했다.
창 입력·포커스 이동·강제 reload와 Marketplace 조회는 수행하지 않았다.

## Graph 응답

| 창 | 표시 | 갱신 시작 → paint | trace 내부 합계 | 렌더링 |
| --- | --- | ---: | ---: | ---: |
| window1 | initial | 217 ms | 142 ms | 23 ms |
| window1 | workingTree | 531 ms | 457 ms | 20 ms |
| window2 | initial | 1,064 ms | 274 ms | 12 ms |
| window2 | localOnly | 1,272 ms | 482 ms | 3 ms |

같은 창·저장소·cause의 `graph refresh start`와 paint 시각을 연결했다. trace는
fingerprint 준비 이후 시작하므로 trace 합계를 전체 응답으로 보고하지 않는다.
window2의 첫 표시에는 trace 전에 약 790 ms가 있다. 서로 다른 저장소·상태의
관찰이며 이전 버전과 짝지은 지연 개선율로 해석하지 않는다.

## 읽기 전용 CPU 관찰

2026-10-26 06:08:11–06:08:31 UTC에 5초 간격으로 5개 표본을 읽었다.
머신의 평균 CPU busy는 45.7%였고, 구간별로 39.9–56.8%였다. 같은 20.011초에
extension host 6개의 합산 CPU 시간은 540.635 ms, **코어 하나 기준 2.702%**였다.
관찰 중 새 Graph paint나 PR 작업은 없었다. 따라서 이는 대기 상태의 배경 사용량
자료이며, 바쁜 Graph·PR 작업의 CPU 측정이나 버전 간 개선율이 아니다.

측정한 프로세스에는 다른 확장도 포함된다. 별도 Git 자식·renderer의 CPU는 이
합계에 포함되지 않으므로 Git Simple Compare만의 CPU나 전체 앱 CPU로 부르지 않는다.
`proc_pid_rusage`의 CPU 시간은 이 머신에서 Mach tick이었다. `mach_timebase_info`
125/3 변환을 적용하고 자기 프로세스 CPU 시계와의 비율 1.000116으로 단위를
검증했다. 50 ms의 자체 단위 검증은 실제 20초 관찰 구간 밖에서 수행했다.

재현 도구는 [sample-extension-host-cpu.c](../../scripts/sample-extension-host-cpu.c)다.
macOS SDK에서 `cc -Wall -Wextra -Werror -O2`로 컴파일하고, 호스트 권한으로
실제 PID들을 인수로 전달하면 같은 20초 관찰을 JSON으로 출력한다. 프로세스 시작
값을 전후에 비교해 PID 재사용을 배제해야 한다. 앱에 신호를 보내거나 inspector를
열지 않는다. 공개 표본에서는 PID·시작값을 창 별칭으로 치환했다.

## 실행 상태 관찰의 정정과 검증 범위

04:34 UTC의 이전 관찰은 0.1.72177 창 4개였다. 그 뒤 sandbox 범위에서 나온
빈 FD·프로세스 결과는 앱 미실행의 증거로 사용할 수 없었다. 05:43 UTC 이후
호스트 권한 관찰에서 0.1.72178 창 6개를 확인했고, 06:06 UTC에도 재확인했다.
추가 수동 reload를 기다려야 한다는 조건은 해소됐다. 앞으로 비어 있는 sandbox
관찰을 근거로 사용자에게 reload를 반복 요청하지 않는다.

실제 `working status reads paused` 전환도 기록됐다. 이 값은 저장소별 요청 상태의
해제이며 종료한 Git 프로세스 개수가 아니다. 실제 `working tree decoration reads
cancelled` 전환은 이 관찰에서 나오지 않았다. Native Explorer 포커스 왕복의 시각
검증은 수행하지 않았고, 사용자 보고·자동 회귀 검증과 구분한다.

같은 대형 저장소에서 727/1,002/561 ms의 초기 파일 스캔과 3,698 ms의 diff도
기록했다. 이를 숨기거나 모든 Git 지연이 사라졌다고 결론내리지 않는다. 사용자의
체감 개선 확인, 기존 140개 회귀 검증 및 [96회 Native 비교](focus-status-resource-0.1.72178.md)를
근거로 이번 최적화 작업을 마무리한다. 전체 앱 CPU 감소율이나 포커스 유지 시의
통계적 동등성을 새로 주장하지 않는다.

경로·ref·사용자 식별자를 제외한 [관찰 데이터](actual-target-runtime-0.1.72178.json)를
보존한다. 실행 코드·버전·배포 패키지는 변경하지 않았다.
