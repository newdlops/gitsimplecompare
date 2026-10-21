# 로컬 변경 유무 검사 — 0.1.72141

기준 소스는 `a8081bb88d2683c228bc9faecbcc4a34addb721b`다. pull·브랜치·PR 작업이 변경 유무만 필요로 하는 사전 검사에서 rename 유사도 비교와 전체 stdout 보관을 줄였다. 모든 검사 시점의 새 Native Git 결과, 성공/close 확인과 기존 쓰기 안전 검증은 유지한다.

## 구현과 검증

`hasWorkingTreeChanges`는 `status --no-renames`를 사용하고, stdout을 문자열로 합치는 대신 매 시도의 boolean 하나만 보관한다. 이동을 삭제/추가로 표현해도 변경 유무는 같다. [Git 공식 설명](https://git-scm.com/docs/git-status)에 따라 이 옵션은 사용자 표시 설정과 관계없이 rename 탐지를 끈다. 경로·상태·이동을 표시하는 Changes와 Graph의 상세 결과는 이 함수에서 만들지 않는다.

일부 stdout 뒤 Git이 실패하면 오류를 전파하며, 기존의 안전한 lock/spawn 재시도는 새 reader로 시작한다. 성공/close 전에는 true도 반환하지 않는다. 새 캐시·타이머·Git 호출은 추가하지 않았다. 보관하는 reader 상태가 고정 크기라는 의미이며 전체 Node/Git/OS 메모리가 고정 크기라는 주장은 아니다.

관련 Node **50개**, 타입 검사가 통과했다. 수정된 staged rename, staged/unstaged 혼합, 삭제, ignored-only, 개행·literal 경로, `status.showUntrackedFiles=no`, 대용량 부분 stdout, 실패와 lock 재시도, 실제 자식 close를 검사했다. 기존 pull 충돌·stash 복원·worktree 소유권, PR 적용·Undo·이후 편집/새 작업 보호도 통과했다. 실제 index bytes와 metadata를 보존했다.

## 전후 Native 비교

301개 tracked 파일 중 300개를 조금 수정해 이동·stage한 Native 상태와 깨끗한 상태를 사용했다. GitHub나 사용자 작업트리를 사용하지 않는다. 같은 harness를 이전/수정/수정/이전 순서로 실행했고 각 source·상태당 6개 표본을 기록했다. 표본 하나는 실제 검사를 두 번 실행한다. fixture 생성은 측정 구간 밖이며, 두 조회와 Native index 보존은 모든 실행에서 검증한다.

| 두 번의 검사 중앙값 | 이전 | 수정 |
| --- | ---: | ---: |
| 수정된 파일 이동 300개 | 325.34ms | 167.07ms |
| 깨끗한 작업트리 | 391.54ms | 166.53ms |

각 상태의 Node CPU 중앙값은 3.406→3.110ms, 3.707→2.569ms다. Git/OS CPU는 이 값에 포함되지 않는다. 외부 부하를 통제하지 않았으므로 깨끗한 상태의 큰 시간 차이를 이 변경만의 효과로 단정하지 않는다. 느린 표본과 전체 원본을 JSON 보고서에 보존했다. 실제 PR 버튼·GitHub·최종 Graph 지연의 개선율로 환산하지 않는다.

## 전체 작업과 자원

별도 한 쌍의 실행에서 1,000개 파일·1,000개 commit·100개 branch·공유 upstream 8개와 현재 monitor 정책을 사용했다. push, pull, fetch, rebase, merge, PR squash, PR commit별 적용, cherry-pick, checkout을 전후 각각 검증해 **18개 사례**가 Native 이력·HEAD·refs·부모·local-only와 production HTML/CSP/JS의 최종 DOM을 통과했다. 전용 foreground 창이나 OS 포커스는 사용하지 않았다.

소유 Node/Git/Chromium 전체 CPU는 **18,820.906→19,186.610ms**, RSS 합계 관측 최대는 **642,580,480→689,995,776bytes**였다. fixture 생성·사후 검증을 포함하고 archive/build 및 observer/ps는 제외한다. RSS는 50ms+ps 실행 간격의 관측 합계라 공유 페이지 중복과 짧은 peak 누락이 가능하다. 이 표본은 전반적 CPU·RSS 감소를 증명하지 않는다. 계측된 전체 작업 시간도 일반적인 성능 개선의 근거로 사용하지 않는다.

## 보존한 실험과 남은 작업

실제 규모인 30,311개 파일·72,720개 commit을 읽기 전용 원본 object로 구성한 격리 저장소에서 임시 index 재사용도 실험했다. 미추적 캐시를 켠 경우에는 두 번째 검사가 빨라졌지만, 끈 경우 개선이 작고 Node CPU가 증가했다. 해당 raw prototype에는 production의 경로·index fence 비용도 없으므로 제품 성능 증거로 사용하지 않는다. 이번에는 그 캐시를 제품에 넣지 않았고 실험 원본을 남겼다. 원본 저장소와 실제 index 보존을 확인했다.

전체 Git 작업 지연·Graph 최신화·안정성·자원 절감이라는 원래 목표는 계속 진행 중이다. 반복 상태 탐색과 전체 자원 결과는 추가 분석이 필요하다. 이번 변경은 새 상태 검사를 유지하면서 불필요한 rename 비교와 출력 보관을 줄인 범위다.

기존 lint는 eslint 설치/선언이 없어 실행할 수 없는 상태다. UI 코드는 변경하지 않았으며 새로운 시각 검증을 주장하지 않는다. Marketplace 상태 조회, 강제 reload, OS 포커스 변경, Captain 쓰기와 사용자 stash·복구 데이터 삭제는 하지 않았다. 같은 이름의 JSON에 모든 표본·증거 및 source SHA-256을 기록했다.
