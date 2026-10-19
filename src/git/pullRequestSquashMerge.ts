// PR squash의 최종 tree를 먼저 계산해 중간 커밋 충돌과 임시 worktree의 전체 checkout을 줄인다.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, runGit, runGitWithInput, withGitConfigOverrides } from "./gitExec";
import { logInfo } from "../ui/outputLog";
import type { PullRequestRevertCommit } from "./pullRequestRevertPlan";
import { preparePullRequestSquashRange, type PullRequestSquashPlan } from "./pullRequestSquashRange";
export type { PullRequestSquashPlan } from "./pullRequestSquashRange";

/** merge-tree가 반환한 상위 index stage와 충돌 원인을 손실 없이 보관한다. */
interface MergeConflict {
  stages: Map<string, Array<{ mode: string; hash: string; stage: number }>>;
  messages: Array<{ paths: string[]; kind: string }>;
  tree: string;
}

const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/**
 * PR squash를 커밋별 재생 대신 최종 변경 한 번으로 계산하는 Git 전용 서비스다.
 * merge-tree 미지원·검증할 수 없는 PR·실제 충돌은 Git cherry-pick으로 되돌려 호환성을 유지한다.
 */
export class PullRequestSquashMerge {
  constructor(public readonly repoRoot: string) {}

  /**
   * 모든 커밋의 parent를 한 번에 읽고 정확한 PR 집합을 나타내는 최종 범위를 준비한다.
   * merge 이력도 같은 검증을 통과해야 하며, 검증할 수 없는 목록은 원래 재생 순서로 남긴다.
   * @param commits object 존재 검증을 마친 적용 순서의 전체 OID
   * @returns 검증되면 base/head/tree를 포함하는 계획, 그 외에는 원본 목록
   */
  async prepare(commits: string[]): Promise<PullRequestSquashPlan> {
    return preparePullRequestSquashRange(this.repoRoot, commits);
  }

  /**
   * 역순 원본 범위 또는 merge 결과 하나를 PR 전체의 역방향 차이로 바꾼다.
   * @param commits revert 계획이 선택한 적용 순서와 mainline
   * @returns 안전하게 집계할 수 있는 역방향 base/head. 그 외에는 undefined
   */
  async prepareRevert(commits: PullRequestRevertCommit[]): Promise<PullRequestSquashPlan | undefined> {
    if (commits.length === 1 && commits[0].mainline) {
      const commit = commits[0];
      const base = commit.hash;
      const head = (await runGit(["rev-parse", "--verify", `${base}^${commit.mainline}`], this.repoRoot)).trim();
      return OID.test(head) ? { commits: [base], base, head } : undefined;
    }
    if (commits.some(commit => commit.mainline)) return undefined;
    const source = await this.prepare(commits.map(commit => commit.hash).reverse());
    return source.base && source.head
      ? { commits: commits.map(commit => commit.hash), base: source.head, head: source.base }
      : undefined;
  }

  /**
   * 실제 index/작업 파일을 건드리지 않고 PR 최종 tree를 대상 HEAD와 병합한다.
   * 이미 삭제된 파일에 대한 순수 삭제 편집만 충족된 변경으로 처리하며 다른 충돌은 자동 해결하지 않는다.
   * @param plan 검증된 PR 범위
   * @param beforeHead 목적 브랜치의 고정된 시작 OID
   * @returns 충돌 없는 최종 tree OID, 지원하지 않거나 수동 해결이 필요하면 undefined
   */
  async computeTree(plan: PullRequestSquashPlan, beforeHead: string): Promise<string | undefined> {
    if (!plan.base || !plan.head) return undefined;
    if (beforeHead === plan.base && plan.tree) {
      this.log("PR squash reuses source tree", { commits: plan.commits.length });
      return plan.tree;
    }
    const started = Date.now();
    try {
      const tree = (await runGit([
        "merge-tree", "--write-tree", "-z", `--merge-base=${plan.base}`, beforeHead, plan.head,
      ], this.repoRoot)).replace(/\0$/, "");
      if (!OID.test(tree)) throw new Error("PR squash merge returned an invalid tree object.");
      this.log("PR squash tree computed", { commits: plan.commits.length, elapsedMs: Date.now() - started });
      return tree;
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      if (error.code === 129 && /unknown option|usage: git merge-tree/i.test(error.stderr)) {
        this.log("PR squash tree fallback", { reason: "merge-tree-unsupported" });
        return undefined;
      }
      if (error.code !== 1) throw error;
      const conflict = parseMergeConflict(error.stdout);
      const tree = conflict ? await this.removeSatisfiedDeletions(plan, conflict) : undefined;
      this.log(tree ? "PR squash deletion-only edits already satisfied" : "PR squash requires conflict resolution", {
        commits: plan.commits.length, paths: tree ? [...conflict!.stages.keys()] : undefined,
        elapsedMs: Date.now() - started,
      });
      return tree;
    }
  }

