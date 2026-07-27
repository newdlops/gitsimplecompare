# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Git Simple Compare는 VS Code 안에서 Git 변경과 GitHub Pull Request를 다루는 개발자,
리뷰어, 저장소 관리자, 팀 리드를 위한 확장이다. 개인·소규모 팀의 키보드 중심
파워유저뿐 아니라, 여러 PR과 리뷰 상태를 지속적으로 추적하고 운영해야 하는 조직
사용자도 동등한 핵심 사용자다.

주 사용 상황은 코드를 읽고 편집하는 도중이다. 사용자는 브라우저와 터미널을
오가며 문맥을 다시 만드는 대신, 현재 로컬 작업트리·브랜치·커밋·GitHub PR의
관계를 VS Code 안에서 이해하고 다음 Git 또는 리뷰 작업을 수행한다.

## Product Purpose

로컬/원격 브랜치 비교, 파일 비교, 편집 가능한 diff, 스테이징·커밋, 충돌 해결,
rebase, 커밋 분할, Git 그래프, worktree, PR 생성·검토·stack 수명주기를 하나의
개발 환경 안에서 연결한다.

성공은 사용자가 현재 저장소와 리뷰 상태를 빠르게 파악하고, 위험한 변경을 실행하기
전에 영향을 이해하며, 비교에서 편집·검토·의사결정까지 문맥을 잃지 않고 완료하는
것이다.

## Positioning

제품의 고유한 메커니즘은 로컬 Git의 실제 상태와 원격 GitHub PR 맥락을 VS Code의
편집 가능한 diff 및 네이티브 에디터 흐름에 결합하는 것이다. PR을 단순히
브라우저로 연결하거나 Git 상태만 시각화하는 대신, 같은 파일과 브랜치 맥락에서
비교·편집·스테이징·리뷰·후속 Git 작업을 이어간다.

## Operating Context

- VS Code 데스크톱 확장으로 동작하며 사이드바 웹뷰, 전체 편집기 웹뷰, VS Code
  트리/Comment API, diff 및 merge editor, Quick Pick, Output 채널을 함께 사용한다.
- Git 접근은 로컬 `git` CLI를 통해 이뤄지고, GitHub PR 접근과 변경은 현재의
  `gh` CLI 및 선택적 GitHub 웹 세션 방식을 사용한다.
- GitHub를 원격 PR 플랫폼으로 유지하며 별도 외부 백엔드는 두지 않는다.
- UI 기본 언어는 영어이고 VS Code 표시 언어가 한국어일 때 한국어 번역을 제공한다.
- 사용자는 짧은 로컬 변경부터 파일·커밋·댓글이 매우 많은 저장소와 PR까지 다룬다.

## Capabilities and Constraints

- 브랜치/파일 비교와 작업트리 쪽 직접 편집
- 작업트리 변경의 스테이징, 커밋, hook 사전 실행, AI 커밋 계획과 메시지 생성
- Git 그래프, reflog 복구, stash, worktree, branch 작업
- merge/rebase/cherry-pick/revert 충돌 해결과 interactive rebase
- GitHub PR 목록·상세·대화·변경 파일·inline review comment 조회, staged PR 생성,
  PR stack 생성·restack·submit/sync·advance
- 기존 PR 리뷰 UI는 읽기와 로컬 Viewed 상태 중심이다. 대화, inline comment,
  suggestion, Viewed, Approve, Request changes, Comment 제출까지 완결된 리뷰
  경험으로 확장하는 것이 이번 제품 방향에 포함된다.
- 팀·조직 관리 UI는 후순위가 아니다. PR 큐, 담당과 검토 상태, 진행률, 체크/정책
  가시성, 대량 탐색을 개인 리뷰 흐름과 함께 설계한다.
- 조직별 정책 설정·권한 모델의 정확한 범위는 아직 열린 결정이다. 현재 저장소
  메타데이터와 GitHub API로 지원 가능한 범위부터 정의한다.
- 웹뷰는 VS Code 테마 토큰과 Codicon을 사용하고, 확장의 git/UI/provider/command
  모듈 경계를 유지해야 한다.

## Brand Commitments

제품명은 **Git Simple Compare**다. 사용자를 과도하게 안내하거나 Git 개념을
감추기보다, 정확하고 간결한 개발 도구 언어를 사용한다. VS Code 안에서 동작하는
도구라는 정체성과 네이티브 편집기 affordance를 유지한다.

## Evidence on Hand

- 제품 기능과 사용 흐름: `README.md`, `README.ko.md`
- VS Code 기여 명령·뷰·설정: `package.json`
- 사이드바 UI: `src/webview/changes*`, `media/changes/`
- Git 그래프와 PR/stack UI: `src/webview/graph*`, `media/graph/`
- PR preview와 리뷰 데이터: `src/webview/pullRequestPreview*`,
  `src/git/pullRequest*`, `src/providers/pullRequest*`, `src/ui/pullRequest*`
- rebase·커밋 분할·AI 계획 UI: `src/webview/{rebase,split,commitPlan}*`,
  `media/{rebase,split,commit-plan}/`
- 실제 사용자 연구, 사용성 측정, 조직 정책 표본, 디자인 원본(Figma 등)은 현재
  저장소에 없다. 향후 계획과 UI는 이를 실제 증거처럼 꾸며내지 않는다.

## Product Principles

1. 비교에서 행동까지 사용자의 코드 문맥을 보존한다.
2. 로컬 Git 상태와 원격 PR 상태의 차이를 숨기지 않고 명확히 설명한다.
3. 개인 실행 흐름과 팀·조직 운영 흐름을 모두 1급 경험으로 설계한다.
4. 위험하거나 되돌리기 어려운 작업은 영향·대상·복구 경로를 실행 전에 보여준다.
5. 대규모 저장소와 긴 리뷰에서도 점진적 로딩, 검색, 필터, 진행 상태로 작업 가능성을
   유지한다.

## Accessibility & Inclusion

모든 기능은 키보드로 도달·실행 가능해야 하고, 포커스가 명확히 보여야 한다.
아이콘과 hover-only 액션에는 즉시 이해 가능한 tooltip과 접근성 이름을 함께
제공한다. 색상만으로 상태를 전달하지 않으며 VS Code의 밝은/어두운/고대비 테마,
확대, 긴 영어·한국어 문자열, reduced motion을 지원한다.
