# 0.1.72173 — PR 연결 표시 재사용

PR stack의 칩과 화살표를 매번 삭제·생성하던 경로를 부분 갱신으로 바꿨다.
브랜치와 중복 출현 순서로 같은 버튼을 재사용하고, 실제 행 교체·표시 상태·좌표·
설명이 달라진 부분만 쓴다. 사라진 layer의 DOM과 참조는 제거한다.
reflog와의 기존 callback 순서는 유지하며, 재정렬로 이동한 버튼에는 같은 PR의
포커스를 스크롤 이동 없이 복원한다. Git 작업·CSS·문구·버튼 기능은 동일하다.

## 성능 근거

실제 production HTML/CSP/bundle/ready, 5000행·4999간선·PR 연결 80개에서
두 frame까지의 중앙값은 **290.1 → 191.8ms**, 32회 갱신의 Chromium CPU는
**1594.6 → 898.9ms**였다. 네 비교 쌍 모두 frame과 CPU가 줄었다.
메시지 handler는 21.4 → 21.8ms로 개선을 주장하지 않는다.

각 조건에 독립 browser 8개를 B/A/A/B 및 A/B/B/A 순서로 사용했다.
latency는 CPU 6배 제한이며 CPU·GC 후 heap은 별도 비제한 구간이다.
같은 browser의 표본은 상관돼 있다. 실제 사용자 VS Code나 GitHub 네트워크
지연을 측정한 수치가 아니다.

PR stack 미표시 조건의 frame은 119.3 → 118.6ms로 비슷했다. 이 조건의 CPU
중앙값은 약 10.5% 늘었고 개별 실행 변동이 컸다. CPU 감소나 동등성을 주장하지
않는다. 미표시 시 예약을 생략하는 기존 guard는 같은 source를 유지했다.
전체 메모리·RSS 감소도 주장하지 않는다. raw 표본은 성능 기록에 모두 보관했다.

## 검증

- 최종 기능 검사 13개 통과: 같은 표시의 소유 DOM 쓰기 0회, 80개 표시 유지,
  행 교체, 레이어 재정렬·포커스, 상태 변경, 누락 node, 새 캔버스, 해제·복원,
  reflog 좌표, 기존 stack 액션을 확인했다.
- 실제 Native Git checkout·PR squash 각 80 PR 카드 조건에서 refs·HEAD·태그·
  local-only 표시와 작업 파일 보존이 정확했다.
- 같은 Node/browser에서 8회 열기·닫기, 32회 refresh와 32회 reveal 검사 통과.
  닫힌 subscription·늦은 post·남은 browser context는 0이다. 기본 Graph lifecycle
  검사와 활성 stack의 별도 heap/해제 검사를 구분한다.
- 390×844, 768×1024, 1440×900의 최종 렌더를 직접 확인했다.
- 타입 검사·production package 통과. 배포 대상 runtime 중 Graph bundle만 바뀌며
  나머지는 0.1.72172와 같은 바이트다. 기존 Native Node 62개 검사는 동일 runtime
  근거로 재사용했으며 이번 버전에 다시 실행했다고 세지 않는다.

## 남은 실제 세션 확인

배포한 동일 소스로 독립 Node/browser 24회의 초기 로드도 감사했다. CPU 제한은
HTML 탐색 전에 적용했다. ready는 124.5 → 110.5ms, 첫 frame은 617.5 → 564ms,
최종 frame은 817.5 → 757ms였다. 별도 소유 프로세스 CPU는 약 7.1% 늘었고
표본 합산 RSS는 약 565MiB로 비슷했다. 초기화 CPU·메모리 감소나 동등성을
주장하지 않는다. RSS는 공유 페이지와 표본 간격을 포함하는 소유 프로세스 합이며
정확한 물리 메모리 peak가 아니다. 24회 모두 Native Git·최종 DOM 일치 검사를 통과했다.

16:18 UTC까지는 열린 4개 창이 이전 runtime이었으나, 16:37 UTC 이후 실제 열린
로그 핸들에서 **4개 모두 0.1.72173 실행**을 확인했다. 이전 실행 버전 차단 조건은
해소됐다. 실제 첫 화면 trace는 300행 렌더 17ms·후속 frame 44ms였고, 작업트리
갱신은 렌더 31ms·frame 8ms였다. 완료된 첫 화면의 전체 918ms 중 Git log 단계가
853ms였다. 이 wall time에는 Native 작업 외에 호스트 이벤트 처리 지연도 들어갈 수 있다.

실제 저장소의 읽기 전용 분리 진단에서는 브랜치 164개·추적 70개·upstream 16개,
누적 tracking 거리 254728을 확인했다. 브랜치 조회 112–333ms, 로그 155–285ms,
진단 Node 자체 CPU 2–5ms였으며 보호한 HEAD/index/config/packed-refs는 동일했다.
이 값은 별도 Node이며 실제 확장 호스트의 CPU나 Native 자식 CPU로 오인하지 않는다.

실제 세션 32.7초 관찰 중 시스템 부하는 약 26–33이었다. 호스트 전체 CPU는 한
코어 기준 약 0.24–3.18%였으나 다른 확장도 포함하므로 우리 확장에 귀속하지 않는다.
이 관찰과 위 첫 화면 trace의 시점은 다르다. 같은 부하 구간에서 새 실제 응답을
확인하려고 수동 조작 없이 관찰했으나 새 frame은 없었다. 이는 통과 결과가 아니다.
직접 새로고침 또는 한 창의 잠깐 활성화 허용을 요청했고, 포커스를 강제로 옮기지 않았다.

추적 계산 기준을 64개·16 upstream으로 넓힌 별도 실험도 Native 값과 32회 모두
엄격 일치했지만, Native 자식 CPU 중앙값이 **72.1 → 102.5ms**로 늘어 채택하지 않았다.
현재 제품 기준은 그대로다. 비교기의 객체 필드 삽입 순서 오탐만 수정했으며,
값·타입·배열 순서는 deep strict equality로 검증한다. 해시 비교 보조 검사 4개와
타입 검사를 통과했다. 이 후속 작업은 제품 runtime을 바꾸지 않아 추가 버전업·배포하지 않는다.

[성능 원시 표본과 요약](benchmarks/performance-summary-0.1.72173.json),
[기능·수명 검증](benchmarks/verification-0.1.72173.json),
[초기 로드 감사](benchmarks/cold-summary-0.1.72173.json),
[패키지 바이트 검증](benchmarks/release-artifact-0.1.72173.json),
[동일 VSIX 배포·설치 기록](benchmarks/deployment-0.1.72173.json),
[실제 실행·읽기 전용 진단과 미확인 범위](benchmarks/actual-runtime-validation-0.1.72173.json),
[전체 목표 감사와 남은 조건](benchmarks/goal-progress-0.1.72173.json).
