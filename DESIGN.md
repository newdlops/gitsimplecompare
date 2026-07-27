---
name: Git Simple Compare
description: VS Code 안에서 로컬 Git과 GitHub 리뷰를 연결하는 차분하고 고밀도인 작업 제어면
colors:
  action: "var(--vscode-button-background)"
  action-text: "var(--vscode-button-foreground)"
  action-hover: "var(--vscode-button-hoverBackground)"
  background: "var(--vscode-editor-background)"
  sidebar: "var(--vscode-sideBar-background)"
  surface: "var(--vscode-editorWidget-background)"
  surface-text: "var(--vscode-editorWidget-foreground)"
  foreground: "var(--vscode-foreground)"
  muted: "var(--vscode-descriptionForeground)"
  disabled: "var(--vscode-disabledForeground)"
  border: "var(--vscode-widget-border)"
  divider: "var(--vscode-panel-border)"
  focus: "var(--vscode-focusBorder)"
  selection: "var(--vscode-list-activeSelectionBackground)"
  selection-text: "var(--vscode-list-activeSelectionForeground)"
  hover: "var(--vscode-list-hoverBackground)"
  error: "var(--vscode-errorForeground)"
  warning: "var(--vscode-editorWarning-foreground)"
  success: "var(--vscode-testing-iconPassed)"
  added: "var(--vscode-gitDecoration-addedResourceForeground)"
  modified: "var(--vscode-gitDecoration-modifiedResourceForeground)"
  deleted: "var(--vscode-gitDecoration-deletedResourceForeground)"
typography:
  title:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "var(--vscode-font-size)"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.02em"
  code:
    fontFamily: "var(--vscode-editor-font-family)"
    fontSize: "var(--vscode-editor-font-size)"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  compact: "2px"
  control: "3px"
  surface: "4px"
  pill: "999px"
spacing:
  hairline: "2px"
  tight: "4px"
  compact: "6px"
  control: "8px"
  section: "12px"
  region: "16px"
  major: "24px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.action-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
    height: "28px"
  button-secondary:
    backgroundColor: "var(--vscode-button-secondaryBackground)"
    textColor: "var(--vscode-button-secondaryForeground)"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
    height: "28px"
  toolbar-button:
    backgroundColor: "transparent"
    textColor: "var(--vscode-icon-foreground)"
    rounded: "{rounded.control}"
    size: "28px"
  input:
    backgroundColor: "var(--vscode-input-background)"
    textColor: "var(--vscode-input-foreground)"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px 8px"
    height: "28px"
  list-row:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.compact}"
    padding: "3px 6px"
    height: "26px"
  status-pill:
    backgroundColor: "var(--vscode-badge-background)"
    textColor: "var(--vscode-badge-foreground)"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
---

# Design System: Git Simple Compare

## Overview

**Creative North Star: "The Native Control Room"**

Git Simple Compare는 별도 SaaS 대시보드처럼 보이지 않고 VS Code가 원래 제공했을 법한
작업 제어면처럼 느껴져야 한다. 화면은 차분하고 고밀도이며, 장식보다 현재 상태·대상·
다음 행동을 명확히 보여준다. 그래프, diff, 리뷰 큐처럼 정보가 많은 화면도 같은
간격·상태·포커스 문법을 공유해 사용자가 매번 UI를 다시 해석하지 않게 한다.

개인 개발자의 빠른 키보드 흐름과 팀·조직의 PR 운영 흐름은 동급이다. 개인 화면은
관리 정보를 숨기지 않고, 관리 화면은 개별 코드 리뷰로 곧바로 드릴다운할 수 있어야
한다. 두 흐름 모두 동일한 PR 상태 모델, 권한 표시, 필터, 진행률, 오류 복구 문법을
사용한다.

밀도는 높지만 답답하지 않아야 한다. 구획은 카드 장식보다 정렬, 여백, 얇은 경계,
VS Code의 표면 토큰으로 만든다. 중요한 상태는 색상 하나가 아니라 아이콘, 텍스트,
위치까지 함께 사용한다. 모션은 상태 변화의 원인과 결과를 연결할 때만 짧게 쓴다.

**Key Characteristics:**

- VS Code 테마와 글꼴을 그대로 따르는 네이티브성
- 2·4·6·8·12·16·24px 리듬의 차분한 고밀도
- 상태·권한·대상·복구 경로가 항상 드러나는 운영 도구 문법
- 목록에서 코드와 대화로 즉시 이동하는 드릴다운 구조
- 색상, 아이콘, 텍스트를 함께 쓰는 접근 가능한 상태 표현
- 밝은·어두운·고대비 테마에서 동일한 정보 위계

## Colors

팔레트는 확장 자체가 소유하지 않는다. 모든 기본색과 상태색은 현재 VS Code 테마의
의미 기반 토큰에서 가져오며, 사용자 테마가 바뀌면 같은 역할을 유지한 채 함께
바뀐다.

