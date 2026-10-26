# 실제 0.1.72177 활성화와 초기 조회 관찰

2026-10-26 03:39:21 UTC에 실제 열린 OUTPUT handle 4개와 각 세션의
`extensionVersion: 0.1.72177`을 확인했다. 사용자가 선택한 수동 재시작 이후
외부에서 활성화된 세션이며 agent의 창 입력·포커스 이동·강제 reload는 없었다.

이전 관찰에서 막혔던 최신 버전 활성화 조건은 해소됐다. 다음 수치는 서로 다른
저장소·포커스 상태의 관찰이며 이전 버전과 짝지은 성능 비교가 아니다.

| 창 / 게시 | 갱신 시작 → frame | fingerprint 이후 trace | renderer handler |
| --- | ---: | ---: | ---: |
| window2 / initial | 180 ms | 110 ms | 26 ms |
| window2 / localOnly | 251 ms | 179 ms | 3 ms |
| window2 / workingTree | 437 ms | 366 ms | 19 ms |
| window4 / workingTree | 9,340 ms | 7,813 ms | 2 ms |
| window4 / pagination:older | 해당 원인의 refresh 시작 없음 | 1,160 ms | 13 ms |

`totalMs`는 fingerprint 이후 trace 시작을 기준으로 한다. 이를 전체 갱신 시간으로
취급하지 않고 동일 저장소·원인의 실제 refresh 시작과 frame을 연결했다. window4의
workingTree 게시에는 가상 행 2개만 있었으며 최초 300개 커밋 게시와 구분한다.

window4는 03:38:42.136에 조회를 중단하고 03:38:48.353에 포커스 복귀를 기록했다.
긴 ready 기록은 이 6,217 ms를 포함한다. 복귀 이벤트부터 최초 커밋 frame까지는
1,924 ms였고 재개한 status 단계 자체는 732 ms였다. 물리 입력 시간은 측정하지 않았다.

같은 창·같은 저장소의 cold scan은 9,886 / 2,074 / 2,271 ms로 3회 완료됐다.
이는 CPU 시간이 아니며 겹친 warmup 시간을 더해 총 작업 시간으로 만들지 않는다.
일부 표시 소비자가 포커스 상실 뒤에도 공유 실행기에 남아 내부 세대 재시도를
이어갈 수 있는 경로를 코드와 회귀 테스트로 재현했다. 실제 세 번의 스캔에 관여한
모든 API 소비자를 이 로그만으로 특정하지는 않는다.

다른 창에서는 0.1.72177의 `beforeUntrackedExpansion` metadata 무효화 경계가
실제로 1회 기록됐다. 이미 무효한 status의 미추적 파일 확장을 건너뛴 동작 증거이며,
이 사건의 절감 시간이나 전체 CPU 감소량을 증명하는 측정은 아니다.

호스트 부하의 정량 계측, 짝지은 busy/idle 비교, 전체 앱 CPU 감소와 네이티브 Explorer
포커스 전환 시각 QA는 미완료다. 실제 관찰 100개와 계산 근거는
[익명화한 JSON](actual-target-runtime-0.1.72177.json)에 보존했다.
