# 원격 branch가 많은 새 push의 게시 이력 탐색 — 0.1.72128

원격의 검증된 tip 중 앞의 64개에 실제 분기점이 없으면, 이미 게시한 이력까지 새 전송으로 계산하던 문제를 수정했다. 기존 recent-commit 조회를 최대 65개 행으로 넓혀 Native source first-parent에 실제로 있고 같은 push 서버가 광고한 가장 가까운 base를 찾는다. 기존 64개 제외 tip을 유지하며 추가 base는 최대 1개다. Git 조회 프로세스를 추가하지 않는다.

## 실제 Native push 비교

동일한 local bare receiver와 공통 harness로 0.1.72127과 후보 코드를 before/after/after/before 순서로 직렬 실행했다. 각 모드·버전당 표본 2개다. 원격 branch 65개(오래된 tip 64개 + 실제 main), 게시 commit 96개와 새 commit 3개를 사용했다. 아래 시간은 중앙값이며 원본 표본을 모두 유지한다.

| 변경 | 실제 push 이전 → 현재 | 완료 시간 이전 → 현재(ms) | Git 호출 이전 → 현재 | Node CPU 이전 → 현재(ms) |
| --- | ---: | ---: | ---: | ---: |
| shared-small-feature | 35 → 1 | 70,971 → 1,951 | 123 → 20 | 237.5 → 45.5 |
| shared-large-feature | 35 → 3 | 51,876 → 6,525.5 | 123 → 27 | 217.5 → 53.5 |

이 비교는 2KiB 임계값으로 이력 분할 오류를 축소 재현한다. 실제 기본 50MiB 경계의 Native 회귀 테스트도 별도로 통과했지만, 외부 서버의 전체 전송 속도 개선으로 환산하지 않는다. Node CPU는 benchmark 부모 프로세스만 포함한다.

준비 완료 시간은 작은 변경 1,665 → 308ms, 큰 변경 1,831.5 → 2,398.5ms다. 큰 변경의 준비 중앙값은 느려졌으므로 모든 단계가 빨라졌다고 주장하지 않는다.

## 안전성과 Graph 검증

기존 관련 34개 테스트와 최종 분기점 5개, 순차 push·metadata 33개가 통과했다(중복을 제외하면 68개). 실제 50MiB 객체가 이미 게시된 경우에도 신규 변경은 한 번만 전송하고, 2KiB 경계를 넘는 신규 변경은 3번만 전송한다. 원래 64개 제외 tip과 Native base를 모두 유지하며 추가 조회 없이 단일 65행 window를 사용하는지도 실제 인자로 확인한다.

staged·unstaged·untracked 내용, index·source HEAD·기존 원격 branch를 보존한다. 동시 목적지 생성은 빈 initial lease로 차단하고, 광고되지 않은 로컬 base와 모르는 원격 객체를 제외 근거로 쓰지 않는다. branch 2,049개에서도 조회 window와 제외 개수는 각각 65개 이내이며 실제 게시 update는 한 번이었다.

최종 코드의 Git/Graph 18개 시나리오와 실제 버튼·등록 callback 4개를 별도로 통과했다. 공통 upstream branch 80개를 가진 fixture에서 최종 HEAD·부모·refs·local-only 표시를 새 Native 조회와 대조했다. 화면 포커스나 Extension Development Host를 요구하지 않았다. 이 검증의 시간은 비교 성능 주장에 사용하지 않는다.

원격 tip이 분기점보다 앞서 있거나 65개 window 밖에 있는 등 모든 게시 base를 찾는 방식은 아니다. 그런 경우 기존의 보수적인 계산을 유지한다. 전체 Git 작업과 최종 Graph의 일관된 지연·전체 OS 자원 개선은 계속 검증해야 한다. 원본 SHA-256·모든 표본·측정 범위는 옆 JSON에 기록했다.
