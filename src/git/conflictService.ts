// 머지/리베이스 충돌 해결에 필요한 git 작업을 모은 서비스 모듈.
// - 충돌 파일 조회, ours/theirs 수용, 해결 표시, 진행 중 작업(merge/rebase 등)의
//   상태 확인과 continue/abort 를 제공한다. git 접근은 runGit 만 사용한다(경계 분리).
import * as fs from "node:fs";
import * as path from "node:path";
import { GitError, runGit } from "./gitExec";

/** 진행 중인 git 작업 종류(충돌이 발생할 수 있는 작업들) */
export type MergeOperation = "none" | "merge" | "rebase" | "cherry-pick" | "revert";

/** 충돌 편집기에 표시할 한쪽 버전 정보 */
export interface ConflictSide {
  label: string;
  ref: string;
  commit?: string;
  content: string;
}

/** 충돌 편집기에서 한 파일을 열 때 필요한 전체 데이터 */
export interface ConflictDocument {
  rel: string;
  operation: MergeOperation;
  current: ConflictSide;
  incoming: ConflictSide;
  result: string;
  both: string;
}

/**
 * 진행 중인 git 작업 종류를 git 디렉터리의 마커 파일로 판별한다(공유 함수).
 * - ConflictService 와 RebaseService 가 함께 사용한다.
 * @param repoRoot 저장소 루트
 */
export async function detectOperation(
  repoRoot: string
): Promise<MergeOperation> {
  const gitDirRaw = (await runGit(["rev-parse", "--git-dir"], repoRoot)).trim();
  const gitDir = path.resolve(repoRoot, gitDirRaw);
  const has = (name: string): boolean => fs.existsSync(path.join(gitDir, name));

  if (has("rebase-merge") || has("rebase-apply") || await hasRef(repoRoot, "REBASE_HEAD")) {
    return "rebase";
  }
  if (has("MERGE_HEAD")) {
    return "merge";
  }
  if (has("CHERRY_PICK_HEAD")) {
    return "cherry-pick";
  }
  if (has("REVERT_HEAD")) {
    return "revert";
  }
  return "none";
}

/**
 * 진행 중 작업을 나타내는 특수 ref 가 존재하는지 확인한다.
 * - 일부 파일 이벤트 타이밍에서는 rebase 디렉터리 감지가 늦을 수 있어 REBASE_HEAD 를 보조 신호로 사용한다.
 * @param repoRoot 저장소 루트
 * @param ref 확인할 git ref 이름
 */
async function hasRef(repoRoot: string, ref: string): Promise<boolean> {
  const out = await runGit(["rev-parse", "--verify", ref], repoRoot).catch(() => "");
  return out.trim().length > 0;
}

/**
 * 한 저장소의 충돌 상태를 다루는 서비스(저장소 루트 1개에 대응).
 */
export class ConflictService {
  constructor(public readonly repoRoot: string) {}

  /**
   * 현재 충돌(unmerged) 상태인 파일들의 저장소 상대 경로 목록을 반환한다.
   * - `--diff-filter=U` 로 unmerged 항목만, `-z` 로 경로를 안전하게 파싱한다.
   */
  async listConflicts(): Promise<string[]> {
    const out = await runGit(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      this.repoRoot
    );
    return out.split("\0").filter((p) => p.length > 0);
  }

  /**
   * 한 파일을 "우리쪽(--ours)" 버전으로 확정하고 스테이징한다.
   * - merge 에서는 현재 브랜치(HEAD), rebase 에서는 베이스 쪽을 뜻함에 주의.
   * @param rel 저장소 상대 경로
   */
  async takeOurs(rel: string): Promise<void> {
    await runGit(["checkout", "--ours", "--", rel], this.repoRoot);
    await runGit(["add", "--", rel], this.repoRoot);
  }

  /**
   * 한 파일을 "상대쪽(--theirs)" 버전으로 확정하고 스테이징한다.
   * - merge 에서는 병합 대상, rebase 에서는 재적용되는 커밋 쪽을 뜻함에 주의.
   * @param rel 저장소 상대 경로
   */
  async takeTheirs(rel: string): Promise<void> {
    await runGit(["checkout", "--theirs", "--", rel], this.repoRoot);
    await runGit(["add", "--", rel], this.repoRoot);
  }

  /**
   * Current 쪽 내용을 충돌 결과로 확정한다.
   * - 편집기에서 전달한 내용이 있으면 그 내용을 결과 파일로 쓰고, 없으면 git stage 2(--ours)를 그대로 쓴다.
   * @param rel     저장소 상대 경로
   * @param content 사용자가 Current 패널에서 편집한 내용
   */
  async acceptCurrent(rel: string, content?: string): Promise<void> {
    if (content === undefined) {
      await this.takeOurs(rel);
      return;
    }
    await this.writeResolvedContent(rel, content, true);
  }

