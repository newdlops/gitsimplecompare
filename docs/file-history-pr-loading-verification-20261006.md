# 파일 이력·PR 목록 조회 개선 검증 — 2026-10-06

대상 버전: Git Simple Compare 0.1.72083.
이번 검증은 파일 이력의 반복 탐색과 PR 목록의 첫 표시 대기를 다룬다.

## 원인과 변경

### 파일 이력

기존 수동 Changes 새로고침은 모든 파일 이력을 무효화해, 같은 HEAD에서도
`git log --follow --raw --numstat -z -M`을 다시 실행했다.
파일 선택이 바뀌어도 이전 조회의 실제 Git 실행은 취소되지 않았다.

- `FileHistoryReadCache`가 파일별 조회 공유, 소비자 취소와 최대 두 개의 로더를 소유한다.
- 매번 Git이 해석한 HEAD·Git/common 디렉터리·설정/include·replace refs를 확인한다.
  shallow/grafts/attributes·환경·Git 실행 경로 변화도 이력 해석 키에 포함한다.
- 같은 해석 키에서는 커밋·rename·추가/삭제 통계를 재사용하고,
  `git log --no-walk=unsorted`로 상대 시각을 새로 계산한다.
- 조회를 불변 HEAD에 고정하고 완료 전 문맥을 다시 확인한다.
  도중 변경이 발견되면 최신 문맥에서 한 번 재조회한다.
- 일반 새로고침과 index 메타데이터 갱신은 이력을 일괄 삭제하지 않는다.
  명시적인 `force` 요청은 전체 이력을 다시 조회한다.
- 파일 선택·창 포커스·Host 수명에 소비자의 취소 신호를 연결한다.
  이전 성공·오류는 새 파일의 화면에 반영되지 않는다.
- 메모리는 40개 / 4 MiB / 30분, 디스크는 40개 / 8 MiB / 7일로 제한한다.
  디스크 저장은 원자적 게시와 schema·내용 hash 검증을 사용하고,
  손상·권한·저장 공간 오류에서는 실제 Git 조회로 복구한다.
  다른 사용자·symlink·최근 게시 임시 파일은 삭제하지 않는다.

### PR 목록

기존 첫 화면은 80개 PR의 ID를 받은 뒤, 네 개의 전체 metadata 묶음이 모두
완료될 때까지 기다렸다. 무거운 root connection에 파일·댓글 집계나 commit
관련 OID를 함께 넣는 방식도 실제 측정에서 첫 응답을 지연시켰다.

- 첫 root 조회는 ID·번호·제목·상태·URL·브랜치·작성자·draft·갱신 시각을 읽는다.
  검증한 80개 요약을 첫 왕복 직후 게시한다.
- 전체 metadata는 기존처럼 20개씩 읽고, 완료된 묶음부터 commit/review
  후속 페이지를 시작한다. 동시에 실행하는 조회는 네 개로 제한한다.
- 최종 반환은 모든 commit OID와 정확한 댓글·파일 수가 완성될 때까지 기다린다.
  기존 80개 페이지 크기·정렬·cursor를 유지한다.
- 모르는 파일 수는 `…`로 표시한다. 기존 완료 플래그를 사용하는 Git 액션은
  필요한 데이터가 준비될 때까지 비활성 상태를 유지한다.
- 진행 갱신은 기존 행과 검색 입력을 유지한다. 누락·중복 ID, 번호 불일치,
  부분 응답·pagination 실패는 완성된 성공으로 반환하지 않는다.

## 실제 데이터 비교

정상 실행 중인 Mac의 기존 linked worktree에서 측정했다.
Mac·SentinelOne 재시작, 사용자 Git 경로 변경, Git wrapper 계측은 사용하지 않았다.

### 27개 커밋을 가진 파일

| 조회 | 시간 | 결과 출처 |
| --- | ---: | --- |
| 기존 전체 `--follow` 탐색 | 4,506 ms | Git |
| 같은 HEAD 새로고침 1 | 97 ms | 메모리 |
| 같은 HEAD 새로고침 2 | 108 ms | 메모리 |
| 같은 HEAD 새로고침 3 | 188 ms | 메모리 |
| 새 조회 서비스의 저장 이력 복원 | 343 ms | 디스크 |

모든 조회에서 27개 커밋의 불변 필드·rename·통계 내용 hash가 같았다.
조회 전후 HEAD도 같았다. 새 코드의 첫 전체 조회는 1,584 ms였으나
기존 조회 뒤 실행해 OS/Git이 이미 준비된 상태이므로 그 차이를 코드 개선으로
해석하지 않는다. 처음 보는 파일과 변경된 HEAD에는 전체 탐색이 필요하다.

### 실제 GitHub의 80개 PR

