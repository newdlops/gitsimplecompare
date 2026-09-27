# Git Simple Compare — 프로젝트 지침

VS Code 확장 "Git Simple Compare" 저장소입니다.

## 제품 기능

1. git 브랜치(원격/로컬)끼리 변경점 비교
2. 특정 파일과 브랜치의 차이점 비교
3. 현재 열린 파일을 특정 브랜치와 비교
4. 비교하면서 편집 가능 (작업트리 쪽 파일을 직접 편집)

## 코드 작업 지침 (반드시 준수)

1. **파일 길이**: 한 파일은 300~600라인 범위로 작업한다. 그 이상으로 커지면 책임을 나눠 모듈을 분리한다.
2. **모듈 경계**: 모듈 간 경계가 분명해야 한다. git 접근(`git/`), VS Code UI(`ui/`), 가상 문서/트리 제공(`providers/`), 명령 조립(`commands/`), 순수 유틸(`utils/`)의 역할을 섞지 않는다.
3. **재사용성**: 모듈은 재사용 가능하도록 설계한다. UI/명령 레이어에 비즈니스 로직을 박아 넣지 말고, `GitService`처럼 독립적으로 호출 가능한 단위로 만든다.
4. **주석**: 모듈의 함수마다 설명 주석을 한글로 자세히 남긴다. "무엇을/왜" 하는지, 매개변수와 반환값의 의미를 적는다.
5. **확장성**: 기능 확장이 용이하도록 설계한다. 새 비교 모드/새 git 명령을 추가할 때 기존 모듈을 최소 수정으로 끼워 넣을 수 있어야 한다.

## 아키텍처 개요

- `git/gitExec.ts` — git CLI 를 실제 실행하는 저수준 래퍼(`runGit`, env 주입 지원) + `GitError`. 모든 git 서비스가 공유하는 유일한 실행 지점.
- `git/gitService.ts` — 브랜치/변경목록/파일내용 등 비교용 git 작업.
- `git/gitLogService.ts` — 그래프용 커밋 로그/커밋 상세 조회.
- `git/conflictService.ts` — 충돌 파일 조회/ours·theirs 수용/작업상태(merge·rebase 등) 판별·continue·abort. `detectOperation` 공유 함수 포함.
- `git/rebaseService.ts` — 비대화식 인터랙티브 rebase(todo/메시지를 헬퍼 스크립트로 주입). 헬퍼는 `media/rebase/rebaseEditor.js`(ELECTRON_RUN_AS_NODE 로 구동).
- `git/diffHunkService.ts` — `git diff` 를 파일/hunk 로 파싱하고 선택 hunk 만 `git apply --cached` 로 부분 스테이징해 분할 커밋.
- `git/diffParse.ts` — `--name-status`/`--numstat` 출력 파서(서비스들이 공유).
- `git/largeChangeSet.ts` — 대량 변경 정책(순수): bulk-checkin 임계값, stdin pathspec 전환, 라인 통계 생략 기준. `git/pathspecExec.ts` 가 경로가 많은 add/reset/checkout 을 stdin pathspec 으로 실행한다. `core.bigFileThreshold` 는 `git add` 에만 붙인다(hook 을 실행하는 commit 에 상속되면 diff 가 binary 로 바뀜). 대용량 파일(5MB 초과) 라인 통계는 blob 끼리 비교하는 diff 에만 `blobDiffSizeLimitArgs` 를 쓰고, 작업트리 diff 는 `largeFileExcludePathspecs` 로 먼저 제외한다(작업트리 diff 에 임계값만 걸면 해시 계산이 오히려 느려짐). diff 미리보기는 `ui/largeFilePreview.ts` 의 한도(`diffEditor.maxFileSize`)를 넘으면 `FileTooLargeError` 로 내용을 읽지 않는다(`git/fileContentReader.ts`).
- `graph/graphLayout.ts` — 커밋 DAG → 레인/간선 배치(순수 함수, vscode 비의존). `graph/graphTypes.ts` 에 도메인 타입.
- Graph 대형 저장소 경로: 페이지 계획·status∥log 병렬 읽기는 `webview/graphPageLoading.ts`, 명시 ref 는 `git/revisionInput.ts` 로 stdin 전달(argv 금지), local-only 는 원격 tip 제외 빠른 경로 + ahead 수 검증(`git/gitLocalOnlyBranches.ts`). commit-graph 가 없어 첫 페이지가 느리면 `ui/commitGraphOffer.ts` 가 사용자 동의 후에만 생성한다(`git/commitGraphStatus.ts`). 숨김/포커스 해제는 로드된 그래프·PR 조회를 보존한다(`graphInvalidationPlan`). 웹뷰 행 부분 갱신·폭 측정은 `media/graph/graphRowSync.js`.
- GitHub 읽기: 백그라운드는 `readGitHub`, 사용자 조작(상세·변경 파일·에디터 댓글)은 `readGitHubInteractive`(별도 슬롯·시간 상한). `gh repo view` 는 `git/githubRepositoryName.ts` 로 원격 설정 기준 캐시, PR 변경 확인은 `git/pullRequestRefLookup.ts` 단일 조회.
- `webview/{graphPanel,rebasePanel,splitPanel}.ts` — 각 웹뷰 패널 생애주기 + 메시지 라우팅. 프로토콜은 `webview/*Protocol.ts`, UI 는 `media/{graph,rebase,split}/`.
- `media/changes/changesWorkingList.js` — Staged/Changes 목록을 평면 행 모델 + 가상 스크롤(고정 22px 행)로 렌더. 화면 밖 행이 DOM 에 없으므로 선택 범위·폴더 하위 경로는 DOM 이 아니라 이 모델(`orderedKeys`/`pathsForKey`/`hasKey`)로 계산한다.
- `providers/conflictsController.ts` + `conflictsTreeProvider.ts` — 충돌 뷰 상태 조정 + 트리 표시.
- `providers/branchContentProvider.ts` — 커스텀 URI 스킴(`gitsimplecompare:`)으로 특정 ref의 파일 내용을 읽기 전용 가상 문서로 제공한다.
- `providers/changesTreeProvider.ts` + `changesTreeModel.ts` — 변경 파일 목록을 트리/리스트로 보여준다(모델은 순수 변환).
- `ui/diffPresenter.ts` — `vscode.diff`를 호출해 비교 에디터를 연다. 한쪽이 작업트리 파일이면 편집 가능, 양쪽이 ref이면 읽기 전용.
- `commands/` — 위 모듈을 조립해 사용자 명령을 구현한다. 로직은 최대한 하위 모듈로 위임한다.

### i18n
- UI 기본 영어. package.json 기여 문자열은 `%키%` + `package.nls.json`/`package.nls.ko.json`. 런타임 문자열은 `vscode.l10n.t(...)` + `l10n/bundle.l10n.ko.json`.
- 코드 주석은 한글 유지(지침 4).

## 빌드 / 실행

- `npm run compile` — esbuild 번들 (dist/extension.js)
- `npm run watch` — 변경 감지 빌드
- `npm run check-types` — tsc 타입 검사
- F5 (VS Code) — Extension Development Host로 실행/디버그
