# Git Simple Compare

git 브랜치와 파일을 간단하게 비교하고, **비교하면서 바로 편집**할 수 있는 VS Code 확장입니다.

## 기능

1. **브랜치끼리 비교** — 로컬/원격 브랜치 두 개를 골라 변경된 파일 목록을 트리뷰로 확인하고, 각 파일의 diff를 엽니다.
2. **파일과 브랜치 비교** — 탐색기에서 파일을 우클릭해 특정 브랜치 버전과 비교합니다.
3. **현재 파일과 브랜치 비교** — 열려 있는 파일을 특정 브랜치 버전과 비교합니다.
4. **비교하면서 편집** — 파일 vs 브랜치 비교에서는 작업트리(현재 파일) 쪽이 편집 가능합니다. 고치고 저장하면 그대로 반영됩니다.

## 사용 방법

- 명령 팔레트(`Cmd/Ctrl+Shift+P`) → `Git Simple Compare: 브랜치끼리 비교`
- 탐색기에서 파일 우클릭 → `이 파일을 브랜치와 비교`
- 에디터 우측 상단 비교 아이콘 → `현재 파일을 브랜치와 비교`
- 좌측 액티비티 바의 **Git Simple Compare** 아이콘에서 변경 파일 목록 확인

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `gitSimpleCompare.diffBase` | `twoDot` | 브랜치 비교 기준 (`twoDot`=직접 비교, `threeDot`=공통 조상 기준) |
| `gitSimpleCompare.includeRemoteBranches` | `true` | 브랜치 선택 목록에 원격 브랜치 포함 여부 |

## 개발

```bash
npm install
npm run compile     # 번들
npm run watch       # 변경 감지 빌드
npm run check-types # 타입 검사
```

VS Code에서 `F5`를 누르면 Extension Development Host가 실행됩니다.

