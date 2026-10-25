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

새 버전 설치와 현재 열린 창에서의 실행은 다르다. 읽기 전용으로 확인한 사용자
창의 활성화 로그는 아직 0.1.72169였다. 일반적인 창 재시작 이후 새 runtime의
실제 CPU·메모리·사용 지연을 확인해야 전체 목표의 완료를 입증할 수 있다.
사용자 창의 포커스를 바꾸거나 강제로 reload하지 않는다.

[성능 원시 표본과 요약](benchmarks/performance-summary-0.1.72173.json),
[기능·수명 검증](benchmarks/verification-0.1.72173.json),
[패키지 바이트 검증](benchmarks/release-artifact-0.1.72173.json).
