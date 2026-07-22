# PR Stack 사용 가이드

Git Simple Compare의 PR Stack 기능은 스택을 **보여 주기만 하는 기능이 아닙니다**.
브랜치 생성부터 부모 변경에 따른 연쇄 rebase, push와 PR 생성·갱신, 아래 PR이 merge된 뒤 승격과 정리까지 한 흐름으로 관리합니다.

핵심 동작은 네 가지입니다.

| 동작 | 확장이 대신 하는 일 |
| --- | --- |
| **Add Layer** | 부모 tip에서 자식 브랜치를 만들고, 선택하면 linked worktree도 만든 뒤 부모 관계를 기록합니다. |
| **Restack** | 이동한 부모 위로 선택 레이어와 모든 후손을 순서대로 rebase하고, 충돌 계속/중단과 복구를 관리합니다. |
| **Submit / Sync** | 스택을 부모부터 push하고, PR을 생성하거나 base를 갱신하며, 각 PR 본문의 스택 목록도 동기화합니다. |
| **Advance** | 아래 PR이 merge되면 자식을 이전 base로 승격하고, restack·push·PR base 변경·안전한 로컬 정리를 이어서 수행합니다. |

## PR Stack이란?

큰 변경 하나를 리뷰 가능한 작은 PR 여러 개로 나누되, 위 PR이 바로 아래 PR에 의존하도록 만든 구조입니다.

예를 들어 다음과 같이 작업을 나눌 수 있습니다.

```text
main
└─ feature/api
   └─ feature/ui
      └─ feature/tests
```

GitHub PR의 base/head 관계는 다음과 같습니다.

```text
feature/api   → main
feature/ui    → feature/api
feature/tests → feature/ui
```

그래프에서는 `부모 ← 자식`으로 표시합니다.

```text
main ← feature/api ← feature/ui ← feature/tests
```

이렇게 하면 각 PR에는 바로 앞 단계 이후에 추가한 변경만 나타납니다.

## 사용 전 준비

다음 조건이 필요합니다.

1. 작업 폴더가 Git 저장소여야 합니다.
2. GitHub 저장소를 가리키는 remote가 있어야 합니다.
3. GitHub CLI인 `gh`가 설치되어 있어야 합니다.
4. `gh`가 해당 GitHub 호스트에 로그인되어 있어야 합니다.
5. PR에 보낼 변경은 각 로컬 브랜치에 커밋되어 있어야 합니다.

터미널에서는 다음처럼 확인할 수 있습니다.

```bash
git remote -v
gh --version
gh auth status
gh repo view
```

로그인이 필요하면 다음을 실행합니다.

```bash
gh auth login
```

확장은 staged/unstaged 파일을 자동 커밋하지 않습니다. Submit / Sync는 이미 만들어진 브랜치 commit만 게시합니다.

## Graph에서 스택 읽기

1. 명령 팔레트에서 **Git Simple Compare: Git Graph 열기**를 실행합니다.
2. Graph 툴바의 레이어 아이콘인 **Manage pull request stacks**를 누릅니다.
3. 오른쪽 상세 영역에서 전체 스택 또는 개별 레이어를 선택합니다.

Changes 뷰에 별도 아코디언은 없습니다. 스택 정보는 commit 관계를 봐야 의미가 있으므로 Git Graph에 직접 표시됩니다.

Graph에는 다음 장식이 나타납니다.

- 레이어의 head commit 행에 `L1`, `L2` 같은 레이어 chip이 붙습니다.
- PR이 있으면 chip에 `#번호`와 상태가 표시됩니다.
- 자식 head에서 부모 commit으로 점선 화살표가 이어집니다.
- 기록된 부모 tip이 현재 부모 tip과 달라지면 경고 아이콘이 나타납니다.
- 레이어를 누르면 부모, 로컬 브랜치 여부, PR 상태, restack 필요 여부, worktree 경로와 자식 레이어를 확인할 수 있습니다.

Graph에 부모나 head commit이 아직 로드되지 않았다면 그 구간의 화살표는 보이지 않을 수 있습니다. 레이어 관계 자체는 오른쪽 스택 상세에 계속 표시됩니다.

