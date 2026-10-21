# 전체 Git 작업 및 최종 Graph 재검증 — 0.1.72126

최종 Native Git 상태와 실제 렌더링 상태는 **108개 작업 사례와 24개 버튼 사례 모두 일치**했다. Git 호출 비용은 줄었지만, 전체 실행 시간의 일관된 개선은 확인하지 못했다. 느린 현재 버전의 마지막 측정도 모두 포함한다.

비교: 0.1.72112 (b9d8ed66f58156095e094f2ec1d5e4ac4d07cd9b) → 0.1.72126 (f9e314d9bdc7419cabbac5a56c8c3f940949d8df). 동일한 현재 harness로 각 버전을 세 번씩, before/after/after/before/before/after 순서로 직렬 실행했다.

합성 fixture: 파일 1,000개, commit 1,000개, local branch 100개, 같은 upstream을 공유하는 branch 48개, 소유한 local bare remote. 사용자 Captain 작업트리와 외부 서버에는 쓰지 않았다. 브라우저는 headless로 실행했으며 창 포커스나 VS Code 재로드를 요구하지 않았다.

## Git 작업부터 최종 화면까지

아래 값은 버전별 세 번의 중앙값(ms)이다. 최종 화면 시간은 각 표본의 서비스 실행 시간과 Git 완료 후 최종 frame ACK까지의 합으로 계산했다. 두 중앙값을 사후에 더하지 않았다. 초기 Graph는 Git 작업 시간이 0이며, browser 시작 시간은 제외한다.

| 작업 | Git 준비·실행 이전 → 현재 | 작업 시작 → 최종 화면 이전 → 현재 | Git 호출 이전 → 현재 |
| --- | ---: | ---: | ---: |
| initial | 0 → 0 | 866 → 715 | 13 → 11 |
| fetch-new-history | 310 → 827 | 716 → 1,146 | 12 → 9 |
| pull-new-history | 696 → 1,321 | 1,060 → 1,592 | 15 → 12 |
| push | 997 → 2,432 | 1,687 → 3,097 | 25 → 25 |
| push-tracked | 1,202 → 1,218 | 1,477 → 1,650 | 23 → 20 |
| pull | 758 → 857 | 1,557 → 988 | 10 → 9 |
| pull-known-history | 846 → 897 | 1,320 → 1,058 | 10 → 9 |
| fetch | 278 → 819 | 693 → 1,388 | 7 → 6 |
| fetch-known-history | 237 → 355 | 644 → 523 | 7 → 6 |
| fetch-no-change | 137 → 156 | 494 → 280 | 7 → 6 |
| rebase | 1,691 → 1,203 | 1,888 → 1,922 | 24 → 23 |
| merge | 1,028 → 1,258 | 1,579 → 1,746 | 25 → 21 |
| merge-no-ff | 414 → 294 | 1,294 → 910 | 12 → 9 |
| pr-squash-cherry-pick | 2,940 → 1,238 | 3,271 → 1,417 | 35 → 30 |
| pr-cherry-pick | 1,203 → 1,720 | 1,896 → 2,460 | 36 → 31 |
| cherry-pick | 129 → 66 | 665 → 490 | 12 → 9 |
| checkout | 334 → 200 | 604 → 316 | 9 → 8 |
| checkout-unloaded | 174 → 220 | 434 → 451 | 12 → 11 |

## 실제 버튼과 등록된 callback

버튼 클릭부터 최종 frame까지 별도로 측정했다. 실제 production HTML/CSP/JS와 Native Git을 사용하되 VS Code API·창·선택 대화상자는 테스트 대역이다. rebase는 reword·squash 메시지, commit 순서, 최종 tree까지 확인한다.

| 버튼 | 클릭 → 최종 화면 중앙값 이전 → 현재(ms) | Git 호출 이전 → 현재 |
| --- | ---: | ---: |
| push | 1,501 → 735 | 30 → 30 |
| pull | 632 → 633 | 20 → 17 |
| fetch | 502 → 556 | 12 → 9 |
| interactive-rebase | 1,236 → 1,413 | 42 → 31 |

## 자원과 측정 범위

18개 작업 합계의 중앙값: Git 호출 294 → 255, benchmark Node CPU 2567 → 2249ms. 최대 동시 소유 slot 중앙값 4 → 4.

같은 합계의 서비스 시간은 12,253 → 14,142ms, 최종 frame까지는 20,184 → 21,277ms다. 따라서 전체 체감 속도 개선을 주장하지 않는다.

Node CPU에는 Playwright 통신과 sampling 비용이 포함되고 Git·Chromium·OS CPU는 포함되지 않는다. RSS는 10ms 간격의 Node 증가량으로 전체 메모리 절감의 증거가 아니다. 세 표본과 외부 부하가 통제되지 않은 환경이라는 한계가 있다.

## 정합성과 재현

측정 구간 밖에서 독립된 새 서비스에 Native local·remote tip을 공급하고 local-only 계산 완료를 확인한다. 패널이 삼킨 metadata 오류도 실패로 처리한다. 중간 게시와 같은 signature가 반복되면 마지막 게시의 frame ACK를 확인한다. 새 fetch/pull과 화면 밖 checkout은 history를 한 번 읽고, 화면 안 checkout은 기존 history를 재사용하는지도 assert한다.

이전 0.1.72121 보고서는 최종 게시 선택 방식과 shared-upstream fixture가 달라 수치를 합산하지 않는다. 각 원본 파일의 SHA-256과 재현 harness SHA-256, 모든 표본·범위·한계는 옆 JSON에 기록했다.

전체 목표는 계속 진행 중이다. 많은 서버 branch·unknown/promisor tip, 일반 push 및 일관된 작업→최종 화면 지연과 전체 자원 사용은 추가 개선 근거가 필요하다.