  /**
   * 계산된 tree를 index에 설치하거나, 수동 해결을 위해 원래 Git 충돌 상태를 만든다.
   * checkout=false는 파일을 만들지 않은 새 임시 worktree의 index만 채울 때 사용한다.
   * @param plan 적용할 원본 범위
   * @param cwd 실제 목적 작업트리 또는 이 작업이 소유한 임시 worktree
   * @param tree 미리 계산한 충돌 없는 tree
   * @param checkout 실제 작업 파일도 갱신할지 여부. 두 tree 병합으로 동시 편집을 보호한다.
   */
  async apply(plan: PullRequestSquashPlan, cwd: string, tree?: string, checkout = true): Promise<void> {
    if (tree) {
      await runGit(checkout ? ["read-tree", "-m", "-u", "HEAD", tree] : ["read-tree", tree], cwd);
      return;
    }
    const commits = await this.replayCommits(plan);
    await runGit(["cherry-pick", "--no-commit", ...commits], cwd);
  }

  /**
   * 범위가 검증된 PR은 최종 tree와 base를 가진 하나의 source commit으로 바꾼다.
   * @param plan 원본 범위가 검증된 계획 @returns squash patch를 재생할 고정 commit 목록
   */
  async replayCommits(plan: PullRequestSquashPlan): Promise<string[]> {
    let commits = plan.commits;
    if (plan.base && plan.tree && (plan.commits.length > 1 || plan.aggregate)) {
      const hash = (await runGitWithInput([
        "-c", "commit.gpgSign=false", "commit-tree", plan.tree, "-p", plan.base,
      ], this.repoRoot, "Git Simple Compare PR squash source\n")).trim();
      if (!OID.test(hash)) throw new Error("PR squash source returned an invalid commit object.");
      commits = [hash];
    }
    return commits;
  }

