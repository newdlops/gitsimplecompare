# Graph 검증 기준의 독립성 — 0.1.72165

제품 버전과 런타임은 `482863ac10f88c8e27a1625fe7e1704887b32884`
(`0.1.72165`)를 유지한다. 이 변경은 검증 코드이며, 새 제품 최적화나 배포의 증거로
사용하지 않는다. PR 행 이동의 pagination 수정은 기존
[0.1.72162 검증 기록](pr-row-jump-verification-0.1.72162.md)에 있다.

## 발견한 검증 한계와 수정

기존 `readNativeGraphExpectation`은 새 `GitLogService`를 만들었으므로 이전 패널의
cache 오염은 구분했지만, 제품의 log 파서와 local-only 계산 알고리즘은 공유했다.
두 경로가 같은 오답을 내는 경우를 구분하기 위해 이 의존성을 제거했다.

새 `test/helpers/nativeGraphOracle.cjs`는 제품 모듈 없이 Native Git의 log,
전체 ref/upstream, 브랜치별 `rev-list` 집합 차를 직접 읽는다. NUL 필드로 subject의
Unit Separator를 보존하고, annotated tag, merge 부모, gone/local upstream,
다른 원격 브랜치에만 게시된 commit, linked worktree를 검증한다. Native 조회는
optional 쓰기와 lazy fetch를 끄고 실제 child close 후 반환한다. 전후 HEAD와
ref/upstream 원문이 다르면 성공으로 처리하지 않는다.

독립 검증은 별도 Node에서 수행한다. 초기 기준은 제품 초기화 전에 읽고, 최종
기준은 측정 frame과 자원 counter가 끝난 뒤 읽는다. 따라서 이력 검증 자체의 CPU나
메모리를 제품 작업의 비용으로 계산하지 않는다. 초기 Graph와 renderer의 남은
frame도 작업 측정 전에 확인한다.

이 helper는 모든 local tip을 포함한 Native topo-order의 **첫 페이지**만 검증한다.
tip이 첫 페이지 밖에 있으면 그 branch의 조상도 첫 페이지 밖에 있으므로 해당
범위 조회를 생략한다. 필터나 offset이 있는 임의 구간에는 사용할 수 없다.
분기·alias·merge·서로 다른 upstream을 포함한 작은 저장소에서 전체 Native 결과를
짧은 prefix들과 대조한다. 소유 대형 입력의 첫 300개 commit도 기존 전체 branch
조회 결과와 정확히 일치했으며, Native 범위 조회가 151회에서 3회로 줄었다.
이는 **검증기 비용**의 개선이며 제품이나 사용자 UI의 속도 향상 수치가 아니다.

Apple Git의 첫 fetch가 `origin/HEAD`를 만들 수 있다는 fixture 문제도 확인했다.
이 경우 제품의 이력 재계산은 올바르다. 무변경 재사용 검사는 최초 snapshot 전에
symref를 고정하고, Native action 전후 모든 ref가 같은지 먼저 확인하도록 보완했다.

## 검증 기록

- 기존 helper에 제품 조회를 차단한 새 검사를 실행하면 독립성 검사 1개가 실패한다.
  다른 2개는 통과한다. 제품 결함의 재현으로 계산하지 않는다.
- 보완한 Native oracle과 snapshot 재사용 검사 7개가 Homebrew Git에서 통과했다.
  이전 전체 범위 oracle에서도 두 Git 구현의 관련 6개 검사가 통과했다.
- 최종 prefix oracle의 새 검사 4개는 Apple Git에서도 모두 통과했다. 다만 같은
  실행의 기존 cache 검사들은 시간 제한으로 취소됐다. 첫 실행은 5 pass / 2 cancelled,
  같은 60초 제한을 유지한 sandbox 밖 재실행은 4 pass / 3 cancelled다. 성공한 전체
  Apple 검사로 표시하지 않는다. 제품 밖 `/usr/bin/git --version`도 한 관측에서
  약 5.08초가 걸렸다. CPU load와 Native 시작 지연이 큰 이 환경에서 추가적인
  paired latency/CPU/RSS 측정은 실행하지 않았다. 검사 제한을 늘려 통과시키지 않았다.
- 작은 소유 입력(1,000 files / 1,800 commits / 100 branches, 공통 upstream 8개)에서
  건강한 이전 기준 `b9d8ed6`과 현재 제품의 18개 변형을 각각 실행해 36개 기능
  결과를 Native Git과 production HTML/CSP/JS로 대조했다. 이 기록은 시간 비교가 아니다.
- TypeScript 검사와 whitespace 검사를 통과했다. 사용자 VS Code 창의 포커스 전환,
  강제 reload, 별도 Marketplace 상태 조회는 수행하지 않았다.

대형 입력의 구버전 새-브랜치 push 두 실행은 의도적으로 중단했다. `0.1.72112`는
전체 이력을 전송 크기에 포함했고, `0.1.72126`의 최초 64개 게시 tip 제한도 이 입력의
공유 기준을 충분히 제외하지 못했다. 두 실행은 완료된 시간·자원·정확성 표본에서
제외한다. 실패한 소유 fixture와 부분 receiver는 보존했다. 그 뒤 `0.1.72164`의
18개 기능 결과는 완료됐지만, archive launcher를 중단했으므로 coordinator 전체를
성공한 비교로 표시하지 않는다. 이 실행의 완료된 Native/DOM 결과와 관측된 worker
종료는 별도로 기록한다.

원시 기록은 `/private/tmp/gsc-goal67-*`에 있다. 여기에는 이전 helper의 red 결과,
두 Git 구현의 green 결과, 작은 36개 기능 결과, 중단 사유, 전체/visible-prefix
Native oracle의 동등성 결과가 포함된다. 주입된 도구 환경에서 실행한 첫 비용
관측은 제품 성능 표본에 쓰지 않는다. 이후 깨끗한 환경에서도 결과 동등성을 확인했다.

별도 latency/CPU/RSS 비교는 아직 이 문서의 완료 증거에 포함하지 않는다. 서비스와
headless renderer의 시간을 실제 버튼·picker·GitHub 네트워크·활성 VS Code 세션의
시간으로 확대하지 않는다. 표본 RSS는 실제/물리 peak나 retained heap의 증거가 아니다.

파일별 checksum과 완료/취소 분류는
[동반 기록](benchmarks/native-graph-oracle-0.1.72165.json)에 있다.
