# Undo index 스트리밍 — 0.1.72138

PR·브랜치 작업의 복구 기록에서 `ls-files --stage -z` 전체 문자열과 경로 배열을 만들던 처리를 스트림으로 바꿨다. 기존 UTF-8 digest와 stage 1/2/3 판정, 잘못된 UTF-8 파일명, Native ref/HEAD/작업 검사 및 안전한 읽기 재시도 정책을 유지한다. 각 재시도는 새 decoder/hash를 만들며 부분 결과를 저장하지 않는다.

## 대형 index 비교

이전 commit `b34ed1bc5511e6ebf0c87c567486d681b9d90c1d`과 같은 Native fixture를 B/A/A/B 순서로 비교했다. 파일 checkout 없이 100,000개 정상 index 항목(25,600,070bytes), stage 출력 24,200,000bytes를 사용했다. 시간 비교는 외부 자원 observer 없이 source당 6회다. Node 자원은 1ms 표본이며 순간 peak를 놓칠 수 있다.

| capture 측정 중앙값 | 이전 | 수정 |
| --- | ---: | ---: |
| 처리 시간(ms) | 650 | 367 |
| Node CPU(ms) | 93 | 60 |
| 관측 heap 증가(MB) | 30.64 | 16.25 |
| 관측 ArrayBuffer 증가(MB) | 24.21 | 12.17 |

최종 시리즈에서 capture의 Node CPU와 메모리는 감소했다. 앞선 파서 prototype은 느린 처리 시간과 높은 CPU를 보였고, 이전 문자열 파서 시리즈는 시간 중앙값 406→479ms로 느렸다. 구현을 수정한 이유와 모든 raw 표본을 [JSON 보고서](undo-index-state-0.1.72138.json)에 보존했다. 서로 다른 소스의 좋은 값만 합치지 않았다.

## 전체 소유 프로세스 자원과 Graph

선택 observer는 source archive/build 뒤 실제 benchmark Node만 감싼다. [Apple wait4 문서](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/wait.2.html)에 따른 종료 프로세스와 자식의 CPU 사용량, 그리고 50ms+ps 실행 간격으로 살아 있는 소유 자손의 RSS 합계를 기록했다. fixture 준비·사후 검증은 포함하며 observer/ps 자체는 제외한다. RSS는 공유 페이지 중복 합산과 짧은 자식/peak 누락 가능성이 있다.

큰 index 경로의 관측 RSS는 줄었지만 전체 Node+Git CPU는 증가한 표본이 있다. push/pull/fetch/rebase/merge/PR squash/PR replay/cherry-pick/checkout의 전후 36회도 모든 Native 상태와 최종 HEAD/ref/local-only/renderer ACK가 일치했으나 시간과 전체 Node/Git/Chromium CPU·RSS는 혼재한다. 이 자료를 일반적인 속도·전체 자원 개선 증거로 사용하지 않는다.

## 검증과 범위

- 최종 소스에서 관련 Node 70개 통과, 실패/취소/skip 0. legacy digest 호환, 모든 chunk 경계, invalid UTF-8, linked worktree, 불완전 출력, 부분 실패 후 새 reader 재시도, 쓰기 거부, PR/브랜치 Undo 및 복구 보호를 확인했다.
- 최종 Native capture 24회에서 같은 digest, 실제 index bytes/tree, fresh Undo 계획이 일치했다. Native+실제 production renderer 사례 36회도 일치했다. UI 코드는 변경하지 않았다.
- 실제 Captain은 읽기 전용으로 index header 12bytes와 stat만 읽었다: 30,311항목/4,745,895bytes, 같은 inode/크기/시각 확인. 스트레스 fixture가 더 크며 실제 작업트리나 PR을 변경해 측정하지 않았다.
- stash·복구 snapshot·보존 PR worktree는 건드리지 않았다. foreground host, OS 포커스 변경, 강제 reload, Marketplace 상태 점검은 하지 않았다.

전체 작업의 일관된 지연 감소와 자원 최소화는 아직 입증되지 않았다. 원래 전체 최적화 목표를 유지한다.
