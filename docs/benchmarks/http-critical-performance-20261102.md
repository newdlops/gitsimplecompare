# HTTP critical path 최종 측정

P1–P5를 기준 커밋 `590c8fc`와 제품 소스 `a211291`에서 각각 번들해 비교했다.
각 경로는 순서를 교대한 5쌍이며 모든 표본의 사용자 payload digest가 같았다.
API 지연은 통제값이고 inspector만 소유한 localhost HTTP/WS를 사용했다. 실제 GitHub 지연으로 해석하지 않는다.

| 경로 | 요청 수 전→후 | 응답 body B 전→후 | p50 ms 전→후 | p95 ms 전→후 |
| --- | ---: | ---: | ---: | ---: |
| P1 | 2→2 | 359→359 | 82.06→62.03 | 85.92→62.71 |
| P2 | 10→1 | 74,900→187 | 99.71→10.77 | 103.52→11.29 |
| P3cold | 3→3 | 27,669→27,669 | 32.23→33.38 | 34.43→36.35 |
| P3warm | 1→1 | 13,563→211 | 11.41→11.38 | 30.89→12.20 |
| P3staleHint | 3→4 | 27,669→27,838 | 32.54→47.59 | 45.01→99.52 |
| P4 | 4→4 | 217→217 | 96.84→81.40 | 98.01→81.53 |
| P5 | 3→3 | 59→57 | 105.00→4.69 | 111.88→8.04 |

요청 수와 응답 body는 각 경로의 첫 표본이다. 전체 표본·event 순서·최대 동시성·payload digest는
[JSON](http-critical-performance-20261102.json)에 보존했다. body는 압축 해제된 응답 내용만 세며
요청 문서·HTTP/WS framing·TLS 및 실제 압축 wire bytes는 포함하지 않는다.
mutable API 응답 cache TTL은 0으로 두고 완전한 immutable snapshot만 재사용했다.
p50/p95는 서비스의 완전한 데이터 준비 완료 시점이며 실제 UI paint는 측정하지 않았다.

## 효과와 비용

- P1: 리뷰 tail과 commit tail이 함께 시작하며 요청 수·body는 같다.
- P2: rename 없는 파일 1000개를 REST 10회 대신 인가된 앵커 1회로 재사용한다. rename/copy·미지원 상태·3,000개 상한은 회귀 검사에서 기존 REST 의미를 유지한다.
- P3: cold는 기존 3회이고 warm은 같은 1회에서 첫 커밋 body를 생략한다. 이 고정 지연 fixture에서 warm latency 개선을 입증하지는 않았다. 인증·base 등이 달라 힌트가 빗나가면 전체 페이지 복구에 1회가 추가된다. 다른 PR의 cache만 있는 경우는 얕은 쿼리를 선택하지 않도록 별도 RED→GREEN 검사로 확인했다.
- P4: C가 B 종료 전에 시작하지만 최종 HTML과 URL 상한 우선순위는 BFS 순서를 유지한다. 기존 두 슬롯과 깊이 2·URL 120 한도를 유지한다.
- P5: 무관한 HTTP가 끝나기 전에 실제 PID를 확인한다. 기본 포트·유효한 힌트 우선권을 유지하고, 나머지 포트는 도착 순서로 한 개씩 PID를 검증한다. 승자와 취소된 HTTP/WS 모두 소유 socket close 뒤에 완료한다.
- P6: [별도 실제 계정 실험](oauth-catalog-projection-20261102.md)에서 projection의 목록 동등성과 지연 게이트가 실패해 기존 REST+ETag를 유지했다.

## 재현

```sh
node scripts/benchmark-http-critical-path.mjs
```

실제 계정이나 원격 쓰기는 사용하지 않는다. 임시 source archive·설정 파일·서버는 실행 후 정리한다.
5개 표본의 p95는 가장 큰 관측값이다. 작은 latency 차이와 OS·파일시스템 변동을 일반적인 속도 향상으로 확대하지 않는다.
