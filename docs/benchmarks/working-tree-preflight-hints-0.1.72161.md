# 작업 전 변경 경로 우선 검사 — 0.1.72161

기준은 0.1.72160, `e78fe5ee0960f6aa189c2793d3e9a9b1ee04eeac`다.
최근 Graph/Changes가 읽은 변경 경로를 다음 작업의 Native 검사 우선순위로
사용한다. 범위 검사에서 실제 변경을 확인하고 Git이 성공·close한 경우에만
dirty로 완료한다. 후보가 사라졌거나 ignored가 됐으면 후보를 버리고 기존의
전체 상태 검사를 실행한다. 캐시로 clean을 판정하지 않는다.

후보는 작업트리 32개, 각 8개 경로, 경로당 UTF-8 1KiB로 제한한다.
옵션·glob처럼 보이는 이름도 literal pathspec으로 전달한다. 작은 경로가 큰
porcelain 원문의 backing string을 붙잡지 않도록 독립 UTF-8 사본을 저장한다.
전체 Changes 결과, Native 오류·취소 처리와 기존 fsmonitor 정책은 유지한다.
별도 timer·파일 감시·Git warmup은 추가하지 않는다.

## 비교 조건

- 같은 코드와 harness를 고정하고 각 모드에서 before/after/after/before 순서로
  실행했다. source·모드·작업당 독립 프로세스 표본은 2개다.
- 시간, Node·종료된 Native 자식·Chromium CPU, 합산 RSS 표본은 별도 실행이다.
  메모리 관찰 실행의 시간·CPU는 성능 비교에서 제외한다.
- 기반 스냅샷은 30,311파일·72,720커밋·164로컬 브랜치이며, 80개 PR 카드를
  실제로 렌더한다. 원본 Captain 객체는 읽기만 하고 작업과 전송은 임시
  작업트리·소유 bare receiver에서 수행한다. 실 GitHub 전송 시간은 아니다.
- 기존 변경 파일 한 개를 남긴 상태에서 production HTML/CSP/JS의 버튼,
  등록된 확장 callback, Native Git, 최종 Graph frame을 연결했다.
- 시간·CPU 비교 32건과 별도 메모리 비교 16건 모두 Native 결과, HEAD/ref/
  local-only 표시와 변경 파일 내용·상태가 일치했다. 메모리 원문 16개도
  complete와 SHA-256을 확인했다. 외부 머신 부하는 통제하지 않았다.
- 버전만 0.1.72161로 올린 뒤 최종 검사를 수행했다. 측정한 runtime 소스는
  최종 검사까지 같은 바이트이며, 고정 hash와 원시 표본은 JSON에 남긴다.

## 적용되는 두 버튼의 결과

아래 값은 두 표본의 중앙값이다. CPU는 여러 소유 프로세스의 누적 CPU
시간이며 wall time과 다르다. 최종 frame은 마지막 host 메시지까지 포함한다.

| 작업 | 첫 Native 상태 검사 ms | 클릭→최종 frame ms | 소유 CPU ms |
| --- | ---: | ---: | ---: |
| Pull | 383.5 → 15.0 | 1,122.0 → 746.5 | 2,160.9 → 1,718.6 |
| PR 커밋 유지 체리픽 | 396.0 → 11.5 | 10,600.0 → 10,138.0 | 11,310.6 → 10,899.6 |

두 적용 작업의 frame 합계 중앙값은 11,722.0→10,884.5ms(-7.1%),
CPU 합계는 13,471.5→12,618.2ms(-6.3%)다. known-path에서 Git 호출 수는
Pull 14→14, PR replay 38→38로 동일하다. 변경이 확인된 경로의 전체 디렉터리
탐색 비용을 줄이는 결과이며 전체 Git/GitHub 작업 속도의 개선률은 아니다.

Interactive rebase와 PR squash 버튼은 이 helper를 사용하지 않는 대조군이다.
네 작업 전체 frame 합계의 큰 감소(-34.2%)는 첫 baseline rebase의 14,116ms
표본 영향을 받는다. 해당 표본의 29호출과 다른 rebase 표본의 27호출을
그대로 보존하며, 대조군의 시간 변동을 이 후보의 효과로 귀속하지 않는다.
PR replay에는 여전히 약 4.75초·3.22초의 두 worktree 명령 표본이 남는다.
이 두 명령의 add/remove 단계별 원인은 후속 조사 대상이다.