## 1. Add Layer — 다음 레이어 만들기

Add Layer는 새 브랜치만 만드는 것이 아니라, 스택에서 누구의 자식인지 함께 기록합니다.

### Graph에서 시작

다음 중 하나를 사용합니다.

- 전체 스택 화면의 **Add a new stack layer** 버튼
- 특정 레이어 상세의 **Add a child layer above ...** 버튼
- 명령 팔레트의 **Git Simple Compare: Add Pull Request Stack Layer...**

전체 화면에서 시작하면 부모 브랜치를 먼저 고릅니다. 레이어 상세에서 시작하면 해당 레이어가 부모로 미리 선택됩니다.

### 생성 과정

1. 새 자식 브랜치 이름을 입력합니다.
2. **Create Linked Worktree** 또는 **Create Branch Only**를 선택합니다.
3. linked worktree를 선택했다면 제안된 절대 경로를 확인합니다.
4. 최종 부모와 생성 위치를 확인하고 **Create Layer**를 승인합니다.

확장은 다음을 수행합니다.

1. 현재 부모 commit OID를 확인합니다.
2. 그 commit에서 새 자식 브랜치를 만듭니다.
3. 선택한 경우 새 브랜치의 linked worktree도 만듭니다.
4. 자식 브랜치에 부모 이름과 당시 부모 tip을 로컬 Git 설정으로 기록합니다.
5. Graph를 갱신해 PR을 만들기 전부터 레이어 흐름을 표시합니다.

linked worktree 방식이 기본 권장 흐름입니다. 아래 PR을 수정하는 동안 위 레이어 작업 폴더를 따로 유지할 수 있어 checkout 전환과 미커밋 변경 충돌을 줄여 줍니다.

### 기록되는 메타데이터

관계는 저장소의 로컬 Git config에 저장됩니다.

```text
branch.<child>.gscStackParent
branch.<child>.gscStackParentHead
```

첫 값은 부모 브랜치, 두 번째 값은 마지막으로 정렬되었을 때의 부모 commit입니다. 저장소 파일을 만들지 않으므로 커밋에 섞이지 않으며, 같은 저장소의 linked worktree가 관계를 공유합니다.

## 2. Restack — 부모 변경을 후손 전체에 반영하기

아래 레이어를 수정하거나 rebase하면 위 레이어가 기억하는 부모 commit과 현재 부모 tip이 달라집니다. Graph의 경고 chip은 이 상태를 뜻합니다.

예를 들어 `feature/api`를 수정했다면 다음처럼 바뀝니다.

```text
변경 전: A(api) ─ B(ui) ─ C(tests)
변경 후: A'(api)
```

Restack은 `B`와 `C`의 고유 commit을 차례로 새 부모에 옮깁니다.

```text
A'(api) ─ B'(ui) ─ C'(tests)
```

### 실행 방법

1. Graph에서 다시 정렬할 첫 로컬 레이어를 선택합니다.
2. **Restack ... and descendants** 버튼을 누릅니다.
3. 미리보기에서 각 레이어의 `old parent → new parent` commit을 확인합니다.
4. **Restack**을 승인합니다.

명령 팔레트의 **Git Simple Compare: Restack Pull Request Stack...**을 실행해 레이어를 고를 수도 있습니다.

### 확장이 수행하는 안전 절차

Restack은 선택 레이어부터 모든 후손을 부모 우선 순서로 처리합니다.

1. 관련 브랜치가 checkout된 모든 worktree가 깨끗한지 검사합니다.
2. 히스토리를 바꾸기 전에 각 레이어 tip의 안전 ref를 만듭니다.
3. 브랜치가 기존 worktree에 있으면 그 worktree를 사용합니다.
4. checkout되지 않은 브랜치는 임시 linked worktree에서 처리합니다.
5. 각 레이어에 `git rebase --onto <현재 부모> <이전 부모> <레이어>`를 적용합니다.
6. 성공한 레이어의 부모 tip 메타데이터를 갱신합니다.
7. 임시 worktree를 정리하고 Graph를 다시 그립니다.