  /**
   * 모든 충돌이 '현재는 삭제됨 + PR은 같은 일반 파일의 줄 삭제만 수행'인지 검증한다.
   * 추가·binary·mode·rename·directory 충돌은 보수적으로 거부하며 실제 index에는 접근하지 않는다.
   * @param plan PR의 원래 base/head
   * @param conflict Git이 명시한 상위 stage와 충돌 종류
   * @returns 삭제 상태를 유지한 최종 tree, 하나라도 다른 충돌이면 undefined
   */
  private async removeSatisfiedDeletions(plan: PullRequestSquashPlan, conflict: MergeConflict): Promise<string | undefined> {
    const paths = [...conflict.stages.keys()];
    const messages = conflict.messages.filter(message => message.kind !== "Auto-merging");
    if (!paths.length || messages.length !== paths.length || messages.some(message =>
      message.kind !== "CONFLICT (modify/delete)" || message.paths.length !== 1 || !conflict.stages.has(message.paths[0]))) return undefined;
    if (new Set(messages.map(message => message.paths[0])).size !== paths.length) return undefined;
    for (const stages of conflict.stages.values()) {
      if (stages.length !== 2 || !stages.some(stage => stage.stage === 1) || !stages.some(stage => stage.stage === 3) ||
        stages.some(stage => !["100644", "100755"].includes(stage.mode)) || stages[0].mode !== stages[1].mode) return undefined;
    }
    if (paths.join("\0").length > 16000) return undefined;
    const diffArgs = ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const range = [plan.base!, plan.head!, "--", ...paths];
    const [output, raw] = await Promise.all([
      runGit([...diffArgs, "--numstat", "-z", ...range], this.repoRoot),
      runGit([...diffArgs, "--raw", "--no-abbrev", "-z", ...range], this.repoRoot),
    ]);
    const rawParts = raw.split("\0");
    if (rawParts.pop() !== "" || rawParts.length !== paths.length * 2) return undefined;
    const seen = new Set<string>();
    for (let index = 0; index < rawParts.length; index += 2) {
      const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) M$/.exec(rawParts[index]);
      const file = rawParts[index + 1];
      const stages = conflict.stages.get(file);
      if (!match || !stages || seen.has(file) || !stages.some(stage => stage.stage === 1 && stage.hash === match[3] && stage.mode === match[1]) ||
        !stages.some(stage => stage.stage === 3 && stage.hash === match[4] && stage.mode === match[2])) return undefined;
      seen.add(file);
    }
    const stats = output.split("\0").filter(Boolean);
    if (stats.length !== paths.length || stats.some(record => {
      const match = /^(\d+)\t(\d+)\t([\s\S]+)$/.exec(record);
      return !match || match[1] !== "0" || Number(match[2]) <= 0 || !conflict.stages.has(match[3]);
    })) return undefined;
    const directory = await mkdtemp(join(tmpdir(), "gsc-pr-squash-index-"));
    const env = withGitConfigOverrides({ GIT_INDEX_FILE: join(directory, "index") }, {
      "core.fsmonitor": "false", "core.splitIndex": "false", "core.sparseCheckout": "false",
    });
    try {
      await runGit(["read-tree", conflict.tree], this.repoRoot, { env });
      await runGitWithInput(["update-index", "--force-remove", "-z", "--stdin"], this.repoRoot, `${paths.join("\0")}\0`, { env });
      const tree = (await runGit(["write-tree"], this.repoRoot, { env })).trim();
      return OID.test(tree) ? tree : undefined;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** Output에서 단계별 비용과 fallback 원인을 확인하게 하되 원본 파일 내용은 기록하지 않는다. */
  private log(message: string, data: Record<string, unknown>): void {
    logInfo(message, { repoRoot: this.repoRoot, ...data });
  }
}

/**
 * -z 출력의 stage 구획과 길이가 명시된 message 구획을 엄격하게 읽는다.
 * Git이 알려 준 충돌 종류를 사용하며 marker 내용이나 파일명으로 충돌 종류를 추정하지 않는다.
 * @param output exit code 1인 merge-tree의 원본 stdout
 * @returns 잘린/알 수 없는 출력이면 undefined, 그 외에는 구조화된 충돌
 */
function parseMergeConflict(output: string): MergeConflict | undefined {
  const parts = output.split("\0");
  const tree = parts.shift() || "";
  if (!OID.test(tree)) return undefined;
  const stages: MergeConflict["stages"] = new Map();
  while (parts.length && parts[0]) {
    const match = /^(\d{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([123])\t([\s\S]+)$/.exec(parts.shift()!);
    if (!match) return undefined;
    const entries = stages.get(match[4]) || [];
    entries.push({ mode: match[1], hash: match[2], stage: Number(match[3]) });
    stages.set(match[4], entries);
  }
  if (parts.shift() !== "") return undefined;
  const messages: MergeConflict["messages"] = [];
  while (parts.length > 1) {
    const countText = parts.shift()!;
    if (!/^[1-9]\d*$/.test(countText)) return undefined;
    const count = Number(countText);
    if (parts.length < count + 3) return undefined;
    const paths = parts.splice(0, count);
    const kind = parts.shift()!;
    parts.shift();
    messages.push({ paths, kind });
  }
  return parts.length === 1 && parts[0] === "" ? { tree, stages, messages } : undefined;
}
