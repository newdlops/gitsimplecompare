# UI 스타일 권고 정리 검증 — 2026-10-06

대상 버전: Git Simple Compare 0.1.72085.
0.1.72084 검증에서 남긴 Changes CSS 권고 14건을 처리했다.
기존 VS Code 테마·화면 구조·Git 동작을 유지하는 스타일 정리다.

## 14건의 처리

아래 줄 번호는 수정 전 `media/changes/changes.css` 기준이다.

| 항목 | 기존 위치·역할 | 처리 |
| --- | --- | --- |
| 1 | 42, 영역 제목 10px | 중복 정의를 정보 영역 모듈로 모으고 공용 label 11px 적용 |
| 2 | 54, 기본 Codicon 16px | 공용 기본 icon 토큰 사용, 실제 크기 유지 |
| 3 | 116, 섹션 twistie 16px | 공용 기본 icon 토큰 사용, 실제 크기 유지 |
| 4 | 145, 충돌 수 배지 10px | 공용 label 11px 적용 |
| 5 | 153, 충돌 배지 glyph 12px | 공용 compact icon 토큰 사용 |
| 6 | 215, 툴팁 12px | 공용 caption 토큰과 디자인 시스템의 역할 명시 |
| 7 | 457, 사용자 파일 icon glyph 16px | 기본 icon 토큰 사용, 테마가 지정한 글꼴·크기 우선 |
| 8 | 650, 작업 중 glyph 14px | 공용 small icon 토큰 사용 |
| 9 | 1132, 그룹 twistie 16px | 공용 기본 icon 토큰 사용 |
| 10 | 1175, 그룹 action 14px 선언 | Codicon의 실제 16px에 가려진 불필요한 선언 제거 |
| 11 | 1208, 행 action 14px 선언 | Codicon의 실제 16px에 가려진 불필요한 선언 제거 |
| 12 | 1245, 메뉴 radius 5px | 공용 surface radius 4px 적용 |
| 13 | 1280, 메뉴 check 14px 선언 | 기본 Codicon을 상속하도록 불필요한 선언 제거 |
| 14 | 1285, 하위 메뉴 glyph 14px 선언 | 기본 Codicon을 상속하도록 불필요한 선언 제거 |

본문 크기와 glyph 기하 규격을 구분해 DESIGN.md와 sidecar에 caption 및
16/14/12px icon 역할을 명시했다. 본문·코드 글꼴은 계속 사용자 VS Code 설정을 따른다.
권고를 일괄 무시하지 않고 실제 불일치를 고치고 중복/무효 선언을 제거했다.
Codicon과 12px fixture의 기존 예외 세 개는 더 이상 필요 없어 삭제했다.
파일 이력 테스트의 사용자 editor font Menlo 예외는 유지했다.

Impeccable 최종 제품 코드 검사에는 원래 14건이 모두 없어졌다. 함께 검사한
웹뷰 테스트 harness의 `gsc-test-codicon` 세 곳은 같은 `media/codicons/codicon.ttf`를
불러오는 시험용 FontFace 별칭이다. 해당 값과 해당 파일에만 이유를 기록한 예외를
추가했다. 제품의 글꼴 변경이나 파일/규칙 전체 무시를 사용하지 않았다.

## 모듈·리소스 연결

- `changes.css`: 348줄, sidebar shell·section·resize·selection.
- `changesFiles.css`: 564줄, 파일 행·진행 상태·History·Stash.
- `changesActions.css`: 360줄, commit 입력·그룹/행 action·메뉴.
- 정보 영역의 중복 제목 선언은 `changesInformationArchitecture.css`로 모았다.
- HTML과 browser harness가 shell → files → actions 순으로 새 CSS를 읽는다.
  기존 Compare·AI·Hooks·Worktrees 등의 override 순서는 유지했다.
- 두 새 파일을 리소스 버전 계산에 넣어 캐시된 이전 CSS를 계속 쓰지 않게 했다.

## 함께 발견한 메뉴 툴팁 문제

