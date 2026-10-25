# 비활성 Graph 작업과 PR stack 검색 줄이기 — 0.1.72172

기준은 0.1.72171 (`7afbf266bdeeb43d4be4b2bdc87530fee5a40d29`)이다.
전체 목표는 `busy-machine-performance-plan.md`에 유지한다.

## production 경로에서 찾은 비용

실제 HTML/CSP/bundle/ready 경로에 5천 행·4,999 간선·천 브랜치·250 태그를 올렸다.
같은 바이트로 생성한 source map으로 CPU profile 위치를 연결하자 다음 전체 검색이
확인됐다. 프로파일 오버헤드를 포함한 진단이며 실제 VS Code 세션 지연은 아니다.

- PR stack이 없어도 매 알림에서 과거 chip/강조를 검색했다.
- rebase 진행 상태가 없어도 네 종류의 강조 요소를 매번 검색했다.
- 닫힌 reflog도 예약된 frame에서 viewport의 모든 행을 캡처했다.

이제 생성한 장식이 없으면 해당 정리를 생략하고, 닫힌 reflog는 frame/viewport
탐색을 예약하지 않는다. 활성 상태와 지울 장식이 있으면 기존 갱신·정리를 유지한다.
활성 stack은 reflog와의 기존 frame 순서를 유지한다. 각 layer마다 row/node를
반복 검색하던 것을 기존 행/hash 역색인과 SVG 소유 요소 조회로 바꾼다. 전체 DOM을
다시 수집하는 색인을 추가하지 않는다. WeakMap에는 캔버스별 기존 조회 함수만
연결하며, 미로딩/분리된 요소는 기존 selector로 조회한다. 모델 교체·재정렬·가상 행을
검증하고 같은 hash의 첫 실제 행 의미를 보존한다.

비트연산을 도입하지 않았다. 현재 비용은 산술보다 DOM 검색·레이아웃·paint에 있다.
일반 JavaScript Number의 비트연산은 32비트 변환 의미가 있으므로 좌표나 큰 값의
연산을 그대로 치환하지 않는다. 이번에는 중복 작업 자체를 줄였다.

## 같은 production 번들로 분리 측정

비활성 상태와 stack layer 80개 활성 상태를 각각 독립 Chromium 8개로 비교했다.
각 source는 4개 수명이고 B/A/A/B와 반대 순서를 모두 사용한다. 준비 8회 뒤
지연 16회는 CPU 6배 제한, CPU 32회와 GC 후 heap 32회는 별도 무제한 구간이다.
수명 안의 표본은 상관돼 있다. 측정 중 다른 검사·빌드는 실행하지 않았다.

이전 commit의 media·package·tsconfig를 복원해 bundle을 만든다. 기준 bundle이
게시된 0.1.72171의 SHA-256과 같아야 측정을 시작한다. 초기 probe에서 누락됐던
tsconfig의 strict prefix 13bytes를 수정한 뒤 최종 비교를 수행했다. 실제 HTTP
script route의 불변 바이트만 교체하며 나머지 HTML/CSS/입력은 같다.

| workload / 수명별 중앙값 | 이전 | 이후 |
| --- | ---: | ---: |
| 비활성 보조 기능: 메시지 처리 | 25.43ms | 24.23ms |
| 비활성 보조 기능: 두 RAF까지 | 151.02ms | 120.15ms |
| 비활성 보조 기능: Chromium CPU / 별도 32회 | 719.46ms | 634.28ms |
| stack 80개: 메시지 처리 | 23.72ms | 24.15ms |
| stack 80개: 두 RAF까지 | 428.48ms | 306.68ms |
| stack 80개: Chromium CPU / 별도 32회 | 2,487.40ms | 1,860.41ms |

80-layer 비교는 실제 chip 80개 표시를 측정 전후에 확인했다. 최종 full snapshot의
SVG와 비교하고 미변경 row/node/path·HEAD·focus·scroll을 대조했다. 짧은 초기
활성 비교와 frame 병합 후보는 최종 결과에 섞지 않았다. frame 병합은 실제 reflog
가상 행과 함께 켠 교차 검사에서 화살표 좌표가 75 대신 45로 남는 오류를 일으켜
제외했다. 기존 갱신 순서를 복원하고 현재 색인 재사용 코드로 두 workload를 모두
다시 측정했다. 호스트 부하 차이는 원시 순서와 쌍별 변화율로 남겼다.

