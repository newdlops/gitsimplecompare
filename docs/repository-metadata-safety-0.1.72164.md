# 상태 조회 중 저장소 연결 교체·원복 보호

`0.1.72164`는 Git이 해석한 index 경로를 재사용할 때의 안전 검증을 보강한다.
사용자 화면의 배치나 컨트롤은 바꾸지 않는다. PR 이동의 기존 pagination 수정도 유지한다.

기존 검증은 `.git` gitfile과 `commondir`의 내용, 실제 디렉터리의 inode를 비교했다.
실제 linked worktree에서 연결을 다른 저장소로 잠시 변경하고 Native status가 끝나기
전에 같은 파일에 원래 내용을 다시 쓰면, 문자열과 inode가 같아 잘못된 HEAD를
정상 결과로 반환했다. Native index 경로 해석 중에도 같은 경계가 있었다.

이제 연결 파일의 mtime·ctime·크기와 읽기 전후 상태를 확인한다. 디렉터리의 변경
시각은 한 번의 조회 전후에만 비교한다. 정상 commit 이후의 다음 조회는 새 경계를
사용하므로 검증된 경로를 계속 재사용한다. 일반 저장소에서 gitDir과 commonDir이
같으면 디렉터리 stat을 한 번만 수행한다. 캐시 항목, 타이머, worker는 추가하지 않는다.

변경이 검출되면 기존 OUTPUT의 `private status index invalidated` 또는
`private status index path discarded` 로그를 남기고 기존 재시도·Native fallback을
사용한다. 취소와 Git 수명 오류는 기존대로 전파한다.

## 검증

- 실제 Native Git과 linked worktree로 gitfile·commondir의 교체·원복, 조회 중 실제
  다른 HEAD 응답, 디렉터리의 교체·원복을 재현했다. 수정 전 새 검사 5개가 모두
  실패했고, 수정 후 원래 저장소의 HEAD·branch·staged·unstaged·미추적 파일과 일치했다.
- 원본 index·HEAD·config와 작업 파일의 바이트·inode·mtime·ctime을 비교했다.
  경로 재사용 검사는 정상 commit·stage·파일 수정 뒤에도 Native 경로 해석이 한 번만
  실행되는지 확인한다. 연결이 실제로 바뀐 경우에는 새 경로를 해석한다.
- 직접 관련 검사: `repositoryMetadataAba`, `repositoryIndexPath`,
  `privateStatusIndexPath`. 연관 검사: private status의 cold/metadata/warm 세션,
  Git private 상태 경로, Graph history identity, replay worktree 정책·경로,
  fsmonitor 환경·쓰기 경로, PR 이동 pagination·잘못된 ref 복구.
- Homebrew Git 2.53에서 직접 관련 15개와 연관 55개를 통과했다. Apple Git 2.50.1에서도
  직접 관련 15개를 통과했다. TypeScript 검사도 통과했다.
- headless Chromium에서 `prRowJump.spec.ts`와 `prGraphRefresh.spec.ts`의 38개
  검사를 통과했다. 390/768/1440px의 검색·키보드 이동·대기 중 갱신·늦은 응답을
  포함한다. 이번 변경의 새 시각 디자인 검증은 아니며 사용자 창의 포커스는 바꾸지 않았다.

원시 로그는 `/private/tmp/gsc-metadata-aba-{red,green,related,apple}.log`에 있다.
브라우저 기록은 `/private/tmp/gsc-metadata-pr-webview.log`에 있다.
실제 사용자 VS Code 세션의 실행 버전이나 같은 증상까지 확인한 것은 아니다.
이 변경 자체의 전체 Graph 지연·CPU·메모리 감소를 주장하지 않는다.