키보드로 메뉴를 열 때 포커스가 배치보다 먼저 적용되어 툴팁이 화면 왼쪽 위에 떴다.
배치 후 포커스를 주도록 바꿨고, 하위 메뉴 진입·복귀에도 같은 순서를 적용했다.

동작 축소 모드의 공용 `transition-duration: 1ms`는 기본 `transition-property: all`에
짧은 좌표 전환을 만들었다. 이 경우 style 속성은 최종 좌표인데 focusin에서 읽는
실제 사각형은 이전 좌표였다. 동작 축소 모드의 transition duration/delay를 0ms로
바꿔 위치가 즉시 적용되게 했다. 일반 모드의 기존 전환은 유지한다.

실제 before 기록에서는 메뉴 행 y=378px인데 tooltip y=33px였다.
수정 후 root/submenu에서 포커스 행과 tooltip 사이 간격이 8px 이내임을 검사했다.

## 검사 결과

- TypeScript 검사 및 `git diff --check` 통과.
- 변경 관련 Node controller 테스트 2개 통과.
- 관련 Chromium 검사 21개 통과: 15,000개 파일의 가상 목록·폴더 action·다중 선택,
  History 로딩/완료/포커스, Stash 저장소 연결/메뉴, 280/360/480px sidebar,
  Axe·키보드·forced colors·reduced motion 및 새 메뉴 위치 회귀 6개.
  동작 축소 수정 후에는 영향받는 메뉴/접근성/History 검사 11개를 다시 통과했다.
- 별도 실제 renderer 비교는 390×844, 768×1024, 1440×900 및
  dark/light/high-contrast 9개 조합에서 정상·진행·메뉴 상태를 검사했다.
  모든 조합에서 키보드 하위 메뉴 진입/복귀/선택과 Escape 포커스 복원을 확인했다.
- 14개 역할 × 9개 조합, 126개 computed-style 기록을 수정 전후 비교했다.
  label 10→11px, 메뉴 radius 5→4px, 올바른 메뉴 포커스 색상만 달라졌다.
  icon/caption 크기와 나머지 검사한 색상·line-height·글꼴은 같았다.
- 390px dark 진행·메뉴, 768px light 정상, 1440px high-contrast 진행·메뉴 PNG를
  수정 전후 직접 확인했다. tooltip의 위치와 라벨·배지·포커스 표시를 확인했다.
  실제 OS 고대비 테마 변경은 하지 않았고 브라우저의 테마 변수/forced-colors 검사를 썼다.

원본과 비교 기록은 `/private/tmp/gsc-ui-style-20261006/`의
`before-metrics.json`, `after-metrics.json`, `style-comparison.json` 및 PNG에 보관했다.

## 실제 설치·배포

- production 빌드와 VSIX packaging에 성공했다. 새 CSS 두 파일을 포함한 126개 파일이다.
- 기존 VS Code에 설치하고 사용 중인 payroll 창을 Reload Window로 적용했다.
  실제 Changes 제목·파일 목록·보기 메뉴 배치와 tooltip을 확인했다.
  Changes 143개, Stashes 43개, Worktrees 9개 표시도 유지됐다.
  Git action은 실행하지 않았고 보기 메뉴는 검증 뒤 닫았다.
- 설치 번들·shell/files/actions CSS·메뉴 JS·shared tokens가 생성 파일 및 VSIX와 일치했다.
- VSIX: `/private/tmp/gitsimplecompare-0.1.72085.vsix`.
- VSIX SHA-256: `eb4561e32e3be97ae0692346164f03d2552931d1160cdbd4f0e6f60863a36188`.
- 실행 번들 SHA-256: `bc9acd6c99b2f78e3807a3f93cc654bdb474e9afaa0519fe4b86d7e20f1a3865`.
- 실제 활성화/조회 OUTPUT은 같은 검증 디렉터리의 `runtime-current.log`에 보관했다.
- Marketplace 게시와 공개 패키지 일치는 게시 완료 후 기록한다.
