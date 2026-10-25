# Graph 정리 탐색 실험 — 채택하지 않음

기준은 배포·설치된 0.1.72172다. reflog 가상 행과 PR stack의 칩·행·overlay를
직접 추적해 제거하는 후보를 시험했다. 활성 callback 순서는 유지했다.

| 조건 | 메시지 처리 ms | 두 frame ms | Chromium CPU ms / 32회 |
| --- | ---: | ---: | ---: |
| 보조 표시 없음 | 50.1 → 29.5 | 271.5 → 332.5 | 940.4 → 1460.9 |
| PR 연결 80개 | 64.5 → 32.4 | 963.8 → 777.7 | 4612.4 → 5243.3 |

5000행·4999간선의 실제 production HTML/CSP/bundle/ready를 사용했다.
조건별 독립 Chromium 8개에서 B/A/A/B와 A/B/B/A 순서를 사용했다.
latency는 CPU 6배 제한, CPU와 GC 후 heap은 별도 비제한 구간이다.
수치는 source별 네 browser 중앙값의 중앙값이며 같은 browser 내부 표본은 상관돼 있다.

**메시지 처리 감소만으로 채택하지 않았다.** 최종 실행에서 일반 조건의 frame·CPU와
80개 연결 조건의 CPU가 늘었다. 호스트 부하 변동이 있어 이 기법 자체의 인과적인
회귀를 확정하는 자료는 아니지만, 전체 성능 개선을 입증하지 못한 후보는 배포하지 않는다.

후보 기능 검사 21개는 통과했다. 별도 광범위 검사는 20개 통과 후 의도적으로 중단했다.
중단·미실행을 통과로 세지 않는다. 제품·테스트 source를 원복하고 배포 bundle의
동일 바이트를 다시 빌드했다. 버전업·추가 배포·창 reload는 하지 않았다.

다음 후보는 활성 장식의 DOM 재생성과 layout/paint를 구분해 측정해야 한다.
`Layout`의 root가 `#document`이고 `totalObjects`가 크다는 사실만으로 모든 객체를
재계산했다고 해석하지 않는다. 실제 업데이트된 VS Code 세션의 CPU·메모리도 아직 별도 확인이 필요하다.

[원시 표본과 검증 기록](benchmarks/graph-owned-cleanup-experiment-2026-10-26.json),
[채택하지 않은 재현용 patch](benchmarks/graph-owned-cleanup-experiment-2026-10-26.patch).
