# 추가 ref·임시 worktree 최적화 후보 평가

이번 후보들은 배포에서 제외했다. 제품은 기존 Native ref 이름 조회와 임시 worktree
생성·정리를 유지한다. 실험 소스는 `/private/tmp/gsc-goal65-rejected-Qtc8Kl`에
해시와 함께 보관했다. 사용자 stash·복구 snapshot·보존된 PR worktree는 정리하지 않았다.

## 방법과 결과

Native worktree 실험은 캡처한 30,311개 파일·72,720개 commit의 소유 임시 복제본과
원본 그대로 복사한 post-checkout hook을 사용했다. 원본 객체는 읽기 전용 alternate로
연결하고 각 사례 뒤 임시 복제본의 index·설정·refs·객체가 같은지 확인했다.
지연과 CPU는 분리했고, 일반 비교는 각 조건당 독립 프로세스 2개를 B/A/A/B로 실행했다.
작업트리 생성과 Native 파일 검증은 정리 시간 측정에서 제외했다.

| 후보 | 지연 중앙값 | 소유 프로세스 CPU 중앙값 | 판단 |
| --- | --- | --- | --- |
| checkout worker 1 → 2 | 11,015.5 → 7,209.5 ms | 7,981.8 → 10,261.7 ms | CPU 증가로 자동 적용 제외 |
| Native remove → Native move·연결 해제·시스템 rm | 5,171.9 → 7,224.4 ms | 4,422.2 → 7,638.6 ms | 지연·CPU 모두 증가, 제외 |

시스템 find의 단일 CPU 진단도 5,327.9 ms로 나왔다. 단계별 시간에서 대부분은 삭제
자체였으며 Native move는 20.6 ms였다. 이 한 사례를 정식 비교나 개선 증거로 쓰지
않고 후속 반복 비교도 실행하지 않았다. 메모리·UI 성능은 측정하지 않았다.

## ref 이름 조회

읽기 전용 실제 Captain의 2,782개 ref에서 기존 Native short-name 조회와 원시 ref를
두 번 읽고 모호하지 않은 이름만 증명하는 후보를 비교했다. 권한·설정·refs는 바꾸지
않았고 보호 대상의 fingerprint는 모든 사례에서 같았다. 조건별 독립 프로세스 2개,
프로세스당 warm 반복 3회, 지연·CPU 분리 및 B/A/A/B 순서를 사용했다.

- 중간 후보: 지연 123.8 → 108.6 ms, CPU 87.6 → 75.9 ms였다.
- 연결 파일의 교체·원복 검사를 추가한 최종 후보: 지연 177.6 → 279.3 ms,
  CPU 86.6 → 79.2 ms였다. 호스트 변동이 컸고 지연 개선이 반복 확인되지 않았다.
- 앞선 raw·remote·raw 분리 조회와, 유효한 구두점 branch 이름 때문에 fallback한
  초기 후보도 느렸다. 이 반례를 보존하고 유리한 중간 측정만 채택하지 않았다.

최종 후보의 실제 Graph 버튼 8개와 Native/DOM/WIP 검사는 기능상 통과했지만, 이는
성능 비교가 아니다. 준비한 48사례 버튼 비교는 실행하지 않았다. prototype의 추가
조회·이름 증명·계수 진단은 모두 제품과 공유 benchmark에서 원복했다.

실험 중 발견한 연결 교체·원복 문제는 기존 private status에서도 별도로 재현했다.
그 안전 수정만 `0.1.72164`에 반영한다.

원시 상태 기록: `/private/tmp/gsc-goal65-checkout-workers-state.json`,
`gsc-goal65-remove-files-state.json`, `gsc-goal65-remove-find-state.json`,
`gsc-goal65-proven-ref-v2-state.json`, `gsc-goal65-proven-ref-v3-state.json`.
