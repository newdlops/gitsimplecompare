# Rebase Start의 범위 조회 축소 — 0.1.72129

정상 Start에서 topology와 todo coverage를 같은 Native hash/parent 조회로 검증한다. 별도 merge scan과 사용하지 않는 본문 로딩을 제거했다. 누락된 todo의 설명에만 기존 canonical metadata를 보강하고, 그 조회가 다른 HEAD를 보더라도 이미 실패한 coverage를 성공으로 바꾸지 않는다.

**검증한 감소량:** Git 프로세스 7 → 6개, 범위 조회 2 → 1회. 6개의 1MiB 본문을 가진 fixture에서 host로 전달한 범위 데이터는 6,292,002 → 492바이트였다. 실제 Native 회귀 사례도 1,310,899 → 164바이트이며 재작성 후 원래 큰 본문을 그대로 보존했다.

## 반복 측정과 한계

같은 harness로 0.1.72128과 후보 코드를 before/after/after/before/before/after 순서로 직렬 비교했다. 각 모드·버전·시리즈당 표본 3개다. 첫 비교는 각 source의 기본 editor 경로, 진단 비교는 SHA-256이 같은 하나의 editor 경로를 사용했다. UI media는 각 production source 그대로다. 두 비교의 모든 표본을 유지한다.

| 시리즈 | 모드 | 전체 Start 중앙값 이전 → 현재(ms) | Node CPU 이전 → 현재(ms) |
| --- | --- | ---: | ---: |
| paired | messages-and-squash | 1,182 → 1,252 | 38 → 29 |
| paired | reorder | 506 → 320 | 28 → 18 |
| common | messages-and-squash | 4,661 → 5,055 | 39 → 39 |
| common | reorder | 1,569 → 2,050 | 28 → 45 |

| 실제 rebase 버튼 | 클릭 → 최종 Graph frame 이전 → 현재(ms) | handler 이전 → 현재(ms) |
| --- | ---: | ---: |
| paired | 727 → 1,486 | 506 → 1,383 |
| common | 6,797 → 7,243 | 6,137 → 7,082 |

전체 Start와 실제 버튼 지연의 일관된 개선은 확인하지 못했다. 같은 editor 경로의 진단도 경로가 첫 비교 지연 차이의 원인임을 증명하지 않았다. 이 릴리스는 데이터량·프로세스 감소를 주장하며, 모든 작업의 체감 속도나 전체 OS CPU/RSS 감소로 확대하지 않는다. Node CPU에는 관찰·대기 비용이 포함되고 Git/editor/Chromium CPU는 제외한다. RSS 증가량에는 GC 영향이 있어 peak 절감으로 해석하지 않는다.

## 안전성과 최종 검증

초기 59개 실행에서 metadata 교체 주입기가 예전 log에만 연결되어 1개 실패했다. 실제 compact range 조회 직후에도 교체를 주입하도록 고쳐, 다른 저장소 queue에 쓰지 않고 중단하는 기존 요구를 유지했다. 최종 59개가 모두 통과했고 SHA-1/SHA-256 root Start를 포함한 22개를 추가 검증했다(고유 항목 61개). 두 번의 최신 checkout 검사, merge/불완전/중복 metadata 거부, subject 오류 설명과 원래 본문·tree·queue 정리가 확인됐다.

최종 기본 editor 경로의 Git/Graph 18개와 실제 push·pull·fetch·rebase 버튼 4개, 타입 검사도 통과했다. 비교 시 Native 24개·실제 버튼 12개는 별도 표본이다. 실제 VS Code API·창·선택 대화상자는 대역이며 화면 포커스나 창 재로드를 요구하지 않았다.

범위 쿼리는 사용자 subject/body를 파싱하지 않아 메시지의 제어 문자가 topology 검증 자료에 섞이지 않는다. UI·복원에 필요한 전체 메시지 조회는 유지한다. 전체 push/pull/fetch/rebase/merge/PR/cherry-pick/checkout과 최종 Graph 지연·자원 목표는 계속 진행 중이다.
