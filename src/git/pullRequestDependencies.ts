// 선행 PR 진단의 입력·근거·검증 결과를 Git 조회와 네이티브 UI가 공유한다.
import type { PullRequestInfo } from "./pullRequestInfo";

/** 후보가 발견된 경로. 같은 파일을 수정했다는 사실은 필수 의존성의 증명이 아니다. */
export type PullRequestDependencyReason = "stack" | "history" | "declared";
/** resolves/reduces는 실제 tree 모의 적용의 결과이며 present는 현재 tree에 추가 변경이 없다는 뜻이다. */
export type PullRequestDependencyStatus = "resolves" | "reduces" | "present" | "unverified" | "unchanged";

/** 원래 HEAD를 고정해 사용자 해결 중인 index와 별도로 진단한다. */
export interface PullRequestDependencyInput {
  pr: PullRequestInfo;
  knownPullRequests?: readonly PullRequestInfo[];
  beforeHead?: string;
  branch?: string;
  signal?: AbortSignal;
}

/** 선행 후보와 이를 발견한 원본 commit을 보관한다. */
export interface PullRequestDependencyCandidate {
  pr: PullRequestInfo;
  reasons: PullRequestDependencyReason[];
  sourceCommits: string[];
  status: PullRequestDependencyStatus;
  remainingConflicts?: number;
}

/** 부분 조회·구형 Git·권한 오류를 '선행 PR 없음'과 구분하는 완료 보고서다. */
export interface PullRequestDependencyReport {
  prNumber: number;
  branch: string;
  beforeHead: string;
  conflicts: string[];
  candidates: PullRequestDependencyCandidate[];
  limitations: Array<"github" | "source" | "range" | "limit" | "simulation">;
}