### Primary

- **Workbench Action:** 선택된 화면의 단 하나의 주 행동에 사용한다. 제출, 커밋,
  확인처럼 현재 흐름을 완료하는 버튼에만 배정한다.
- **Focus Signal:** 키보드 포커스, 활성 드롭 존, 현재 탐색 대상을 표시한다.

### Secondary

- **Git State Spectrum:** 추가·수정·삭제 상태는 VS Code의 Git decoration 색을
  사용한다. 배경을 넓게 칠하지 않고 아이콘, 짧은 라벨, 수치에 제한한다.
- **Operational Feedback:** 성공·경고·오류는 해당 VS Code 의미 토큰을 사용하고,
  반드시 상태 문구와 후속 행동을 함께 표시한다.

### Neutral

- **Workbench Canvas:** 편집기 배경은 코드·diff·리뷰 본문이 놓이는 기본 캔버스다.
- **Tool Surface:** 팝오버, 인스펙터, composer와 같은 떠 있는 작업면은 editor
  widget 표면을 사용한다.
- **Quiet Metadata:** 시간, 작성자, 보조 수치, 설명은 description foreground를
  사용하되 핵심 상태보다 낮은 위계로만 쓴다.
- **Structural Lines:** 경계와 구분선은 widget/panel border를 사용하고, 표면마다
  중복해서 두르지 않는다.

**The Theme Owns Color Rule.** 제품 고유의 고정 hex 색상으로 VS Code 테마를
덮어쓰지 않는다. 외부 서비스의 상태도 가장 가까운 VS Code 의미 토큰에 매핑한다.

**The Triple-Encoding Rule.** 병합 불가, 체크 실패, 변경 요청, 오래된 댓글 같은
중요 상태는 색상만으로 표시하지 않는다. 아이콘, 텍스트 라벨, 위치 또는 패턴 중
두 가지 이상을 색상과 함께 사용한다.

**The One Primary Action Rule.** 한 작업 영역 안에서 채워진 primary 버튼은 하나만
보인다. 다른 행동은 secondary, ghost, menu로 낮춘다.

## Typography

**Display Font:** 사용하지 않음

**Body Font:** VS Code UI font stack

**Label/Mono Font:** VS Code editor font stack

**Character:** 편집기와 같은 실용적이고 중립적인 글꼴을 사용한다. 크기와 굵기의
작은 차이, 정렬, 여백으로 위계를 만들며 마케팅형 큰 제목이나 장식용 폰트를
도입하지 않는다.

### Hierarchy

- **Headline** (600, 13px, 1.35): 편집기형 작업 공간의 PR 제목, 패널 핵심 제목.
- **Title** (600, 12px, 1.35): 섹션 제목, 파일 그룹, 인스펙터 블록 제목.
- **Body** (400, VS Code 기본 크기, 1.4): 설명, 댓글, 목록 주요 텍스트.
- **Label** (600, 11px, 0.02em): 짧은 상태, 표 머리글, compact control 라벨.
- **Code** (400, 편집기 설정 크기, 1.45): diff, 경로, SHA, 명령, 코드 suggestion.

긴 설명과 댓글 본문은 읽기 폭을 72ch 이하로 제한한다. 파일 경로와 SHA는 줄임표로
축약하되 hover tooltip과 접근 가능한 전체 이름을 제공한다. PR 제목과 사용자 작성
댓글은 한글·영문 모두 단어 중간을 임의로 자르지 않는다.

**The Editor Is the Typographic Authority Rule.** 코드와 diff는 사용자의 editor font
설정을 따르고, 나머지는 workbench font를 따른다. 별도 웹 폰트를 내려받지 않는다.

**The Density Comes from Rhythm Rule.** 10px 이하의 본문 글자로 정보를 억지로
압축하지 않는다. 밀도는 행 높이, 정렬, 점진적 공개로 만든다.

## Layout

모든 화면은 `command bar → context/header → primary work region → contextual
inspector/status` 순서를 공유한다. 사이드바는 빠른 상태 확인과 작은 행동을 담당하고,
편집기 웹뷰는 그래프·리뷰·계획처럼 다중 단계 작업을 담당한다. 모달은 제출 확인이나
파괴적 작업처럼 주변 문맥을 잠시 멈춰야 할 때만 사용한다.

기본 간격은 2·4·6·8·12·16·24px이다. 2–6px는 아이콘·배지·고밀도 행 내부,
8px는 컨트롤과 작은 묶음, 12–16px는 섹션, 24px는 큰 영역 사이에 사용한다.
compact 목록의 기본 행은 26px, 입력과 일반 버튼은 28px다. 댓글 composer와
복수 줄 내용을 담는 행은 콘텐츠 높이에 따라 확장한다.