  /**
   * Incoming 쪽 내용을 충돌 결과로 확정한다.
   * - 편집기에서 전달한 내용이 있으면 그 내용을 결과 파일로 쓰고, 없으면 git stage 3(--theirs)를 그대로 쓴다.
   * @param rel     저장소 상대 경로
   * @param content 사용자가 Incoming 패널에서 편집한 내용
   */
  async acceptIncoming(rel: string, content?: string): Promise<void> {
    if (content === undefined) {
      await this.takeTheirs(rel);
      return;
    }
    await this.writeResolvedContent(rel, content, true);
  }

  /**
   * Current 와 Incoming 을 모두 보존하는 보편적인 Accept Both 결과를 만든 뒤 해결로 표시한다.
   * - conflict marker 가 있으면 각 충돌 블록에서 current 내용을 먼저, incoming 내용을 뒤에 둔다.
   * - marker 가 없으면 stage 2 전체와 stage 3 전체를 순서대로 이어 붙이는 안전한 fallback 을 사용한다.
   * @param rel 저장소 상대 경로
   */
  async acceptBoth(rel: string): Promise<void> {
    await this.writeResolvedContent(rel, await this.buildBothResult(rel), true);
  }

  /**
   * 수동 편집으로 해결한 파일을 스테이징해 "해결됨"으로 표시한다.
   * @param rel 저장소 상대 경로
   */
  async markResolved(rel: string): Promise<void> {
    await runGit(["add", "--", rel], this.repoRoot);
  }

  /**
   * 충돌 편집기에 필요한 Current/Incoming/Result 내용을 읽는다.
   * - Current/Incoming 은 git index stage 2/3 을 그대로 읽어 커밋 해시 라벨과 함께 보여준다.
   * - Result 는 실제 작업 파일이므로 사용자가 편집하고 Resolve Marked 로 스테이징할 대상이다.
   * @param rel 저장소 상대 경로
   */
  async getConflictDocument(rel: string): Promise<ConflictDocument> {
    const operation = await this.getOperation();
    const refs = await this.conflictRefs(operation);
    const [current, incoming, result, both] = await Promise.all([
      this.readStage(2, rel),
      this.readStage(3, rel),
      fs.promises.readFile(this.absPath(rel), "utf8").catch(() => ""),
      this.buildBothResult(rel),
    ]);
    return {
      rel,
      operation,
      current: {
        label: "Current",
        ref: refs.current.ref,
        commit: refs.current.commit,
        content: current,
      },
      incoming: {
        label: "Incoming",
        ref: refs.incoming.ref,
        commit: refs.incoming.commit,
        content: incoming,
      },
      result,
      both,
    };
  }

  /**
   * 사용자가 편집한 Result 내용을 작업 파일에 저장하고 필요하면 해결됨으로 표시한다.
   * @param rel          저장소 상대 경로
   * @param content      저장할 result 내용
   * @param markResolved true 면 저장 직후 git add 로 해결 처리한다
   */
  async writeResolvedContent(
    rel: string,
    content: string,
    markResolved = false
  ): Promise<void> {
    await fs.promises.writeFile(this.absPath(rel), content, "utf8");
    if (markResolved) {
      await this.markResolved(rel);
    }
  }

  /**
   * 진행 중인 git 작업 종류를 판별한다(공유 함수 detectOperation 에 위임).
   */
  getOperation(): Promise<MergeOperation> {
    return detectOperation(this.repoRoot);
  }

  /**
   * 진행 중인 작업을 이어서 진행한다(`git <op> --continue`).
   * - 커밋 메시지 편집기를 띄우지 않도록 GIT_EDITOR=true 로 우회한다.
   * @param op 진행 중인 작업 종류
   */
  async continueOperation(op: MergeOperation): Promise<void> {
    if (op === "none") {
      return;
    }
    const env = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
    try {
      await runGit([op, "--continue"], this.repoRoot, env);
    } catch (err) {
      if (op === "rebase" && await this.canSkipEmptyRebaseStep(err)) {
        await runGit(["rebase", "--skip"], this.repoRoot, env);
        return;
      }
      throw err;
    }
  }

  /**
   * 진행 중인 작업을 취소한다(`git <op> --abort`).
   * @param op 진행 중인 작업 종류
   */
  async abortOperation(op: MergeOperation): Promise<void> {
    if (op === "none") {
      return;
    }
    await runGit([op, "--abort"], this.repoRoot);
  }

  /**
   * 저장소 상대 경로를 절대 경로로 변환한다(파일 URI 생성용).
   * @param rel 저장소 상대 경로
   */
  absPath(rel: string): string {
    return path.join(this.repoRoot, rel);
  }

  /**
   * git index 의 충돌 stage 내용을 읽는다.
   * @param stage 2 는 ours/current, 3 은 theirs/incoming
   * @param rel   저장소 상대 경로
   */
  private async readStage(stage: 2 | 3, rel: string): Promise<string> {
    return runGit(["show", `:${stage}:${rel}`], this.repoRoot).catch(() => "");
  }