## 메모리 결과와 한계

아래는 같은 시점의 Node·Chromium·소유 Native RSS를 합산한 최대 **표본**의
중앙값이다. 관찰 프로세스는 제외하며, 정확한 peak나 retained heap은 아니다.

| 작업 | 기준 MiB | 후보 MiB |
| --- | ---: | ---: |
| Pull | 750.0 | 747.6 |
| Interactive rebase 대조군 | 778.1 | 777.5 |
| PR squash 대조군 | 722.4 | 745.0 |
| PR 커밋 유지 체리픽 | 1,073.1 | 1,084.9 |

각 실행에서 가장 큰 RSS 표본의 중앙값은 1,073.1→1,084.9MiB(+1.1%)다.
전체 메모리 감소는 입증되지 않았다. CPU·시간의 제한된 이익과 구분한다.

독립 GC 회귀 검사에서는 64MiB 문자열에서 잘라낸 25바이트 경로를 저장했다.
초기 미배포 후보는 약 67,105,184바이트를 붙잡아 실패했고, 독립 경로 사본으로
고친 뒤 통과했다. 최종 검사 로그의 retained delta는 -3,608바이트로 작은
GC 변동 범위다. 이는 backing string 유지 문제의 재현·수정 근거이며 실제
확장 프로세스 peak나 전체 retained heap 감소의 측정으로 사용하지 않는다.

초기 후보 A의 8개 예정 job 중 6개만 끝난 기록은 최종 비교에서 제외했다.
문자열 소유 수정 뒤 현재 기준 소스로 완료한 B(시간·CPU 8 job), C(메모리
4 job)의 표본만 위 수치에 사용한다. 초기 pilot의 대조군 marker 기대 오류와
시험 기동 실패도 성공 표본에 포함하지 않는다.

## 최종 검증

- 관련 Node 검사 162건: 변경 후보의 miss·ignore·동일 개수 파일 교체와 mtime
  복원·Unicode/literal 경로·부분 출력 뒤 Native 실패·개수 제한·독립 사본,
  Graph summary/full 결과, branch/pull/PR 보존·undo·복구·공유 읽기·index 안전성.
- 전체 18개 변형을 소형·대형 저장소에서 각각 실행한 Native/production DOM
  검사 36건. push·pull·fetch·rebase·merge·PR squash/replay·cherry-pick·checkout과
  각 이력/로드 변형을 포함한다. 이 검사의 시간은 새 비교 수치로 사용하지 않는다.
- 대형 실제 Pull/PR replay 버튼 2건은 이전 후보 파일을 없애고 다른 위치에
  변경을 만든다. 각각 miss/full-scan marker 1건, positive marker 0건이며,
  전체 검사 뒤 원래 변경 파일의 내용·상태와 최신 Graph 표시가 일치한다.
- TypeScript와 diff 검사를 통과했다. 사용자 창의 포커스 전환이나 강제 reload,
  별도 Marketplace 점검은 수행하지 않는다.

비교 상세는 [JSON](working-tree-preflight-hints-0.1.72161.json)에 있다.
원시 결과는 `/private/tmp/gsc-goal60b-buttons-state.json`,
`/private/tmp/gsc-goal60c-buttons-state.json`,
`/private/tmp/gsc-goal61-final-matrix-state.json`,
`/private/tmp/gsc-goal61-stale-large.json`,
`/private/tmp/gsc-goal61-final-tests-corrected.log`에 남긴다.
원래 전체 작업 속도·Graph 최신성·안정성·자원 목표는 유지하며, 모든 작업의
속도·메모리 개선 완료를 주장하지 않는다.

## 산출물

`gitsimplecompare-0.1.72161.vsix`는 1,020,387바이트이며 SHA-256은
`f1d398fd313d2f49a5f7b13460c91cb6438dcc1ade849aa838502ccf0ccc8bcc`다.
126개 runtime 파일을 작업 소스와 대조했고 이전 배포 대비 변경된 runtime은
`dist/extension.js`뿐이다. 기존 웹뷰 리소스와 rebase helper는 같은 바이트다.
bundle의 두 경로 검사 로그, UTF-8 사본 생성과 기존 PR 이동 복구를 확인했다.
검증 결과는 `/private/tmp/gsc-release-72161-artifact.json`에 남긴다.
