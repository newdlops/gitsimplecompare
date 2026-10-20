// 브랜치 identity와 상세 수치의 준비 단계를 분리한다. 이 모듈은 Git 조회나 별도 타이머를 만들지 않는다.
import * as vscode from "vscode";
import type { GraphReferenceIdentity } from "../git/graphReferenceIdentity";
import type { WorktreeInfo } from "../git/worktreeService";
import type { GraphFirstPageCandidate } from "./graphFirstPageRead";
import type { GraphWorkingTreeState, ToWebviewMessage } from "./graphProtocol";
import { createGraphWorktreeBranchStatus } from "./graphWorktrees";
import { logInfo } from "../ui/outputLog";

/** 상세 대기/중단/오류 안내를 소유하며, 미확인 ahead/behind/upstream은 생성하지 않는다. */
export class GraphBranchDetailsLoading {
  identity?: GraphReferenceIdentity;
  state?: GraphWorkingTreeState;

  /** 실제 ref만 게시한다. worktree가 fingerprint에 없으면 이전 worktree를 추측해서 보내지 않는다. */
  start(identity: GraphReferenceIdentity, worktrees: readonly WorktreeInfo[] | undefined,
    post: (message: ToWebviewMessage) => void): void {
    this.identity = identity;
    this.state = { loading: true, message: vscode.l10n.t("Updating branch details...") };
    logInfo("graph branch identities ready; details pending", { branches: identity.branches.length });
    post({ type: "branchIdentities", branches: identity.branches,
      message: vscode.l10n.t("Branch details are not available yet."),
      ...(worktrees === undefined ? {} : { worktrees: createGraphWorktreeBranchStatus(worktrees) }) });
  }

  /** 같은 identity의 상세가 준비되거나 새 Graph가 시작되면 안내와 최소 snapshot을 함께 비운다. */
  clear(): void { this.identity = undefined; this.state = undefined; }

  /** 화면 밖/점프 때문에 상세가 취소되면 이력은 보존하고 spinner만 멈춘다. */
  pause(): void {
    if (this.identity) this.state = { loading: false, message: vscode.l10n.t("Branch details paused.") };
  }

  /** 상세 실패 뒤에도 이미 검증한 이력은 읽을 수 있게 안내한다. 상세 오류는 기존 OUTPUT/복구 경로가 처리한다. */
  fail(error: unknown): void {
    if (this.identity) this.state = { loading: false, message: vscode.l10n.t("Branch details unavailable."),
      detail: error instanceof Error ? error.message : String(error) };
  }
}

/** 기존 상세 조회와 기존 선행 log 사이의 완료 경쟁에 필요한 효과 경계다. */
export interface ProgressiveGraphBranches<T> {
  read: Promise<T | undefined>;
  candidate?: Promise<GraphFirstPageCandidate | undefined>;
  identity?: GraphReferenceIdentity;
  current(): boolean;
  publish(candidate: GraphFirstPageCandidate, identity: GraphReferenceIdentity): boolean;
  cancel(): void;
}

/**
 * 기존 두 읽기 중 log가 먼저 검증됐을 때만 첫 화면을 게시한다. 상세가 먼저 끝나면 즉시 기존 경로로 돌아간다.
 * @param options 소유된 기존 Promise와 현재 세대/게시 효과. 새 Git 조회는 시작하지 않는다.
 * @returns 원본 상세 결과와 조기 게시 여부. 오류 발생 시 소유한 상세 읽기도 끝낸 뒤 전파한다.
 */
export async function readProgressiveGraphBranches<T>(options: ProgressiveGraphBranches<T>): Promise<{ data: T | undefined; early: boolean }> {
  const read = options.read.then(data => ({ kind: "details" as const, data }), error => ({ kind: "error" as const, error }));
  const candidate = options.identity && options.candidate?.then(value => ({ kind: "page" as const, value }));
  let result = candidate ? await Promise.race([read, candidate]) : await read;
  let early = false;
  if (result.kind === "page") {
    try {
      if (result.value && options.current() && result.value.matches(options.identity!))
        early = options.publish(result.value, options.identity!);
    } catch (error) { options.cancel(); await read; throw error; }
    result = await read;
  }
  if (result.kind === "error") throw result.error;
  return { data: result.data, early };
}