  /**
   * 진행 중 작업에 맞춰 Current/Incoming 의 ref 와 커밋 해시를 계산한다.
   * @param operation 현재 git 작업 종류
   */
  private async conflictRefs(operation: MergeOperation): Promise<{
    current: { ref: string; commit?: string };
    incoming: { ref: string; commit?: string };
  }> {
    const incomingRef =
      operation === "merge"
        ? "MERGE_HEAD"
        : operation === "rebase"
          ? "REBASE_HEAD"
          : operation === "cherry-pick"
            ? "CHERRY_PICK_HEAD"
            : operation === "revert"
              ? "REVERT_HEAD"
              : "theirs";
    const [currentCommit, incomingCommit] = await Promise.all([
      this.resolveCommit("HEAD"),
      this.resolveCommit(incomingRef),
    ]);
    return {
      current: { ref: "HEAD", commit: currentCommit },
      incoming: { ref: incomingRef, commit: incomingCommit },
    };
  }

  /**
   * ref 를 커밋 해시로 해석한다. ref 가 없으면 undefined 를 반환해 UI 가 ref 이름만 보여주게 한다.
   * @param ref git ref 이름
   */
  private async resolveCommit(ref: string): Promise<string | undefined> {
    const out = await runGit(["rev-parse", "--verify", ref], this.repoRoot).catch(
      () => ""
    );
    return out.split(/\r?\n/).find(Boolean);
  }

  /**
   * Accept Both 결과를 만든다.
   * @param rel 저장소 상대 경로
   */
  private async buildBothResult(rel: string): Promise<string> {
    const raw = await fs.promises.readFile(this.absPath(rel), "utf8").catch(
      () => ""
    );
    const fromMarkers = acceptBothFromMarkers(raw);
    if (fromMarkers.changed) {
      return fromMarkers.content;
    }
    const [current, incoming] = await Promise.all([
      this.readStage(2, rel),
      this.readStage(3, rel),
    ]);
    return `${current}${needsLineBreak(current, incoming) ? "\n" : ""}${incoming}`;
  }

  /**
   * rebase --continue 가 "적용할 변경이 없음"으로 실패한 상황인지 판단한다.
   * - 충돌 파일이 더 남아 있지 않고 staged/unstaged diff 가 모두 비어 있을 때만 skip fallback 을 허용한다.
   * @param err rebase --continue 실패 오류
   */
  private async canSkipEmptyRebaseStep(err: unknown): Promise<boolean> {
    if (!isEmptyRebaseError(err)) {
      return false;
    }
    const [conflicts, hasStaged, hasUnstaged] = await Promise.all([
      this.listConflicts().catch(() => ["unknown"]),
      hasDiff(this.repoRoot, ["diff", "--cached", "--quiet"]),
      hasDiff(this.repoRoot, ["diff", "--quiet"]),
    ]);
    return conflicts.length === 0 && !hasStaged && !hasUnstaged;
  }
}

/**
 * conflict marker 가 들어 있는 작업 파일에서 "Accept Both" 결과를 만든다.
 * @param raw conflict marker 를 포함한 파일 내용
 */
function acceptBothFromMarkers(raw: string): { changed: boolean; content: string } {
  const lines = raw.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const out: string[] = [];
  let mode: "normal" | "current" | "base" | "incoming" = "normal";
  let changed = false;
  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      mode = "current";
      changed = true;
      continue;
    }
    if (mode === "current" && line.startsWith("|||||||")) {
      mode = "base";
      continue;
    }
    if ((mode === "current" || mode === "base") && line.startsWith("=======")) {
      mode = "incoming";
      continue;
    }
    if (mode === "incoming" && line.startsWith(">>>>>>>")) {
      mode = "normal";
      continue;
    }
    if (mode === "base") {
      continue;
    }
    out.push(line);
  }
  return { changed, content: changed ? out.join("") : raw };
}

/**
 * 두 문자열을 이어 붙일 때 줄바꿈을 하나 보강해야 하는지 판단한다.
 * @param left  앞쪽 문자열
 * @param right 뒤쪽 문자열
 */
function needsLineBreak(left: string, right: string): boolean {
  return Boolean(left && right && !left.endsWith("\n") && !left.endsWith("\r"));
}

/**
 * rebase continue 실패가 빈 패치/이미 적용된 변경을 의미하는지 확인한다.
 * @param err git 실행 오류
 */
function isEmptyRebaseError(err: unknown): boolean {
  const text =
    err instanceof GitError
      ? `${err.message}\n${err.stderr}`
      : err instanceof Error
        ? err.message
        : String(err);
  return /No changes|did you forget to use 'git add'|patch contents already upstream|nothing to commit|empty/i.test(
    text
  );
}

/**
 * git diff --quiet 계열 명령으로 diff 존재 여부를 확인한다.
 * @param repoRoot git 저장소 루트
 * @param args     diff --quiet 인자
 */
async function hasDiff(repoRoot: string, args: string[]): Promise<boolean> {
  try {
    await runGit(args, repoRoot, { retryOnLock: false });
    return false;
  } catch {
    return true;
  }
}