편집기 가용 폭을 기준으로 다음처럼 적응한다.

- **좁음 (<560px):** 한 번에 하나의 주 영역만 보인다. 파일 목록과 인스펙터는
  전체 폭 drawer로 전환하고, 상단 command bar의 보조 행동은 overflow menu로
  이동한다.
- **소형 (560–799px):** 단일 주 영역 + 접을 수 있는 보조 rail. PR 파일 목록은
  overlay, 리뷰 요약은 하단 sheet로 연다.
- **중형 (800–1199px):** 목록/주 콘텐츠의 2열. inspector는 필요할 때 주 콘텐츠
  위에 겹치거나 오른쪽을 대체한다.
- **대형 (≥1200px):** 목록/주 콘텐츠/inspector의 3열. 분할선은 키보드와 포인터로
  조절하고 workspace별 마지막 폭을 저장한다.

사이드바 섹션은 단순히 모든 기능을 같은 accordion으로 늘어놓지 않는다. 현재
작업과 커밋을 상단의 주 영역으로 유지하고, History/Compare/Stashes/Worktrees는
최근 상태와 수치를 가진 보조 도구 그룹으로 정리한다. 다중 저장소에서는 선택된
저장소의 상태가 항상 header에 남는다.

**The Context Never Disappears Rule.** 스크롤과 드릴다운 중에도 저장소, 브랜치,
PR 번호, base/head, 새 커밋 감지 상태 중 현재 작업에 필요한 문맥은 sticky
context bar에 남는다.

**The Queue-to-Code Rule.** 관리 큐의 모든 행은 한 번의 활성화로 해당 PR 리뷰
workspace를 열며, 뒤로 가면 필터·정렬·선택·스크롤 위치가 복원된다.

## Elevation & Depth

기본은 평면이다. 깊이는 배경 톤, 한 줄 경계, 선택 상태로 만든다. shadow는 menu,
popover, tooltip, drag preview처럼 실제로 다른 층에 떠 있는 요소에만 VS Code의
widget shadow를 사용한다. 카드 안에 카드를 반복해 깊이를 만들지 않는다.

**The Flat-by-Default Rule.** 정적인 목록, 통계, 파일 블록에는 그림자를 사용하지
않는다. 겹치는 레이어만 그림자를 가질 수 있다.

**The Border Has One Owner Rule.** 맞닿는 두 영역의 경계는 한쪽만 그린다. 선택,
focus, validation border가 같은 픽셀에 겹치지 않게 한다.

## Shapes

형태는 작고 절제된 모서리를 사용한다. 고밀도 행과 작은 badge는 2px, 일반 입력과
버튼은 3px, popover와 독립 표면은 4px를 기본으로 한다. pill은 상태 badge, 필터
token처럼 짧고 반복되는 정보에만 쓴다. 큰 둥근 카드, 유리 효과, 장식적인 blob
형태는 사용하지 않는다.

선택 체크박스, Viewed 토글, review decision은 서로 다른 의미를 가지므로 같은
아이콘을 재사용하지 않는다. Codicon을 우선하고, Codicon에 없는 기능은 현재
선 두께와 16px grid에 맞춘 SVG만 추가한다.

## Components

### Buttons

- **Shape:** 작고 단단한 모서리(3px), 일반 높이 28px, compact icon action 24–28px.
- **Primary:** 현재 작업 영역의 완료 행동 하나에만 action 배경을 사용한다.
- **Secondary:** 취소가 아닌 대안 행동과 안전한 보조 행동에 사용한다.
- **Ghost/Icon:** toolbar와 행 액션에 사용한다. hover뿐 아니라 focus 시에도
  배경과 tooltip이 나타난다.
- **Hover / Focus:** hover는 toolbar/list hover 토큰, focus-visible은 1px 이상의
  focus border와 충분한 offset을 사용한다. focus outline을 제거만 하지 않는다.
- **Disabled:** opacity만 낮추지 않고 disabled foreground와 이유 tooltip을
  제공한다.
- 모든 아이콘 버튼, hover-only action, button 역할 컨트롤은 즉시 뜨는 tooltip,
  `title` 또는 `data-tooltip`, `aria-label`을 함께 가진다.

### Chips

- 필터 token과 PR label을 구분한다. 필터 token은 제거 가능하고 선택 상태를 가지며,
  PR label은 저장소 메타데이터 색과 이름을 표시하는 정보 객체다.
- 배경색이 임의 사용자 지정 label 색일 때 WCAG 대비를 계산해 전경색과 경계를
  자동 선택한다.
- 상태 pill은 최대 두 단어를 권장하며 전체 설명은 tooltip로 제공한다.

### Cards / Containers

- 독립적인 빈 상태, 제출 요약, 권한 경고처럼 경계가 필요한 내용에만 surface를
  사용한다.