이 최종 workload에서 화면 반영은 비활성 약 20%, stack 80개 약 28% 줄었다.
stack 80개의 Chromium CPU는 약 25% 줄었다. 전체 메모리 감소는 주장하지 않는다.
GC 후 heap 증가와 표본별 값도 JSON에 남겼다. 물리 화면 출력 시각·Native Git·
GitHub 네트워크·사용자 VS Code 세션
성능으로 확대하지 않는다. 원시는 `benchmarks/production-{inactive,stacks80}-0.1.72172.json`,
요약은 `benchmarks/performance-summary-0.1.72172.json`이다.

긴 renderer task는 남아 있다. Native 상태와 UI의 정확성을 유지하면서 남은
레이아웃 비용 및 정상 reload 이후의 실제 업데이트 세션을 계속 검증한다.
이번 배포를 전체 성능 목표 완료로 기록하지 않는다.

## 최종 검증

- 타입 검사와 웹뷰 검사 110개 통과. 공유 조회는 metadata 교체·모델 재정렬·
  분리된 DOM·가상 행을 검증했다. stack 80개에서는 chip/화살표 80개를 유지하고
  갱신 중 직접 hash selector 조회가 0회였다. 내용이 있는 reflog와의 화살표 좌표도
  최신 SVG node에 일치했다. 초기 frame 병합 후보의 실패 trace는 보존했다.
- 실제 production HTML/CSP/bundle과 등록된 메시지 callback에서 Native Git
  버튼 11종을 검증했다. 각 경우 PR 80개, 1,000 파일·1,800 commit·100 branch의
  소유 fixture를 사용하고 HEAD·refs·remote tag·local-only와 로컬 변경을 대조했다.
  Native 흐름의 첫 Graph 페이지는 300행으로 별도 5천 행 비교와 구분한다.
- checkout 완료 화면을 390×844, 768×1024, 1440×900에서 직접 확인했다. 기존
  고밀도 레인·가로 스크롤·ref/PR 배지·toolbar 구성을 유지한다.
- 같은 Node/Chromium에서 panel 8회를 열고 닫으며 측정 refresh/reveal 각 32회와
  별도 준비 refresh를 수행했다. listener는 420개로 유지됐고 종료 후 구독·늦은
  게시·Timeout은 0이다. GraphPanel·서비스·renderer는 현재 반복문이 참조하는
  각 1개만 남았으며 이전 반복이 누적되지 않았다. index/config/refs/작업 파일은
  처음과 같다. GC 후 Node heap의 초기/최종 구간 평균 차이는 약 293KiB로 유한한
  검사 예산 안이다. 실제 VS Code 장기 메모리나 RSS의 증거로 확대하지 않는다.
- 최종 프로파일도 layout root가 `#document`인 59,039개 요소의 Layout 8회를
  보였다. 불필요한 보조 검색을 줄였지만 전체 레이아웃 비용까지 해결한 것은 아니다.
- 실행 파일 81개 중 Graph bundle만 바뀌었다. Native Node runtime과 CSS는
  0.1.72171과 바이트가 같으므로 이전 Native 단위 검사 62개를 재사용한다.
  이번 버전에서 다시 실행한 것으로 세지 않으며 실제 Native 버튼 검사는 별도로
  실행했다. 비교한 두 workload와 패키지 Graph bundle 바이트가 모두 일치한다.

근거는 `benchmarks/verification-0.1.72172.json`,
`functional-controls-0.1.72172.json`, `lifecycle-0.1.72172.json`,
`production-profile-after-0.1.72172.json`에 있다. 실제 OUTPUT의 네 창은 아직
0.1.72169이며 정상 reload 이후의 실제 지표는 미검증이다. 사용자 창 강제 reload,
OS 포커스 변경, Marketplace 상태 점검은 하지 않았다.

## 배포

제품 커밋 `a75325b`를 origin/main에 푸시하고 검증한 동일 VSIX로 게시·설치를
완료했다. VSIX는 934,855 bytes이며 SHA-256은
`369a9389b55971895f4ac63914b881b2119cc766467c04086c695d6399f01940`이다.
설치된 실행 파일 81개가 소스·패키지와 일치하고 registry는 0.1.72172 하나다.
배포 근거는 `benchmarks/deployment-0.1.72172.json`에 있다. 전체 성능 목표는
`benchmarks/goal-progress-0.1.72172.json`에 진행 중으로 유지한다.
