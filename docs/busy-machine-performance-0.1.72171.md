# 누적 Graph의 작은 갱신 비용 줄이기 — 0.1.72171

기준은 0.1.72170 (`8fd050da2fc5f8c76e95db00a201abbb64744779`)이다.
전체 목표와 수락 기준은 `busy-machine-performance-plan.md`에 유지한다.

## 변경 내용

HEAD·제목·저자만 바뀌는 delta도 기존에는 모든 SVG 간선의 브랜치 이름과
highlight 모델을 다시 계산하고 모든 node/path의 표시 key를 확인했다.
이제 기존 검증이 행 수·해시·부모·레인·색상·compact·브랜치 의미의 동일성을
확인한 경우에만 변경 행과 그 행에서 나가는 간선을 확인한다.

branch/tag 알림의 영향 행도 다음 SVG 갱신까지 누적한다. 상태 전용 메시지가
그 사이에 도착해도 이 범위를 지우지 않는다. 범위가 불명확한 팔레트 변경과
구조 변경은 전체 비교 경로를 유지한다. 실제 SVG 갱신 뒤에만 범위를 비운다.
compact marker를 교체한 경우 소유 요소를 정확히 제거하고 최상단에 복원한다.

갱신 준비에서는 기존 행 인덱스로 마지막 실제 행을 찾는다. 부모·class·index와
가상 행 여부를 검증하고, 캐시가 분리되면 기존 selector로 확인한다. 마지막 행이
없으면 완전한 최신 모델로 복구한다. SVG 크기는 값이 달라질 때만 기록해
불필요한 기하 무효화를 피하며 reflog가 확장한 크기는 원래대로 복원한다.

새 timer나 listener는 없다. outgoing-edge 인덱스는 첫 빠른 갱신에서만 만들고
구조 변경 때 폐기한다. 두 Int32Array의 크기는 `4 * (행 수 + 간선 수)` bytes다.
브랜치 이름 배열과 이 인덱스는 현재 SVG에만 귀속된다.

## 분리 측정

5천 행·4,999 간선·천 브랜치·250 태그에서 HEAD/제목/저자와 branchStatus를
갱신했다. 독립 Chromium 8개를 B/A/A/B와 반대 순서로 실행했다. 각 source는
4개 수명이며 수명 안의 표본은 상관돼 있다. 준비 8회 후 지연 16회는 CPU 6배
제한, CPU 32회와 GC 후 heap 32회는 별도 무제한 구간이다. 비교 중 다른 검사나
빌드를 실행하지 않았고 측정 뒤 full snapshot의 SVG 속성·툴팁과 대조했다.

표는 source별 네 수명의 중앙값이다. 첫 비교 쌍의 머신 부하가 나머지보다 컸다.
인접한 네 비교 쌍 모두 handler·두 frame·브라우저 CPU가 감소했으며 원시 순서와
쌍별 변화율을 JSON에 남겼다. 예비 SVG 단독 측정과 최종 측정을 섞지 않았다.

| 항목 | 이전 | 이후 |
| --- | ---: | ---: |
| 메시지 처리 중앙값 | 71.55ms | 34.45ms |
| 두 requestAnimationFrame까지 중앙값 | 219.17ms | 150.23ms |
| 별도 32회 갱신의 Chromium 전체 CPU 중앙값 | 1,170.61ms | 876.17ms |
| 별도 32회 갱신의 Node/Playwright CPU 중앙값 | 1.38ms | 1.52ms |
| GC 후 32회 갱신의 JS heap 증가 중앙값 | 8,356 bytes | 13,912 bytes |

이 workload의 처리 시간은 약 52%, 두 frame까지는 약 31%, Chromium CPU는
약 25% 줄었다. 전체 메모리 감소는 주장하지 않는다. 지연은 물리 화면 출력 시각이
아니라 두 RAF까지이며, 실제 사용 중인 VS Code 세션이나 Native Git 시간도 아니다.
비교 harness는 원본 Graph 모듈을 실행한다. production bundle은 별도 기능 검사로
검증하고, 준비한 bundle의 hash를 VSIX와 대조한다.

원시는 `benchmarks/metadata-renderer-0.1.72171.json`, 요약은
`benchmarks/performance-summary-0.1.72171.json`에 있다.

## 검증

타입 검사와 웹뷰 회귀 검사 92개가 통과했다. HEAD/제목 갱신은 5천 node 전체 대신
세 갱신에서 node class를 18번 확인했고 선택·scroll·focus와 미변경 node/path를
유지했다. 참조/팔레트 변경 뒤 full snapshot 대조, compact marker 반복 교체,
분리된 마지막 행과 가상 행의 복구도 통과했다.

production HTML/CSP/bundle에서는 CPU 6배 제한 아래 실제 버튼 11종과 등록된
메시지 callback을 실행했다. 각 소유 fixture는 1,000 파일·1,800 commit·100
branch이고 PR 80개를 표시했다. 첫 Graph 페이지는 300행으로, 위 5천 행의 별도
비교와 구분한다. Native HEAD·refs·remote tag·local-only와 로컬 변경 보존을
대조했다. VS Code transport/picker와 PR GitHub 목록 응답은 테스트 대역이며
사용자 저장소나 OS 포커스를 변경하지 않았다.

checkout 완료 화면을 390×844, 768×1024, 1440×900에서 직접 확인했다. 기존의
고밀도 레인·가로 스크롤·PR/ref 배지·toolbar 구성을 유지한다. 검사와 화면 hash는
`benchmarks/functional-controls-0.1.72171.json`에 기록했다.

패키지 실행 파일 81개 중 Graph bundle만 바뀌었다. Node/Git runtime과 CSS는
0.1.72170과 바이트가 같아 해당 버전의 Native Node 검사 62개 결과를 재사용하며,
이를 이번 버전에서 다시 실행한 것으로 세지 않는다. 이번 버전의 실제 Native 버튼
검사는 별도로 통과했다. VSIX는 934,402 bytes이고 검증한 Graph source와 준비한
bundle hash를 패키지와 대조했다. 초기화 순서도 동일하다.
검증 근거는 `benchmarks/verification-0.1.72171.json`에 있다.

## 계속 확인할 범위

긴 renderer task는 남아 있다. 이후 지연 구간 64회에도 67개의 long task가
관측됐으므로 이번 개선을 전체 응답성 목표 완료로 기록하지 않는다. 남은 DOM 검색과
레이아웃 비용, 같은 세션의 반복 열기/갱신/닫기 수명도 확인한다.

읽기 전용 OUTPUT 관찰에서 현재 네 창의 활성 버전은 여전히 0.1.72169다.
설치 버전과 활성 버전을 구분하며 정상 reload 이후의 실제 지표는 아직 검증하지
않았다. 사용자 창을 강제로 reload하거나 포커스를 바꾸지 않는다.
관찰 근거는 `benchmarks/actual-session-observation-0.1.72171.json`에 있다.

## 배포

제품 커밋 `d315b51`을 origin/main에 푸시하고 검증한 동일 VSIX로 게시와 설치를
완료했다. SHA-256은
`1b4d77649c5206faab9b5e5f4cef13ee3657c63646ac0796389fc8af1d1a9481`이다.
설치된 실행 파일 81개가 패키지·소스와 일치하고 registry는 0.1.72171 하나다.
Marketplace 상태 점검이나 사용자 창 강제 reload는 실행하지 않았다.
배포 기록은 `benchmarks/deployment-0.1.72171.json`에 있다. 전체 성능 목표는
`benchmarks/goal-progress-0.1.72171.json`에 진행 중으로 유지한다.