- 통계는 네 개의 같은 카드로 나열하지 않고, 사용자의 다음 판단에 직접 필요한
  수치만 header 또는 compact summary strip에 둔다.
- 내부 padding은 compact 8px, 일반 12px, 읽기 중심 본문 16px다.

### Inputs / Fields

- 검색, filter, branch combobox, comment composer는 visible label 또는 접근 가능한
  이름을 가진다. placeholder를 label로 사용하지 않는다.
- focus는 focus-within을 포함해 input 전체 경계를 바꾼다.
- validation은 입력 아래 inline message와 `aria-describedby`로 연결한다.
- 제출 중에는 내용을 보존하고 해당 action만 pending 상태로 바꾼다.

### Navigation

- 탭은 `tablist/tab/tabpanel` 의미와 roving tabindex를 사용하고 좌우 화살표,
  Home/End를 지원한다.
- 상위 workspace 전환은 탭처럼 꾸민 버튼이 아니라 명시적 navigation 또는
  VS Code command로 노출한다.
- 현재 위치, 선택 파일, 미해결 댓글 수, Viewed 진행률은 navigation과 함께
  읽을 수 있어야 한다.

### Review Queue

- 한 행은 저장소/PR 번호, 제목, 작성자, 나에게 필요한 행동, review decision,
  required checks, 업데이트 시각, 크기/진행률을 우선순위 순으로 담는다.
- 열은 사용자가 표시 여부와 폭을 조정할 수 있고 workspace 범위에 저장한다.
- 행 전체가 열기 target이지만, assignee/reviewer/label 같은 inline control은
  독립된 버튼과 tooltip을 가진다.
- 50개를 넘는 결과는 windowing하며 화면 밖 행을 키보드로 탐색할 수 있어야 한다.

### Review Workspace

- 기본 대형 구성은 file navigator / diff / review inspector다.
- diff line 전체를 tab stop으로 만들지 않는다. 파일 및 thread navigation과
  명시적 “줄에 댓글 추가” action으로 키보드 접근을 제공한다.
- pending comment는 서버 제출 댓글과 시각적으로 구분하고, 현재 `headOid`와 함께
  표시한다.
- Viewed는 로컬 장식이 아니라 GitHub viewer state를 반영하며 optimistic 상태와
  실패 복구를 같은 위치에서 보여준다.
- submit review는 pending comment 수, 최신 head, 선택한 decision, 본문, 권한을
  한 화면에서 검증한다.

### Feedback and Empty States

- loading은 spinner만 중앙에 두지 않고 shell과 실제 형태를 닮은 skeleton을 쓴다.
- empty state는 “없음”과 “필터 결과 없음”과 “권한/인증 없음”을 구분한다.
- 오류는 실패한 범위 가까이에 원인, 영향, 재시도/설정/로그 열기 action을 둔다.
- 성공 toast는 짧게 알리되 결과를 확인할 위치와 undo가 가능한 경우 undo를 함께
  제공한다.

## Do's and Don'ts

### Do:

- **Do** VS Code 의미 토큰과 Codicon을 사용하고 고대비 테마까지 확인한다.
- **Do** 개인 리뷰와 팀·조직 관리 화면을 동일한 우선순위와 상태 모델로 설계한다.
- **Do** 화면에 보이는 모든 action에 hover, focus, active, disabled, pending,
  success, error 상태를 정의한다.
- **Do** 변경 가능한 관리 정보에 권한을 먼저 표시하고, 변경 결과를 즉시 재조회해
  서버 상태로 확인한다.
- **Do** 긴 파일명, 1,000개 파일, 수천 개 댓글, binary/renamed/deleted 파일,
  한국어/영어 혼합을 정상 상태로 취급한다.
- **Do** destructive action 전에 대상과 영향을 보여주고, 가능한 경우 undo 또는
  정확한 복구 경로를 제공한다.
- **Do** webview state를 다시 열었을 때 filter, selection, layout, draft를
  합리적인 범위에서 복원한다.

### Don't:

- **Don't** GitHub 웹 UI를 그대로 복제하거나 별도의 화려한 SaaS 디자인 언어를
  만든다.
- **Don't** 상단 toolbar 한 줄에 모든 기능을 같은 위계의 icon button으로 놓는다.
- **Don't** hover에서만 발견 가능한 핵심 행동을 만든다.
- **Don't** `outline: none`을 대체 focus 표시 없이 사용한다.
- **Don't** 고정 hex, 고정 흰색/검정, 임의 상태색으로 테마 토큰을 우회한다.
- **Don't** 단순 build/typecheck 통과를 visual QA 완료로 간주한다.
- **Don't** 새 push로 댓글 위치가 오래되었을 때 draft를 조용히 새 head에 제출한다.
- **Don't** 외부 백엔드나 새로운 프런트엔드 프레임워크를 UI 정리의 전제조건으로
  추가한다.
