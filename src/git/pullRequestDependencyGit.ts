// 사용자 작업트리·index·branch를 바꾸지 않고 선행 후보의 tree 적용 효과만 계산한다.
import { GitError, runGit, runGitWithInput, type RunGitOptions } from "./gitExec";
import { readCommitMetadata } from "./commitMetadata";
import { pullRequestCommitHashes } from "./pullRequestOperationFormat";
import { preparePullRequestSquashRange, type PullRequestSquashPlan } from "./pullRequestSquashRange";
import type { PullRequestInfo } from "./pullRequestInfo";

/** 충돌 경로와 정상 tree를 구분한다. undefined는 지원하지 않거나 출력 검증에 실패한 경우다. */
export interface DependencyMergeTree { tree?: string; conflicts: string[] }
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** 한 번의 진단에서만 object 존재 조회를 재사용하는 Git 전용 계산기다. */
export class PullRequestDependencyGit {
  private readonly availableObjects = new Set<string>();
  constructor(private readonly root: string, private readonly options: RunGitOptions = {}) {}

  /**
   * 로컬에 전체 원본이 있으면 검증된 PR 범위를 만든다. 분석을 위해 다른 PR을 fetch하지 않는다.
   * @param pr 동일 GitHub 응답에서 읽은 전체 commit 목록 @param merged true면 실제 merge 결과도 허용한다.
   * @returns 일부만 준비된 PR이나 범위가 모호한 PR은 undefined
   */
  async plan(pr: PullRequestInfo, merged = false): Promise<PullRequestSquashPlan | undefined> {
    const commits = pullRequestCommitHashes(pr);
    if (commits.some(hash => !OID.test(hash))) return undefined;
    const wanted = [...commits, ...(pr.mergeHash && OID.test(pr.mergeHash) ? [pr.mergeHash] : [])];
    await this.readAvailable(wanted);
    if (commits.length && pr.commitHashesComplete !== false && commits.every(hash => this.availableObjects.has(hash))) {
      const plan = await preparePullRequestSquashRange(this.root, commits, this.options);
      if (plan.base && plan.head) return plan;
    }
    if (merged && pr.state === "MERGED" && pr.mergeHash && this.availableObjects.has(pr.mergeHash)) {
      const node = (await readCommitMetadata(this.root, [pr.mergeHash], this.options)).get(pr.mergeHash)!;
      // rebase merge의 단일-parent 마지막 commit을 PR 전체로 잘못 다루지 않는다.
      if (node.parents.length > 1 || (commits.length === 1 && pr.commitHashesComplete !== false && node.parents.length === 1)) {
        return { commits: [pr.mergeHash], base: node.parents[0], head: pr.mergeHash, tree: node.tree };
      }
    }
    return undefined;
  }

  /**
   * source 부모 이력 중 대상 HEAD에 없는, 충돌 경로를 바꾼 최근 commit만 최대 12개 읽는다.
   * @param plan PR 자체 commit을 제외하는 검증된 base @param target 원래 적용 대상 @param paths 원래 충돌 경로
   */
  async history(plan: PullRequestSquashPlan, target: string, paths: string[]): Promise<string[]> {
    if (!plan.base || !paths.length) return [];
    const output = await runGit(["--literal-pathspecs", "log", "--format=%H", "--max-count=12",
      plan.base, `^${target}`, "--", ...paths.slice(0, 8)], this.root, this.options);
    return [...new Set(output.trim().split(/\s+/).filter(hash => OID.test(hash)))];
  }

  /**
   * 명시적인 공통 base로 최종 변경을 모의 적용한다. index와 checkout은 사용하지 않는다.
   * @param plan 변경의 고정 base/head @param target 변경을 올릴 고정 commit
   * @returns clean tree 또는 실제 충돌 경로. 구형 Git이면 undefined
   */
  async merge(plan: PullRequestSquashPlan, target: string): Promise<DependencyMergeTree | undefined> {
    if (!plan.base || !plan.head) return undefined;
    if (plan.base === target && plan.tree) return { tree: plan.tree, conflicts: [] };
    try {
      const tree = (await runGit(["merge-tree", "--write-tree", "-z", `--merge-base=${plan.base}`, target, plan.head],
        this.root, this.options)).replace(/\0$/, "");
      if (!OID.test(tree)) return undefined;
      return { tree, conflicts: [] };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      if (error.code === 129) return undefined;
      if (error.code !== 1) throw error;
      const parts = error.stdout.split("\0");
      if (!OID.test(parts.shift() || "")) return undefined;
      const paths = new Set<string>();
      while (parts[0]) {
        const entry = /^\d{6} [a-f0-9]{40}(?:[a-f0-9]{24})? [123]\t([\s\S]+)$/.exec(parts.shift()!);
        if (!entry) return undefined;
        paths.add(entry[1]);
      }
      return paths.size ? { conflicts: [...paths] } : undefined;
    }
  }

  /** 대상 commit의 tree를 검증한 전체 OID로 읽는다. */
  async tree(head: string): Promise<string> {
    const tree = (await runGit(["rev-parse", "--verify", `${head}^{tree}`], this.root, this.options)).trim();
    if (!OID.test(tree)) throw new Error("Cannot verify the prerequisite target tree.");
    return tree;
  }

  /**
   * tree 결과를 다음 모의 병합의 부모로 쓸 임시 commit object로 만든다. ref·훅·서명은 사용하지 않는다.
   * @param tree 후보를 올린 clean tree @param parent 원래 대상 HEAD @returns 어떤 branch에도 연결하지 않은 OID
   */
  async simulationCommit(tree: string, parent: string): Promise<string> {
    const hash = (await runGitWithInput(["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", parent],
      this.root, "Git Simple Compare prerequisite simulation\n", {
        ...this.options, env: { ...this.options.env,
          GIT_AUTHOR_NAME: "Git Simple Compare", GIT_AUTHOR_EMAIL: "simulation@example.invalid",
          GIT_COMMITTER_NAME: "Git Simple Compare", GIT_COMMITTER_EMAIL: "simulation@example.invalid" },
      })).trim();
    if (!OID.test(hash)) throw new Error("Cannot verify the prerequisite simulation commit.");
    return hash;
  }

  /**
   * 존재 검사를 한 cat-file 호출로 묶고 성공한 불변 OID만 이번 계산 안에서 재사용한다.
   * @param hashes 검사할 원본/merge commit OID 목록. 실제 ref 문자열이나 사용자 경로는 받지 않는다.
   */
  private async readAvailable(hashes: string[]): Promise<void> {
    const pending = [...new Set(hashes)].filter(hash => !this.availableObjects.has(hash));
    if (!pending.length) return;
    const output = await runGitWithInput(["cat-file", "--batch-check=%(objectname) %(objecttype)"], this.root,
      `${pending.join("\n")}\n`, this.options);
    for (const line of output.trimEnd().split("\n")) {
      const [hash, type] = line.split(" ");
      if (type === "commit" && pending.includes(hash)) this.availableObjects.add(hash);
    }
  }
}
