# Git Simple Compare

git 브랜치와 파일을 간단하게 비교하고, **비교하면서 바로 편집**할 수 있는 VS Code 확장입니다.

> The English document is available at [README.md](./README.md).

Marketplace ID: `newdlops.git-simple-compare`

## 설치

- VS Code Marketplace: [Git Simple Compare](https://marketplace.visualstudio.com/items?itemName=newdlops.git-simple-compare)
- 명령줄: `code --install-extension newdlops.git-simple-compare`
- 수동 VSIX: `.vsix` 파일을 다운로드하거나 빌드한 뒤 `code --install-extension git-simple-compare-0.1.0.vsix`

## 기능

1. **브랜치 비교** — 현재 체크아웃과 비교할 브랜치 하나만 골라 에디터 라인 표시로 확인합니다. 명시적인 FROM/TO 비교는 고급 명령으로 유지됩니다.
2. **파일과 브랜치 비교** — 탐색기에서 파일을 우클릭해 특정 브랜치 버전과 비교합니다.
3. **현재 파일과 브랜치 비교** — 열려 있는 파일을 에디터 제목 표시줄이나 컨텍스트 메뉴에서 브랜치 버전과 비교합니다.
4. **비교하면서 편집** — 파일↔브랜치 비교에서는 작업트리 쪽이 편집 가능합니다. 또한 **좌측(브랜치) 내용을 우측(작업파일)에 한 번에 반영**할 수 있습니다.
5. **Git 그래프** — 모든 브랜치를 아우르는 커밋 그래프를 시각화합니다. 커밋을 클릭하면 상세(작성자·메시지·변경 파일)를 보여주고, 파일을 클릭하면 그 커밋의 diff 를 엽니다.
6. **충돌 해결** — merge/rebase/cherry-pick/revert 중 충돌 파일을 충돌 뷰에 나열하고, 머지 에디터 열기·ours/theirs 수용·해결 표시·계속/중단을 한 번에 처리합니다.
7. **인터랙티브 rebase** — 드래그 앤 드롭 웹뷰에서 rebase 계획을 편집합니다(순서 변경 + pick/reword/squash/fixup/drop). 그래프의 "이 커밋부터 rebase" 또는 명령 팔레트로 실행합니다.
8. **변경을 여러 커밋으로 분할** — diff hunk 를 개별 선택해 따로 커밋하고, 나머지는 반복합니다(`git add -p` GUI).
9. **AI 메시지 생성** — 로컬 Claude Code 또는 Codex CLI 에 프롬프트를 보내 커밋 메시지와 staged PR 제목/본문을 생성합니다.
10. **파일 기반 커밋 hook 관리** — 전통적인 로컬 hook 파일을 조회·생성·열기·활성화·비활성화하고, lint/파일 검사 실패를 클릭 가능한 파일·행 진단과 재시도 UI로 보여줍니다.
11. **블록 작업자 Code Vision** — 함수, 클래스, 인터페이스, 메서드와 빈 줄로 구분된 전역 선언 묶음 위에 주요 Git 작업자를 표시합니다. 힌트를 클릭하면 거터 옆에 고정폭 작업자·날짜 열이 열립니다.
12. **PR Stack 수명주기 관리** — Git Graph에 PR 흐름을 직접 표시하고, 레이어/worktree 생성, 후손 연쇄 restack, 의존성 순서 Submit/Sync, merge 후 Advance를 자동화합니다.

## 사용 방법

- 명령 팔레트(`Cmd/Ctrl+Shift+P`) → `Git Simple Compare: 현재 체크아웃과 비교...`
- 임의 ref 비교 → `Git Simple Compare: 임의의 두 브랜치 비교(고급)...`
- 탐색기에서 파일 우클릭 → `이 파일을 브랜치와 비교`
- 에디터 우클릭(또는 탭 우클릭) → `현재 파일을 브랜치와 비교`
- 에디터 제목 표시줄의 비교 아이콘
- 액티비티 바의 **Git Simple Compare** 아이콘에서 변경 파일 목록 확인
- 명령 팔레트 → `Git Simple Compare: git 그래프 보기` (또는 변경 파일 뷰 툴바의 그래프 아이콘)

### 블록 작업자 Code Vision

저장되고 Git에서 추적 중인 파일에서는 현재 언어 확장의 문서 심볼을 사용해 지원되는 각 소스 블록 선언 위에 전용 CodeLens 행을 표시합니다. 최상위 변수·상수·object 선언과 독립 `type` 선언은 빈 줄이 나오기 전까지 하나로 묶으며, 각 묶음의 첫 선언 라인 위에 CodeLens 하나만 표시합니다. IntelliJ Code Vision처럼 주요 작성자, 추가 작업자 수, 마지막 변경 날짜, 추가 커밋 수가 한 줄에 표시됩니다. 아주 작은 중첩 메서드는 부모 블록에 포함해 화면 밀도를 낮춥니다. Code Vision을 hover하면 담당 라인 분포를 볼 수 있고, 어느 Code Vision이든 클릭하면 파일 전체의 거터 옆 고정폭 열에 모든 라인의 작업자 이름과 날짜가 표시됩니다. 항목을 hover하면 전체 이름·이메일·커밋·요약을 확인할 수 있으며, 같은 파일의 Code Vision을 다시 클릭하면 열이 사라집니다. 변경 파일 뷰 툴바 또는 `Git Simple Compare: 블록 작업자 Code Vision 토글` 명령으로 켜고 끌 수 있으며, VS Code의 `editor.codeLens` 설정도 함께 적용됩니다.

### Git 그래프

브랜치별 커밋 히스토리 그래프를 웹뷰로 엽니다. 커밋 노드를 클릭하면 오른쪽에 상세가 표시되고, 변경 파일을 클릭하면 그 커밋의 diff 가 열립니다. 그래프는 스크롤에 맞춰 최초 커밋에 도달할 때까지 lazy load 됩니다. PR Stack 레이어는 head commit의 chip과 부모 commit으로 향하는 점선 화살표로 함께 표시됩니다.

### 변경 파일 뷰

- 뷰 툴바에서 **트리/목록** 보기를 전환합니다.
- 뷰 툴바에서 정렬 기준(**이름 / 경로 / 상태**)을 바꿉니다.
- 파일을 클릭하면 diff 가 열립니다.

### PR Stack

Git Graph 툴바의 레이어 아이콘을 누르면 로컬 브랜치 관계와 GitHub PR base/head 관계를 합친 Stack을 볼 수 있습니다. **Add Layer**는 부모 tip에서 자식 브랜치와 선택적 linked worktree를 만들고, **Restack**은 부모가 바뀐 레이어와 모든 후손을 안전 ref 아래 연쇄 rebase합니다. **Submit / Sync**는 부모부터 push하여 PR을 생성하거나 base·본문의 Stack 목록을 갱신하며, 재작성된 원격에만 명시적 force-with-lease를 사용합니다. 아래 PR이 merge되면 **Advance**가 자식을 이전 base로 승격하고 restack·PR 동기화·안전한 로컬 정리 제안을 이어서 수행합니다.

생성부터 충돌 Continue/Abort, merge 후 정리와 안전장치까지의 자세한 설명은 [PR Stack 사용 가이드](./docs/pull-request-stacks.ko.md)를 참고하세요.

### AI 커밋/PR 메시지

변경 파일 뷰의 커밋 메시지 입력창 옆 AI 버튼으로 커밋 메시지를 생성할 수 있습니다. 선택한 AI CLI 에 staged diff 를 보내므로, 요약할 파일이나 hunk 를 먼저 스테이징해야 합니다. staged PR preview 에도 PR 제목/본문을 채우는 AI 버튼이 있습니다. AI Plan의 각 커밋 메시지도 단독 AI 커밋 메시지와 같은 subject/body 규칙 및 커밋 프롬프트 지시문을 사용합니다.

이 기능은 로컬 CLI 를 비대화식으로 실행합니다. Claude Code 는 `claude -p`, Codex 는 `codex exec` 경로를 사용합니다. `Git Simple Compare: AI CLI 설정` 명령이나 커밋 AI 버튼 옆 gear 버튼에서 provider, 로그인/상태 흐름, 실행 파일 경로, 모델/profile 옵션, 추론 강도, 기본 응답 언어, 추가 프롬프트 지시문, timeout 을 설정할 수 있습니다. 모델과 추론 강도 선택기는 설치된 provider CLI metadata 를 불러옵니다. **커밋 플랜 설정** 그룹에서는 AI Plan에만 사용할 모델과 추론 강도를 provider별로 따로 고를 수 있습니다. 비워 두면 해당 provider의 일반 설정을 상속하고, 일반 설정도 비어 있으면 CLI 기본값을 사용합니다. Profile 설정은 계속 적용되며, CLI metadata에서 선택 모델과 최종 추론 강도가 호환되지 않는다고 확인되면 picker가 경고합니다.

브라우저 callback 로그인이 localhost 에 도달하지 못하면 AI CLI 설정에서 callback 을 쓰지 않는 로그인 방식으로 바꾸세요. Claude Code 는 `setup-token`, `console`, 또는 `sso`, Codex 는 `device`, `api-key`, 또는 `access-token` 을 선택한 뒤 로그인 / 상태를 다시 실행하면 됩니다.

커밋 메시지 AI 버튼은 staged 변경이 있을 때만 활성화됩니다. PR preview 에서는 복사 버튼으로 생성된/현재 PR 제목과 본문을 GitHub 에 붙여넣기 좋은 형식으로 클립보드에 복사할 수 있습니다.

### 커밋 hook과 검사 실패

커밋 버튼 옆 방패 버튼을 누르면 현재 저장소의 전통적인 파일 기반 커밋 hook을 관리할 수 있습니다. `core.hooksPath`, linked worktree, Husky의 `.husky/_` 구조를 반영합니다. Git 2.55+의 `hook.*` 설정형 hook은 목록에 표시하거나 변경하지 않습니다. 안전한 토글은 Unix 일반 hook 파일의 실행 비트만 바꿉니다. 추적/미추적 작업트리 hook, Husky proxy, 심볼릭 링크, Windows hook, 기존 `.disabled` 파일은 열어 편집할 수 있지만 이름을 옮기거나 토글하지 않습니다.

커밋 hook이 커밋을 거부하면 ESLint, TypeScript, Ruff, Prettier, pre-commit, Husky와 일반 파일 검사 출력을 커밋 입력창 아래에 표시합니다. 보고된 파일을 클릭해 해당 행을 열고 수정·스테이징한 뒤 **커밋 다시 시도**를 누를 수 있습니다. **전체 출력 보기**는 생략하지 않은 프로세스 출력을 `Git Simple Compare` OUTPUT 채널에서 엽니다.

### 좌→우 반영

파일↔브랜치 diff 가 활성화되면 에디터 제목 표시줄에 **좌측 내용을 우측에 반영**(→) 버튼이 나타납니다. 작업 파일 전체를 브랜치 버전으로 교체하며, 에디터 편집으로 적용되므로 저장 전에 검토·실행취소·수정할 수 있습니다.

## 언어

UI 기본 언어는 **영어**입니다. VS Code 표시 언어를 한국어(`ko`)로 설정하면 모든 명령·메시지가 자동으로 한국어로 전환됩니다. 명령 팔레트의 *"표시 언어 구성"* 에서 바꿀 수 있습니다.

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `gitSimpleCompare.diffBase` | `twoDot` | 브랜치 비교 기준 (`twoDot`=직접 비교, `threeDot`=공통 조상 기준) |
| `gitSimpleCompare.includeRemoteBranches` | `true` | 브랜치 선택 목록에 원격 브랜치 포함 여부 |
| `gitSimpleCompare.blameBlock.show` | `true` | 소스 블록 선언 위에 클릭 가능한 작업자 Code Vision 표시 |
| `gitSimpleCompare.aiCliProvider` | `auto` | AI CLI provider (`auto`, `claude`, `codex`) |
| `gitSimpleCompare.aiClaudeCommand` | `claude` | Claude Code 실행 파일 이름 또는 절대 경로 |
| `gitSimpleCompare.aiClaudeModel` | 빈 값 | CLI metadata 에서 선택한 Claude Code 모델 |
| `gitSimpleCompare.aiClaudeCommitPlanModel` | 빈 값 | AI Plan 전용 Claude Code 모델. 비우면 `aiClaudeModel`, 다시 CLI 기본값 상속 |
| `gitSimpleCompare.aiClaudeCommitPlanEffort` | `low` | AI Plan 전용 Claude Code 추론 강도. 비우면 `aiClaudeEffort`, 다시 CLI 기본값 상속 |
| `gitSimpleCompare.aiClaudeEffort` | 빈 값 | Claude Code 추론 강도 (`low`, `medium`, `high`, `xhigh`, `max`) |
| `gitSimpleCompare.aiClaudeSystemPrompt` | 빈 값 | `--append-system-prompt` 로 추가할 Claude Code 시스템 프롬프트 |
| `gitSimpleCompare.aiClaudeLoginMode` | `claudeai` | Claude 로그인 방식 (`claudeai`, `console`, `sso`, `setup-token`) |
| `gitSimpleCompare.aiCodexCommand` | `codex` | Codex 실행 파일 이름 또는 절대 경로 |
| `gitSimpleCompare.aiCodexModel` | 빈 값 | CLI model catalog 에서 선택한 Codex 모델 |
| `gitSimpleCompare.aiCodexCommitPlanModel` | 빈 값 | AI Plan 전용 Codex 모델. 비우면 `aiCodexModel`, 다시 CLI 기본값 상속 |
| `gitSimpleCompare.aiCodexCommitPlanReasoningEffort` | `low` | AI Plan 전용 Codex 추론 강도. 비우면 `aiCodexReasoningEffort`, 다시 CLI 기본값 상속 |
| `gitSimpleCompare.aiCodexReasoningEffort` | 빈 값 | Codex 추론 강도 (`low`, `medium`, `high`, `xhigh`, 지원 시 `max`) |
| `gitSimpleCompare.aiCodexProfile` | 빈 값 | `--profile` 로 전달할 Codex config profile |
| `gitSimpleCompare.aiCodexLoginMode` | `device` | Codex 로그인 방식 (`device`, `browser`, `api-key`, `access-token`) |
| `gitSimpleCompare.aiResponseLanguage` | `English` | AI 메시지 생성 언어 |
| `gitSimpleCompare.aiCommonInstructions` | 빈 값 | 커밋/PR 생성에 공통 적용할 추가 프롬프트 지시문 |
| `gitSimpleCompare.aiCommitInstructions` | 빈 값 | 단독 및 플랜 커밋 메시지에 적용할 추가 프롬프트 지시문 |
| `gitSimpleCompare.aiPullRequestInstructions` | 빈 값 | PR 생성에만 적용할 추가 프롬프트 지시문 |
| `gitSimpleCompare.aiCliTimeoutMs` | `120000` | AI CLI 요청 timeout |

## 개발

```bash
npm install
npm run compile     # 번들
npm run watch       # 변경 감지 빌드
npm run check-types # 타입 검사
npm test            # hook 파서 및 임시 저장소 통합 테스트
```

VS Code 에서 `F5` 를 누르면 Extension Development Host 가 실행됩니다.

### 코딩 에이전트

Codex 는 저장소 루트의 [`AGENTS.md`](./AGENTS.md) 를 읽습니다. Claude Code 는 [`CLAUDE.md`](./CLAUDE.md) 를 읽으므로, 이 저장소는 `CLAUDE.md` 에서 `AGENTS.md` 를 import 하게 해 두 도구가 같은 프로젝트 규칙을 따르게 했습니다. 개인 Claude Code 메모는 git 에 들어가지 않는 `CLAUDE.local.md` 에 둡니다.

## 배포

Marketplace publisher 는 `newdlops` 입니다. 배포 체크리스트는 [docs/publishing.md](./docs/publishing.md) 에 정리했습니다.

## 라이선스

MIT
