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

## 사용 방법

- 명령 팔레트(`Cmd/Ctrl+Shift+P`) → `Git Simple Compare: 현재 체크아웃과 비교...`
- 임의 ref 비교 → `Git Simple Compare: 임의의 두 브랜치 비교(고급)...`
- 탐색기에서 파일 우클릭 → `이 파일을 브랜치와 비교`
- 에디터 우클릭(또는 탭 우클릭) → `현재 파일을 브랜치와 비교`
- 에디터 제목 표시줄의 비교 아이콘
- 액티비티 바의 **Git Simple Compare** 아이콘에서 변경 파일 목록 확인
- 명령 팔레트 → `Git Simple Compare: git 그래프 보기` (또는 변경 파일 뷰 툴바의 그래프 아이콘)

### Git 그래프

브랜치별 커밋 히스토리 그래프를 웹뷰로 엽니다. 커밋 노드를 클릭하면 오른쪽에 상세가 표시되고, 변경 파일을 클릭하면 그 커밋의 diff 가 열립니다. 그래프는 스크롤에 맞춰 최초 커밋에 도달할 때까지 lazy load 됩니다.

### 변경 파일 뷰

- 뷰 툴바에서 **트리/목록** 보기를 전환합니다.
- 뷰 툴바에서 정렬 기준(**이름 / 경로 / 상태**)을 바꿉니다.
- 파일을 클릭하면 diff 가 열립니다.

### AI 커밋/PR 메시지

변경 파일 뷰의 커밋 메시지 입력창 옆 AI 버튼으로 커밋 메시지를 생성할 수 있습니다. 선택한 AI CLI 에 staged diff 를 보내므로, 요약할 파일이나 hunk 를 먼저 스테이징해야 합니다. staged PR preview 에도 PR 제목/본문을 채우는 AI 버튼이 있습니다.

이 기능은 로컬 CLI 를 비대화식으로 실행합니다. Claude Code 는 `claude -p`, Codex 는 `codex exec` 경로를 사용합니다. `Git Simple Compare: AI CLI 설정` 명령이나 커밋 AI 버튼 옆 gear 버튼에서 provider, 로그인/상태 흐름, 실행 파일 경로, 모델/profile 옵션, 추론 강도, 기본 응답 언어, 추가 프롬프트 지시문, timeout 을 설정할 수 있습니다. 모델과 추론 강도 선택기는 설치된 provider CLI metadata 를 불러옵니다.

브라우저 callback 로그인이 localhost 에 도달하지 못하면 AI CLI 설정에서 callback 을 쓰지 않는 로그인 방식으로 바꾸세요. Claude Code 는 `setup-token`, `console`, 또는 `sso`, Codex 는 `device`, `api-key`, 또는 `access-token` 을 선택한 뒤 로그인 / 상태를 다시 실행하면 됩니다.

커밋 메시지 AI 버튼은 staged 변경이 있을 때만 활성화됩니다. PR preview 에서는 복사 버튼으로 생성된/현재 PR 제목과 본문을 GitHub 에 붙여넣기 좋은 형식으로 클립보드에 복사할 수 있습니다.

### 좌→우 반영

파일↔브랜치 diff 가 활성화되면 에디터 제목 표시줄에 **좌측 내용을 우측에 반영**(→) 버튼이 나타납니다. 작업 파일 전체를 브랜치 버전으로 교체하며, 에디터 편집으로 적용되므로 저장 전에 검토·실행취소·수정할 수 있습니다.

## 언어

UI 기본 언어는 **영어**입니다. VS Code 표시 언어를 한국어(`ko`)로 설정하면 모든 명령·메시지가 자동으로 한국어로 전환됩니다. 명령 팔레트의 *"표시 언어 구성"* 에서 바꿀 수 있습니다.

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `gitSimpleCompare.diffBase` | `twoDot` | 브랜치 비교 기준 (`twoDot`=직접 비교, `threeDot`=공통 조상 기준) |
| `gitSimpleCompare.includeRemoteBranches` | `true` | 브랜치 선택 목록에 원격 브랜치 포함 여부 |
| `gitSimpleCompare.aiCliProvider` | `auto` | AI CLI provider (`auto`, `claude`, `codex`) |
| `gitSimpleCompare.aiClaudeCommand` | `claude` | Claude Code 실행 파일 이름 또는 절대 경로 |
| `gitSimpleCompare.aiClaudeModel` | 빈 값 | CLI metadata 에서 선택한 Claude Code 모델 |
| `gitSimpleCompare.aiClaudeEffort` | 빈 값 | Claude Code 추론 강도 (`low`, `medium`, `high`, `xhigh`, `max`) |
| `gitSimpleCompare.aiClaudeSystemPrompt` | 빈 값 | `--append-system-prompt` 로 추가할 Claude Code 시스템 프롬프트 |
| `gitSimpleCompare.aiClaudeLoginMode` | `claudeai` | Claude 로그인 방식 (`claudeai`, `console`, `sso`, `setup-token`) |
| `gitSimpleCompare.aiCodexCommand` | `codex` | Codex 실행 파일 이름 또는 절대 경로 |
| `gitSimpleCompare.aiCodexModel` | 빈 값 | CLI model catalog 에서 선택한 Codex 모델 |
| `gitSimpleCompare.aiCodexReasoningEffort` | 빈 값 | Codex 추론 강도 (`low`, `medium`, `high`, `xhigh`, 지원 시 `max`) |
| `gitSimpleCompare.aiCodexProfile` | 빈 값 | `--profile` 로 전달할 Codex config profile |
| `gitSimpleCompare.aiCodexLoginMode` | `device` | Codex 로그인 방식 (`device`, `browser`, `api-key`, `access-token`) |
| `gitSimpleCompare.aiResponseLanguage` | `English` | AI 메시지 생성 언어 |
| `gitSimpleCompare.aiCommonInstructions` | 빈 값 | 커밋/PR 생성에 공통 적용할 추가 프롬프트 지시문 |
| `gitSimpleCompare.aiCommitInstructions` | 빈 값 | 커밋 생성에만 적용할 추가 프롬프트 지시문 |
| `gitSimpleCompare.aiPullRequestInstructions` | 빈 값 | PR 생성에만 적용할 추가 프롬프트 지시문 |
| `gitSimpleCompare.aiCliTimeoutMs` | `120000` | AI CLI 요청 timeout |

## 개발

```bash
npm install
npm run compile     # 번들
npm run watch       # 변경 감지 빌드
npm run check-types # 타입 검사
```

VS Code 에서 `F5` 를 누르면 Extension Development Host 가 실행됩니다.

### 코딩 에이전트

Codex 는 저장소 루트의 [`AGENTS.md`](./AGENTS.md) 를 읽습니다. Claude Code 는 [`CLAUDE.md`](./CLAUDE.md) 를 읽으므로, 이 저장소는 `CLAUDE.md` 에서 `AGENTS.md` 를 import 하게 해 두 도구가 같은 프로젝트 규칙을 따르게 했습니다. 개인 Claude Code 메모는 git 에 들어가지 않는 `CLAUDE.local.md` 에 둡니다.

## 배포

Marketplace publisher 는 `newdlops` 입니다. 배포 체크리스트는 [docs/publishing.md](./docs/publishing.md) 에 정리했습니다.

## 라이선스

MIT