안전 ref는 다음 namespace에 남습니다.

```text
refs/gitsimplecompare/stack-backups/<작업-ID>/<브랜치>
```

### 이전 부모 경계를 추론한 경우

오래된 브랜치를 처음 스택에 연결했거나 메타데이터가 불완전하면 이전 부모 OID가 없을 수 있습니다. 이때 확장은 merge-base를 경계로 제안하고 미리보기에 `inferred boundary` 경고를 표시합니다.

이 경고가 보이면 옮겨질 commit 범위를 특히 주의해서 확인하세요. 승인 전에는 히스토리를 변경하지 않습니다.

### 충돌이 발생하면

Restack은 첫 충돌에서 멈추고 정확한 worktree의 충돌 파일을 엽니다.

1. Git Simple Compare의 Conflicts 뷰나 VS Code Merge Editor에서 충돌을 해결합니다.
2. 해결한 파일을 stage합니다.
3. Conflicts 뷰에서 **Continue**를 실행합니다.

현재 레이어가 끝나면 확장이 남은 레이어를 자동으로 이어서 restack합니다. 다음 레이어에서 다시 충돌하면 같은 방식으로 멈춥니다.

**Abort**를 선택하면 이미 완료된 앞 레이어까지 안전 ref에서 원래 tip으로 복원하고, 부모 메타데이터도 작업 전 값으로 되돌립니다.

## 3. Submit / Sync — push와 PR을 스택 단위로 동기화하기

Submit / Sync는 선택한 한 브랜치만 게시하지 않습니다. 그 브랜치가 속한 연결 스택 전체를 root부터 leaf까지 처리합니다.

### 실행 방법

1. Graph에서 로컬 스택 레이어를 선택합니다.
2. **Submit or sync the stack containing ...** 버튼을 누릅니다.
3. remote를 선택합니다. 하나뿐이면 자동 선택됩니다.
4. 새 PR을 **Draft** 또는 **Ready for Review**로 만들지 선택합니다.
5. push, PR 생성·갱신, 본문 갱신 계획을 확인하고 **Submit / Sync**를 승인합니다.

명령 팔레트의 **Git Simple Compare: Submit / Sync Pull Request Stack...**에서도 실행할 수 있습니다.

### 레이어마다 수행되는 작업

확장은 부모 레이어부터 다음을 반복합니다.

1. 로컬과 실제 원격 branch OID를 비교합니다.
2. 새 원격 브랜치는 upstream을 연결하며 push합니다.
3. fast-forward 가능한 브랜치는 일반 push합니다.
4. restack으로 원격 히스토리가 재작성된 경우에만 `--force-with-lease=<실제 원격 OID>`로 push합니다.
5. PR이 없으면 바로 아래 부모 브랜치를 base로 새 PR을 만듭니다.
6. PR이 이미 있으면 base가 현재 로컬 스택 관계와 같은지 확인하고 다르면 갱신합니다.
7. 각 PR 본문의 관리 marker 사이에 전체 스택 순서와 PR 번호를 갱신합니다.

PR 본문에서 사용자가 작성한 설명은 유지됩니다. 확장이 관리하는 영역만 교체됩니다.

```html
<!-- git-simple-compare-stack:start -->
... 확장이 관리하는 스택 목록 ...
<!-- git-simple-compare-stack:end -->
```

### force push 안전성

Submit / Sync는 무조건 force push하지 않습니다.

- 원격과 같으면 push하지 않습니다.
- fast-forward면 일반 push합니다.
- 재작성된 경우에만 force-with-lease를 사용합니다.
- 확인 직후 다른 사람이 원격 branch를 갱신했다면 lease가 어긋나 push가 실패합니다.

즉, 동시 변경을 덮어쓰는 일반 `--force`는 사용하지 않습니다. 실패하면 원격을 확인한 뒤 다시 Restack 또는 Submit / Sync하세요.

또한 자식 branch에 현재 부모가 포함되지 않았다면 PR을 올리기 전에 중단하고 Restack을 요구합니다. 잘못된 diff를 그대로 게시하지 않습니다.

