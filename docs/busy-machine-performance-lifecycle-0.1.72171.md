# 0.1.72171 수명·렌더링 후속 검증

이번 단계는 검증 범위를 넓혔다. 제품 source·CSS·설치 파일은 기존 0.1.72171과
바이트가 같다. 새 최적화는 채택하지 않았으며 버전업·재게시·재설치를 하지 않는다.
전체 목표는 계속 진행 중이다.

## 같은 세션의 반복 수명

독립된 두 Node/Chromium 실행 각각에서 Graph를 8번 열고 닫았다. 각 반복은 실제
production HTML/CSP/bundle과 실제 Git을 사용하며, 첫 조작을 준비한 뒤 refresh
버튼 4회와 숨김→갱신 요청 두 번→공개 show 명령을 통한 reveal 4회를 수행한다.
따라서 실행당 측정 refresh 32회, reveal 32회와 별도 준비 refresh 8회다.
같은 Chromium/Node 수명 안에서 panel만 교체하고 절반은 조회 중에 닫았다.

소유 fixture는 1,000 파일·1,800 commit·100 branch·PR 카드 80개다. GitHub 목록
응답과 VS Code 창/transport 이벤트는 대역이다. Native 서비스와 GraphPanel의
실제 공개 createOrShow/refresh 경로, 구독·해제의 Disposable 배열 의미는 유지한다.
사용자 저장소·OS 포커스·실제 VS Code 창은 조작하지 않는다.

- 준비 후 DOM listener는 420개였고 모든 반복 뒤에도 420개다. 최종 DOM은
  8,947 node/1 document로 돌아온다. 검사 중 일시적인 node 수 차이는 있었다.
- 닫힌 panel의 구독과 늦은 게시가 모두 0이다. 숨겨진 상태의 중복 요청은 Native
  조회를 추가하지 않았고, reveal은 기존 panel을 재사용한다.
- 각 종료 뒤 Git은 idle이고 열린 browser context는 0이다. Node에는 공유 browser의
  ProcessWrap 1개와 PipeWrap 4개만 남았으며 Timeout은 0이다.
- 작업 파일·index·config·refs 바이트가 처음과 같다. 성공한 소유 fixture만 정리했다.
- 두 번째 실행은 V8의 도달 가능한 GraphPanel·GitLogService·GraphLiveRenderer
  객체 수도 읽었다. 각각 매회 1개다. 현재 반복문의 지역 변수가 마지막 객체를
  참조하고 있으나 이전 반복의 객체가 누적되지 않는다.
- 준비 뒤 첫 3회와 마지막 3회의 GC 후 Node heap 평균 차이는 첫 실행 약 303KiB,
  두 번째 실행 약 185KiB다. 3MiB의 유한한 검사 예산 안이다. 이는 실제 VS Code의
  장기 메모리·RSS나 할당이 전혀 없다는 증거로 확대하지 않는다.

첫 두 실패 probe는 브라우저 도구의 첫 locator/click 초기화 전 394개를 baseline으로
삼아 420개로 증가한 것을 감지했다. 실제 click과 Native/DOM 검증을 먼저 준비한
뒤 측정하자 매 round에서 420개로 유지됐다. 실패한 소유 fixture는 보존했다.

원시는 `benchmarks/lifecycle-0.1.72171.json`과
`benchmarks/lifecycle-confirmation-0.1.72171.json`이다. 다시 실행하려면 Node 22에서
다음을 사용한다. foreground Extension Host는 필요하지 않다.

```sh
GSC_BENCH_FILES=1000 GSC_BENCH_COMMITS=1800 GSC_BENCH_BRANCHES=100 \
GSC_BENCH_SHARED_UPSTREAM_BRANCHES=8 \
node scripts/benchmark-graph-lifecycle.mjs /tmp/gsc-lifecycle.json
```

## 남은 렌더링과 채택하지 않은 실험

5천 행/4,999 간선의 원본 모듈에 CPU 6배 제한과 CPU/timeline profiler를 적용했다.
프로파일링 오버헤드를 포함한 진단이며 비교 측정이나 실제 VS Code 지연이 아니다.
8번의 Layout마다 dirty object는 11개지만 layout root는 `#document`, 대상은
53,971개였다. 전체 문서 레이아웃과 paint가 다음 조사 대상이다. production
HTML/bundle 경로에서도 원인을 확인한 뒤 변경을 수락한다.

CSS 행 격리는 같은 전체 문서 layout을 유지해 제품에 적용하지 않았다. SVG 원을
보존하고 툴팁만 바꾸는 실험은 기능 검사 12개가 통과했지만 독립 Chromium
B/A/A/B와 반대 순서 비교에서 CPU 이득이 일관되지 않았다.

| 실험 지표의 수명별 중앙값 | 이전 | 실험 |
| --- | ---: | ---: |
| 메시지 처리 | 51.15ms | 39.95ms |
| 두 RAF까지 | 231.68ms | 172.40ms |
| 별도 32회 Chromium CPU | 981.62ms | 1,049.97ms |

부하가 변한 일부 비교 쌍은 더 느렸다. 지연 중앙값만으로 채택하지 않고 제품과
해당 기능 검사 변경을 모두 되돌렸다. 재현 patch와 원시는
`benchmarks/rejected-title-candidate-0.1.72171.{patch,json}`에 있다.
프로파일 재현 도구는 `scripts/profile-graph-updates.mjs`이며 원본 CPU/timeline은
소유 임시 경로에 보관하고 저장소에는 진단 요약만 남겼다.

최신 읽기 전용 OUTPUT의 네 창은 아직 0.1.72169다. 정상 reload 뒤의 실제
업데이트 세션 지표는 계속 미검증이며 강제 reload를 하지 않는다. 전체 요약과
남은 범위는 `benchmarks/lifecycle-profile-summary-0.1.72171.json`,
`benchmarks/actual-session-followup-0.1.72171.json`,
`benchmarks/goal-progress-0.1.72171.json`에 기록했다.
