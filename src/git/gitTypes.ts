// git 도메인에서 공통으로 쓰는 타입 정의 모듈.
// - 특정 라이브러리(vscode)에 의존하지 않는 순수 타입만 둔다. 그래야 git 레이어를
//   다른 UI/테스트 환경에서도 그대로 재사용할 수 있다.

/** 브랜치 종류: 로컬 또는 원격 */
export type BranchKind = "local" | "remote";

/**
 * 브랜치 한 개의 정보.
 * - name: git이 인식하는 짧은 참조 이름. 로컬은 "feature/x", 원격은 "origin/main" 형태.
 * - kind: 로컬/원격 구분.
 * - isCurrent: 현재 체크아웃된 브랜치인지 여부(로컬에서만 true가 될 수 있다).
 */
export interface BranchInfo {
  name: string;
  kind: BranchKind;
  isCurrent: boolean;
}

/**
 * 파일 변경 상태 코드. git diff --name-status 의 첫 글자를 그대로 따른다.
 * A=추가, M=수정, D=삭제, R=이름변경, C=복사, T=타입변경, U=충돌, X/B=기타.
 */
export type FileChangeStatus =
  | "A"
  | "M"
  | "D"
  | "R"
  | "C"
  | "T"
  | "U"
  | "X"
  | "B";

/**
 * 두 ref 사이에서 변경된 파일 한 개.
 * - path: 저장소 루트 기준 상대 경로(현재/대상 경로).
 * - oldPath: 이름변경/복사(R/C)일 때의 원본 경로.
 * - status: 변경 상태 코드.
 */
export interface FileChange {
  status: FileChangeStatus;
  path: string;
  oldPath?: string;
  /** 추가된 라인 수(numstat 기반, 없으면 undefined) */
  additions?: number;
  /** 삭제된 라인 수(numstat 기반, 없으면 undefined) */
  deletions?: number;
}

/**
 * 브랜치 비교 기준.
 * - twoDot: base..target — 두 끝점을 직접 비교.
 * - threeDot: base...target — 공통 조상(merge-base) 기준 비교(PR 리뷰 방식).
 */
export type DiffBase = "twoDot" | "threeDot";

/**
 * 한 번의 브랜치 비교를 표현하는 컨텍스트.
 * 트리뷰/명령 사이에서 "지금 무엇을 비교 중인지"를 공유하는 데 쓴다.
 */
export interface BranchComparison {
  repoRoot: string;
  base: string;
  target: string;
  diffBase: DiffBase;
  changes: FileChange[];
}