## 4. Advance — 아래 PR merge 후 다음 레이어 승격하기

아래 PR이 merge된 뒤에는 그 자식 PR의 base와 로컬 commit 경계를 실제 대상 branch로 올려야 합니다.

```text
merge 전: main ← api ← ui ← tests
api merge: main에 api merge commit 반영
승격 후: main ← ui' ← tests'
```

### 실행 방법

1. Graph에서 `MERGED` 상태이며 로컬 자식이 있는 레이어를 선택합니다.
2. **Advance children after merged PR ...** 버튼을 누릅니다.
3. 승격될 자식, 새 부모, 후손 restack 계획을 확인합니다.
4. **Advance Stack**을 승인합니다.

Graph에서 merged 레이어를 찾기 어렵다면 명령 팔레트의 **Git Simple Compare: Advance Pull Request Stack After Merge...**를 실행하세요. 확장이 GitHub에서 merged 상태인 후보만 골라 보여 줍니다.

### 확장이 이어서 수행하는 작업

1. `gh`로 대상 PR이 실제 `MERGED`인지 다시 검증합니다.
2. 이전 base branch를 remote에서 fetch해 merge 결과가 포함된 정확한 tip을 얻습니다.
3. merged 레이어의 모든 직접 자식을 이전 base의 자식으로 승격합니다.
4. 각 자식 subtree를 부모 우선으로 restack합니다.
5. 충돌이 없으면 승격된 스택을 자동으로 Submit / Sync합니다.
6. 기존 PR base와 본문 스택 목록을 새 관계로 갱신합니다.
7. 마지막으로 merge된 로컬 branch와 linked worktree 정리를 제안합니다.

Advance 도중 충돌이 나면 일반 Restack과 똑같이 Conflicts 뷰에서 Continue 또는 Abort할 수 있습니다. Continue로 마지막 레이어까지 끝나면 Submit / Sync와 정리 제안이 자동 재개됩니다.

### 로컬 정리 원칙

정리는 별도 확인을 받아야 실행됩니다.

- linked worktree에 변경이 있으면 자동 제거하지 않습니다.
- main worktree 또는 현재 worktree에서 checkout된 branch는 자동 제거하지 않습니다.
- branch는 `git branch -d`에 해당하는 안전 삭제만 사용합니다.
- Git이 아직 merge되지 않은 commit을 발견하면 삭제가 거부됩니다.

조건을 만족하지 않으면 PR 승격과 동기화는 완료하되, 로컬 branch를 남긴 이유를 알려 줍니다.

## 처음부터 3단 스택 만들기

다음 흐름이면 브랜치와 PR을 터미널에서 하나씩 만들 필요가 없습니다.

1. Graph에서 `main`을 부모로 **Add Layer**를 실행해 `feature/api` linked worktree를 만듭니다.
2. 해당 worktree에서 API 변경을 커밋합니다.
3. `feature/api` 레이어에서 **Add Layer**를 실행해 `feature/ui`를 만듭니다.
4. UI 변경을 커밋한 뒤 같은 방식으로 `feature/tests`를 만듭니다.
5. 어느 로컬 레이어에서든 **Submit / Sync**를 실행합니다.

확장이 다음 순서로 게시합니다.

```text
#1 feature/api   → main
#2 feature/ui    → feature/api
#3 feature/tests → feature/ui
```

아래 레이어를 리뷰 중 수정해 히스토리가 바뀌면 Graph 경고를 확인하고 **Restack**, 이어서 **Submit / Sync**를 실행합니다. #1이 merge되면 **Advance**로 #2와 #3을 올립니다.

## OUTPUT 로그

문제를 진단하려면 VS Code의 **보기 → 출력**에서 **Git Simple Compare** 채널을 선택합니다.

다음 상태가 기록됩니다.

- 레이어 생성과 Graph 새로고침
- restack 계획, 레이어별 시작·완료, 안전 ref
- dirty worktree로 인한 사전 중단
- 충돌 worktree와 충돌 파일
- Continue, Abort, 복원 결과
- 레이어별 push 방식과 PR 번호
- Advance 승격, PR 동기화, 로컬 정리 결과
- `git` 또는 `gh` 실패의 재현 문맥