기존 서비스와 수정 서비스를 별도 번들로 같은 저장소에 순서대로 실행했다.

| 항목 | 기존 | 개선 |
| --- | ---: | ---: |
| 80개 PR 첫 표시 | 4,841 ms | 1,934 ms |
| 모든 데이터 완료 | 5,990 ms | 5,492 ms |

최종 80개 PR의 commit OID·댓글·파일 수를 포함한 내용 hash와 pageInfo가 같았다.
모든 commit/comment 완료 플래그가 true였다. 첫 표시 시 아직 모르는 합계는
완료로 표시하지 않는다. 각 구현 한 번의 실제 네트워크 비교이므로 고정 시간이나
동일 비율의 개선을 보장하는 측정은 아니다.

## 자동 검사와 화면 검사

- 변경 관련 Node 테스트 79개 통과: 실제 Git SHA-1/SHA-256·rename·통계·linked
  worktree·index 보존, context 변화, 캐시 복원/손상/상한/게시,
  소비자 공유/취소/close/큐, 오래된 명령 결과 차단과 PR pagination/진행/실패.
- TypeScript 타입 검사 통과.
- Chromium 브라우저 테스트 9개 통과: 로딩·오류·재시도·닫았다 열기,
  비활성 액션, IME/검색 포커스, 부분·전체 metadata 갱신과 행 유지.
- 390×844, 768×1024, 1440×900에서 80개 PR의 요약/완료 화면 PNG를 직접 확인했다.
  긴 제목·브랜치와 합계 배치, 비활성→활성 액션, 검색 입력 표시와 외부 overflow를
  확인했다. VS Code 패널의 기존 시각 언어를 유지했다.
- `git diff --check` 통과. 변경한 소스 모듈은 각각 600줄 이하이다.

## 설치한 VS Code에서 확인

설치한 0.1.72083의 기존 payroll 프로젝트 창에서 다음 OUTPUT과 실제 화면을 확인했다.

- 첫 전체 조회: 27개 커밋, `source:git`, 3,982 ms.
- 같은 파일의 수동 Changes 새로고침: `source:memory`, 170 ms와 82 ms.
- 같은 창을 `Developer: Reload Window`로 다시 로드한 뒤:
  `source:disk`, 27개 커밋, 479 ms. 실행 중인 Host의 실제 저장 캐시 복원이다.
- 창 포커스를 잃은 조회와 그래프 선택으로 소비자를 잃은 파일 이력은 취소/스킵 로그를 남겼다.
- 실제 그래프에서는 PR 요약 80개가 2,901 ms에 준비됐고 전체 데이터는 8,646 ms에
  완료됐다. 원격 응답 시간이 달라져 별도 비교 실측보다 전체 완료가 늦었지만,
  요약은 전체 metadata와 pagination을 기다리지 않고 표시됐다.
- 실제 PR drawer의 `80 loaded pull requests`, 제목·상태·브랜치·파일/commit/댓글 수와
  활성 액션을 직접 화면에서 확인했다. Changes 87개, Stashes 43개, Worktrees 9개도 유지됐다.

실제 OUTPUT은 `runtime-before-second-reload.log`, `runtime-before-verified-reload.log`,
`runtime-current.log`에 보관했다. 변경된 실행 환경에서는 문맥 검증에 의해 전체 이력을
다시 읽을 수 있으며, 환경이 같은 창 재로드에서의 디스크 복원을 위와 같이 확인했다.

## 빌드 산출물

- VSIX: `/private/tmp/gitsimplecompare-0.1.72083.vsix`
- VSIX SHA-256:
  `0b55b034b5bdeb56b469af2671d9d007caecce065de95e2195cba61207ddb766`
- 실행 번들 SHA-256:
  `cafd23e4273724b0fa155dbafbc8a8d2f4dd72a609fe8da612063d16deec1c89`
- VSIX manifest 버전, 생성 번들과 설치 번들의 일치를 확인했다.
  source/test/docs/개인 계측 파일은 VSIX에 포함되지 않았다.

## 실측 파일

원본 실측·로그·브라우저 PNG는 `/private/tmp/gsc-history-pr-20261006/`에 보관했다.

- `history-benchmark.json`
- `pr-original-benchmark.json`, `pr-optimized-benchmark.json`
- `affected-tests.log`, `check-types.log`, `webview-tests.log`
- `pr-summary-{390,768,1440}.png`, `pr-complete-{390,768,1440}.png`
- `package-verification.json`, `runtime-current.log`

며칠간의 장기 사용이나 심한 swap 압력까지 이 검증으로 확인한 것은 아니다.
새 파일/HEAD의 전체 이력 탐색과 GitHub 네트워크 대기는 계속 관찰할 대상이다.
