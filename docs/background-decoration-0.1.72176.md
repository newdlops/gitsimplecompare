# 0.1.72176 — 비활성 창의 초기 파일 배지 조회 미루기

실제 0.1.72175 활성화 뒤 네 창의 로그 핸들과 Graph trace를 확인했다. 비활성 창도 탐색기 배지를 위해 최초 저장소 탐색·상태 조회를 시작했다. 아래는 창 포커스 이벤트가 false인 동안 완료된 조회다. wall time이며 CPU 사용 시간이나 원인별 지연으로 해석하지 않는다.

| 익명 창 | 배지 조회 경과 시간(ms) | 배지 파일 수 |
|---|---:|---:|
| window2 | 12,999 | 47 |
| window3 | 18,919 | 5 |
| window4 | 14,640 | 5 |

Graph에서는 pagination으로 기록된 300행(skip 0)의 trace 전체가 3,162ms, 웹뷰 handler가 57ms, 후속 frame이 195ms였다. 이후 local-only 배지 trace는 같은 시작점부터 5,125ms였다. ready fingerprint의 7,504ms와 다른 세대의 branch 조회 9,250ms는 별도 작업이며 이 값들을 합산하지 않는다. CPU 논리 코어 15개에서 load average 52.48/71.85/67.80도 관측했지만 frame 이후 시점이므로 직접적인 원인·동시 부하 증거로 사용하지 않는다.

이번 수정은 비활성 창의 최초 탐색·passive URI 조회를 미루고 기존 배지를 캐시에서 반환한다. 창 복귀 시 생략한 URI 결과를 한 번 무효화해 새 파일과 중첩 저장소도 다시 조회한다. stat/root 탐색을 기다리는 동안 포커스를 잃거나 status 결과가 무효화되더라도 새 background status나 재시도를 시작하지 않는다. 이미 foreground에서 시작한 유효한 조회 결과는 캐시에 적용할 수 있다. 내장 Git이 모든 폴더를 소유하면 복귀 시 자체 URI 무효화도 생략한다.

## 검증과 범위

기존 구현에서 새 경계 사례 7개가 실패하는 것을 재현했고, 내장 Git 전용 창의 불필요한 무효화 사례도 추가로 재현·수정했다. 최종 Node 테스트 18개, 타입 검사, production 빌드가 통과했다. 테스트에서 비활성 URI 질의 100개에 저장소 탐색·상태 API 요청은 각각 0회였으며 포커스 복귀 뒤 상태 조회는 1회였다. 이는 해당 provider의 호출 경계이며 다른 소비자를 포함한 전체 Git 호출 수나 실제 앱 CPU 감소량이 아니다.

색상·badge·tooltip 변환 함수의 소스 바이트는 이전 버전과 같다. 실제 Git fixture의 index 보존도 검증했다. 이번 변경의 새 버전에서 Native Explorer 포커스 전환 시각 QA는 아직 수행하지 않았다. 브라우저 route 변경은 없으며 패키지 실행 자산은 별도로 대조한다. 실제 업데이트 창의 전체 응답·CPU 개선은 추가 확인이 필요해 전체 성능 목표를 완료 처리하지 않는다.

재현: 프로젝트 루트에서 `npm test -- test/workingTreeFileDecorations.test.ts`, `npm run check-types`, `npm run package`를 실행한다.

[검사와 호출 경계](benchmarks/background-decoration-0.1.72176.json), [개인 정보를 제외한 실제 로그](benchmarks/background-decoration-actual-0.1.72176.json).

동일 VSIX로 0.1.72176 게시와 설치를 완료했다. 실행 자산 81개가 빌드·패키지·설치 파일과 일치했고 브라우저 자산은 이전 버전과 바이트 단위로 같았다. 현재 실제 창 4개는 0.1.72175를 실행 중이다.

[산출물 검증](benchmarks/release-artifact-0.1.72176.json), [배포·설치](benchmarks/deployment-0.1.72176.json), [실제 실행 상태](benchmarks/actual-session-observation-0.1.72176.json), [전체 성능 목표](benchmarks/goal-progress-0.1.72176.json).