## 안전 동작 요약

- Add Layer는 기존 브랜치를 덮어쓰지 않습니다.
- Restack은 관련 worktree가 dirty면 시작하지 않습니다.
- 히스토리 변경 전 모든 대상 레이어의 안전 ref를 만듭니다.
- Restack Abort는 이미 처리한 레이어까지 원복합니다.
- Submit / Sync는 실제 원격 OID를 읽고 명시적 force-with-lease만 사용합니다.
- Advance는 GitHub의 실제 merged 상태와 remote base tip을 다시 확인합니다.
- merged branch/worktree 삭제는 별도 승인과 clean/merged 검사를 통과해야 합니다.
- 모든 mutation 전에는 실행 범위를 보여 주는 modal 확인이 나타납니다.

## 제한 사항

- 현재 Submit / Sync는 같은 GitHub 저장소에 branch를 push하는 흐름을 기준으로 합니다.
- fork에서 온 원격 전용 PR은 Graph 관계로 표시할 수 있지만 로컬 레이어가 아니므로 Restack과 Submit 대상이 아닙니다.
- 로컬 stack 메타데이터는 clone 사이에 자동 공유되지 않습니다. 다른 clone에서는 Add Layer로 만들거나 동일한 관계를 다시 기록해야 합니다.
- GitHub merge queue나 서버 측 branch update가 발생하면 Graph 새로고침 후 현재 remote 상태를 기준으로 다시 판단합니다.
- 자동 commit은 하지 않습니다. 각 레이어의 작업을 커밋하는 책임은 사용자에게 있습니다.

## 문제 해결

### `GitHub CLI (gh) is required`

VS Code 프로세스의 PATH에서 `gh`를 실행할 수 있는지 확인합니다.

```bash
gh --version
```

설치 또는 PATH를 바꿨다면 VS Code를 완전히 종료했다가 다시 여세요.

### 인증 또는 저장소 조회 오류

```bash
gh auth status
gh repo view
```

필요하면 `gh auth login`으로 로그인하고 현재 remote URL이 의도한 GitHub 저장소인지 확인합니다.

### Graph에는 레이어가 있는데 PR 번호가 없음

Add Layer로 만든 로컬 관계는 PR 생성 전부터 표시됩니다. **Submit / Sync**를 실행하면 branch가 게시되고 PR 번호가 연결됩니다.

### `Restack required` 또는 부모 ancestor 오류

자식 브랜치가 현재 부모 tip 위에 있지 않습니다. Graph에서 경고 레이어를 선택하고 **Restack**한 뒤 다시 Submit / Sync하세요.

### dirty worktree 오류

대상 레이어가 checkout된 worktree의 변경을 먼저 커밋하거나 stash하세요. 확장은 미커밋 변경을 옮기거나 삭제하지 않습니다.

### force-with-lease 실패

확장이 확인한 뒤 원격 branch가 바뀐 것입니다. 다른 사람의 변경을 확인하고 fetch한 다음, 필요하면 Restack하고 Submit / Sync를 다시 실행하세요. 일반 force push로 우회하지 않는 것이 안전합니다.

### 충돌 후 어떤 폴더를 수정해야 하는지 모르겠음

Conflicts 뷰에 표시된 파일은 확장이 restack 중인 정확한 worktree를 기준으로 합니다. 알림과 OUTPUT 로그에도 해당 절대 경로가 남습니다. 그 worktree에서 해결·stage한 뒤 Continue하세요.

### 안전 ref로 수동 확인하기

Abort 외에 직접 원본을 비교해야 한다면 다음으로 안전 ref를 볼 수 있습니다.

```bash
git for-each-ref refs/gitsimplecompare/stack-backups/
```

안전 ref 삭제는 확장이 자동으로 수행하지 않습니다. 작업이 완전히 끝났음을 확인한 뒤 Git ref 관리에 익숙한 사용자가 별도로 정리할 수 있습니다.
