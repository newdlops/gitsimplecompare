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
- `graph/graphLayout.ts` — 커밋 DAG → 레인/간선 배치(순수 함수, vscode 비의존). `graph/graphTypes.ts` 에 도메인 타입.
- `webview/{graphPanel,rebasePanel,splitPanel}.ts` — 각 웹뷰 패널 생애주기 + 메시지 라우팅. 프로토콜은 `webview/*Protocol.ts`, UI 는 `media/{graph,rebase,split}/`.
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
