# 실제 Git 설정과 Graph 시작 비용 개선 — 0.1.72170

기준은 0.1.72169 (`2f6331eaaeee5b96b95944d31795aba12895dc2f`)다.
전체 목표는 `busy-machine-performance-plan.md`에 유지한다.

## 실제 설정에서 적용되지 않던 탐색 공유

현재 VS Code OUTPUT의 Git 설정은
`/Library/Developer/CommandLineTools/usr/bin/git`이다. 이전 anchor 공유는
설정 값이 정확히 `git`인 경우에만 적용돼 이 설정을 제외했다.

이제 표준 설치 경로와 최종 symlink 대상의 Native 파일 헤더를 확인한 절대 경로도
공유한다. 완료된 executable 판정은 캐시하지 않는다. 같은 시점의 파일 확인만
합치고 파일 handle을 닫는다. 알 수 없는 wrapper, 발견 환경 override,
상대 config·중첩/bare·불확실한 경계는 기존 Native 조회를 유지한다.
실행할 Git을 바꾸거나 사용자 설정·작업 파일·index·refs를 수정하지 않는다.

같은 Apple Git 경로로 34개 실제 폴더 요청을 비교했다. 12개 독립 Node에서
latency·CPU·sampled RSS를 나누고 B/A/A/B 순서로 실행했다. 요청 종류별 Node 내
두 표본은 서로 상관돼 있다. Native root/branch와 HEAD·index·config·refs 바이트를
각 burst 전후에 검증했다.

| 항목 | 이전 | 이후 |
| --- | ---: | ---: |
| burst당 Native 조회 | 34회 | 1회 |
| 지연 중앙값 | 178.56ms | 136.91ms |
| Node + 종료된 Native 자식 CPU 중앙값 | 538.43ms | 54.24ms |
| 별도 구간 sampled RSS 중앙값 | 71.56MiB | 58.05MiB |

Native 조회 수 감소는 실제로 설정된 실행 경로에서 검증했다. 이 지연 수치는 소유한
작은 저장소의 조회이며 실제 사용자 창 전체 동작 시간을 대신하지 않는다.

## 자산 로드부터 포함한 Graph 시작

Graph의 기존 초기화 순서 그대로 55개 스크립트를 하나의 browser bundle로 만든다.
Node bundle과 browser bundle을 모두 빌드해야 package가 완료되며 watch의 첫
실행도 두 자산이 준비된 뒤 진행한다. 원본 모듈은 개발에 유지하고 VSIX에서는
사용하지 않는 standalone Graph JS 46개를 제외한다. CSS와 다른 화면의 공유 JS는
이전과 바이트가 같다. CSP nonce와 local resource 범위는 유지한다.

기존 측정은 웹뷰 mount 뒤에 시작했다. 새 측정은 빈 동일-origin shell에서
production HTML 탐색 전에 CPU를 제한하고 실제 ready callback·Native 조회·
첫/최종 frame까지 포함한다. 소스/fixture 준비로 OS 파일 캐시는 따뜻하지만 browser
자산은 새 context에서 읽는다. 패널 HTML 조립 이전의 활성화 전체 시간은 포함하지 않는다.

24개 독립 Node/Chromium을 B/A/A/B와 반대 순서로 실행했다. 지연 renderer만 CPU
6배 제한이고 CPU·RSS 구간은 별도로 제한 없이 측정했다.

| 항목 | 이전 | 이후 |
| --- | ---: | ---: |
| JS 요청 | 55개 | 1개 |
| JS decoded bytes | 498,850 | 223,159 |
| ready 중앙값 | 667.50ms | 285.50ms |
| 첫 Graph frame 중앙값 | 2,403.50ms | 2,022.00ms |
| 마지막 Graph frame 중앙값 | 2,883.50ms | 2,561.50ms |
| Node + Native 자식 + Chromium CPU 중앙값 | 2,543.84ms | 1,841.31ms |
| 별도 구간 sampled RSS 중앙값 | 568.84MiB | 579.01MiB |

이 시작 workload에서 첫 frame은 약 16%, CPU는 약 28% 줄었다. Graph 시작의 RSS
감소는 주장하지 않는다. RSS는 관측된 동시 합계이며 실제 물리 최대값이 아니다.
Node에는 Playwright transport 비용도 포함된다. GitHub 네트워크 지연이나 사용자의
실행 중인 VS Code 세션을 측정한 수치로 해석하지 않는다.

## 검증과 남은 범위

- 실제 Git·저장소 검사 62개, 웹뷰 검사 81개와 타입 검사 통과.
- 실제 production bundle/CSP에서 PR 80개를 표시하고 Git 버튼 11종을 클릭해
  Native HEAD·refs·remote tag·local-only와 작업 파일 보존을 확인했다.
- 390×844, 768×1024, 1440×900의 실제 완료 화면을 직접 확인했다.
  선택·PR 이동·드래그·검색·가로 스크롤·loading·오류·키보드 동작도 검사했다.
- VSIX의 browser bundle이 측정한 bundle 바이트와 같고 초기화 순서가 기존 55개
  script 순서와 같음을 대조했다. 패키지는 1,025,627 → 933,750 bytes다.
- 실패한 측정용 fixture는 보존했다. 첫 cold probe의 검증 인자 오류와 custom Git
  fixture의 xcrun symlink 이름 문제는 제품 실패로 세지 않았고 수정된 검증은 통과했다.

전체 목표는 계속 진행 중이다. 누적 Graph의 metadata delta에서 전체 SVG/DOM을
훑는 비용과 긴 renderer task, 같은 세션의 반복 갱신 수명, 정상 reload 이후의 실제
세션 지표를 더 확인한다. 이번 배포를 전체 성능 목표 완료로 대신하지 않는다.

원문과 요약은 `benchmarks/cold-startup-0.1.72170.json`,
`absolute-discovery-0.1.72170.json`, `performance-summary-0.1.72170.json`,
`functional-controls-0.1.72170.json`에 있다. 실제 설정 관찰은
`actual-configuration-observation-0.1.72170.json`에 경로를 제외하고 기록했다.

## 배포

제품 커밋 `c63bc8f`를 origin/main에 푸시했고 동일 VSIX로 publish와 설치가 성공했다.
SHA-256은 `f102bb54e9e33d282cc7354af26130ed8106b5f0f8e49bca174f17458b6b1274`다.
소스·패키지·설치된 실행 파일 81개가 일치하며 registry는 0.1.72170이다.
사용자 창은 강제로 reload하지 않았다. 설치 기록은
`benchmarks/deployment-0.1.72170.json`에 있다. 전체 목표 상태는 active다.
