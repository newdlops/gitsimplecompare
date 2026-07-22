// 로컬 PR stack을 dependency 순서로 push하고 GitHub PR을 생성·동기화하는 서비스 모듈.
// - 원격 branch가 재작성됐을 때만 실제 원격 OID를 조건으로 `--force-with-lease`를 사용한다.
// - PR 본문의 사용자 영역은 보존하고 marker 사이 stack 순서만 갱신한다.
import { runGh } from "./ghCli";
import { runGit } from "./gitExec";
import { PullRequestStackMetadataService } from "./pullRequestStackMetadata";
import type { StackLocalBranch } from "./pullRequestStackModel";
import { PullRequestStackService } from "./pullRequestStackService";

const STACK_BODY_START = "<!-- git-simple-compare-stack:start -->";
const STACK_BODY_END = "<!-- git-simple-compare-stack:end -->";

/** Submit/Sync 한 layer의 push 및 PR 결과 */
export interface PullRequestStackSubmitLayerResult {
  branch: string;
  parentBranch: string;
  remoteBranch: string;
  push: "unchanged" | "created" | "fast-forward" | "force-with-lease";
  pullRequestNumber: number;
  pullRequestUrl: string;
  createdPullRequest: boolean;
  changedBase: boolean;
}

/** stack 전체 Submit/Sync 결과 */
export interface PullRequestStackSubmitResult {
  remote: string;
  layers: PullRequestStackSubmitLayerResult[];
}

/** Submit/Sync 사용자 선택과 Advance 후속 처리가 전달하는 옵션 */
export interface PullRequestStackSubmitOptions {
  /** 선택 branch가 속한 연결 stack 전체를 submit한다. */
  branch: string;
  /** push 대상 Git remote */
  remote: string;
  /** 새로 만드는 PR을 draft로 시작할지 여부 */
  draft: boolean;
}

interface GitHubStackPullRequest {
  number: number;
  title: string;
  url: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  state: string;
}

interface SubmitLayer {
  branch: StackLocalBranch;
  parentBranch: string;
  depth: number;
  remoteBranch: string;
}

/** PR stack push/PR 생성/base/body 동기화를 수행하는 서비스 */
export class PullRequestStackSubmitService {
  private readonly metadata: PullRequestStackMetadataService;

  constructor(public readonly repoRoot: string) {
    this.metadata = new PullRequestStackMetadataService(repoRoot);
  }

  /**
   * 선택 branch가 속한 stack을 root→leaf 순서로 push하고 PR을 생성 또는 갱신한다.
   * @param options stack branch, remote, 새 PR draft 여부
   * @returns layer별 push 방식과 PR 변경 결과
   */
  async submit(
    options: PullRequestStackSubmitOptions
  ): Promise<PullRequestStackSubmitResult> {
    const remote = await this.assertRemote(options.remote);
    const branches = await this.metadata.listBranches();
    const stack = selectConnectedStack(branches, options.branch);
    if (!stack.length) {
      throw new Error(`Branch '${options.branch}' is not part of a local pull request stack.`);
    }
    await this.assertRestacked(stack);
    const openSnapshot = await new PullRequestStackService(this.repoRoot)
      .getSnapshot()
      .catch(() => undefined);
    const existingByHead = new Map(
      (openSnapshot?.pullRequests || []).map((pr) => [pr.headRefName, pr])
    );
    const layers: SubmitLayer[] = stack.map(({ branch, depth }) => ({
      branch,
      parentBranch: branch.parentBranch!,
      depth,
      remoteBranch: remoteBranchFor(branch, remote),
    }));
    const results: PullRequestStackSubmitLayerResult[] = [];
    const pullRequests = new Map<string, GitHubStackPullRequest>();

    for (const layer of layers) {
      const push = await this.pushLayer(layer.branch.name, remote, layer.remoteBranch);
      const existing = existingByHead.get(layer.remoteBranch)
        || existingByHead.get(layer.branch.name);
      let createdPullRequest = false;
      let changedBase = false;
      if (!existing) {
        const title = await this.pullRequestTitle(layer.branch.name);
        await new PullRequestStackService(this.repoRoot).createPullRequest({
          headBranch: layer.remoteBranch,
          baseBranch: layer.parentBranch,
          title,
          body: stackBodySection(layers, layer.remoteBranch, new Map()),
          draft: options.draft,
        });
        createdPullRequest = true;
      } else if (existing.baseRefName !== layer.parentBranch) {
        await new PullRequestStackService(this.repoRoot)
          .changeBase(existing.number, layer.parentBranch);
        changedBase = true;
      }
      const pr = await this.pullRequestForHead(layer.remoteBranch);
      pullRequests.set(layer.remoteBranch, pr);
      results.push({
        branch: layer.branch.name,
        parentBranch: layer.parentBranch,
        remoteBranch: layer.remoteBranch,
        push,
        pullRequestNumber: pr.number,
        pullRequestUrl: pr.url,
        createdPullRequest,
        changedBase,
      });
    }

    await this.updateStackBodies(layers, pullRequests);
    return { remote, layers: results };
  }

  /**
   * 원격 ref의 실제 OID를 읽고 fast-forward 또는 안전한 force-with-lease push를 선택한다.
   * @param localBranch push source local branch
   * @param remote Git remote 이름
   * @param remoteBranch 원격 destination branch
   * @returns 실행한 push 안전 모드
   */
  private async pushLayer(
    localBranch: string,
    remote: string,
    remoteBranch: string
  ): Promise<PullRequestStackSubmitLayerResult["push"]> {
    const localHead = await this.resolveCommit(`refs/heads/${localBranch}`);
    const remoteHead = await this.remoteHead(remote, remoteBranch);
    if (remoteHead === localHead) {
      return "unchanged";
    }
    const refspec = `${localBranch}:refs/heads/${remoteBranch}`;
    if (!remoteHead) {
      await runGit(["push", "-u", remote, refspec], this.repoRoot);
      return "created";
    }
    if (await this.isAncestor(remoteHead, localHead)) {
      await runGit(["push", "-u", remote, refspec], this.repoRoot);
      return "fast-forward";
    }
    await runGit([
      "push",
      "-u",
      `--force-with-lease=refs/heads/${remoteBranch}:${remoteHead}`,
      remote,
      refspec,
    ], this.repoRoot);
    return "force-with-lease";
  }

  /**
   * stack의 모든 PR 본문 marker 영역을 최신 번호/순서로 교체한다.
   * @param layers root→leaf 순서와 depth가 계산된 local layer
   * @param pullRequests remote branch별 생성/조회된 PR
   */
  private async updateStackBodies(
    layers: SubmitLayer[],
    pullRequests: Map<string, GitHubStackPullRequest>
  ): Promise<void> {
    const numbers = new Map(
      [...pullRequests].map(([branch, pr]) => [branch, pr.number])
    );
    for (const layer of layers) {
      const pr = pullRequests.get(layer.remoteBranch);
      if (!pr) continue;
      const section = stackBodySection(layers, layer.remoteBranch, numbers);
      const body = replacePullRequestStackBody(pr.body, section);
      if (body !== pr.body) {
        await runGh(
          ["pr", "edit", String(pr.number), "--body", body],
          this.repoRoot
        );
      }
    }
  }

  /** GitHub에서 head branch에 대응하는 열린 PR과 현재 본문을 읽는다. */
  private async pullRequestForHead(headBranch: string): Promise<GitHubStackPullRequest> {
    const output = await runGh([
      "pr",
      "view",
      headBranch,
      "--json",
      "number,title,url,body,headRefName,baseRefName,state",
    ], this.repoRoot);
    const value = JSON.parse(output) as Partial<GitHubStackPullRequest>;
    if (!value.number || !value.url) {
      throw new Error(`Pull request for '${headBranch}' could not be loaded after submit.`);
    }
    return {
      number: Number(value.number),
      title: value.title || headBranch,
      url: value.url,
      body: value.body || "",
      headRefName: value.headRefName || headBranch,
      baseRefName: value.baseRefName || "",
      state: value.state || "OPEN",
    };
  }

  /** stack layer branch의 마지막 commit 제목을 새 PR 기본 제목으로 사용한다. */
  private async pullRequestTitle(branch: string): Promise<string> {
    const title = (await runGit(
      ["show", "-s", "--format=%s", `refs/heads/${branch}`],
      this.repoRoot
    )).trim();
    return title || branch;
  }

  /** 모든 layer의 parent tip이 실제 child 조상인지 확인해 restack 누락 push를 막는다. */
  private async assertRestacked(
    stack: Array<{ branch: StackLocalBranch; depth: number }>
  ): Promise<void> {
    for (const { branch } of stack) {
      const parentHead = await this.metadata.resolveBranchHead(branch.parentBranch!);
      if (!await this.isAncestor(parentHead, branch.hash)) {
        throw new Error(
          `Stack layer '${branch.name}' is not based on current '${branch.parentBranch}'. Run Restack first.`
        );
      }
    }
  }

  /** 요청 remote가 저장소에 등록돼 있는지 확인한다. */
  private async assertRemote(remote: string): Promise<string> {
    const name = remote.trim();
    const remotes = (await runGit(["remote"], this.repoRoot))
      .split(/\r?\n/).filter(Boolean);
    if (!name || !remotes.includes(name)) {
      throw new Error(`Git remote '${name || remote}' is not available.`);
    }
    return name;
  }

  /** ls-remote로 push 직전 실제 원격 branch OID를 읽는다. */
  private async remoteHead(remote: string, branch: string): Promise<string | undefined> {
    const output = await runGit(
      ["ls-remote", "--heads", remote, `refs/heads/${branch}`],
      this.repoRoot
    );
    const advertised = output.trim().split(/\s+/)[0] || undefined;
    if (!advertised) {
      return undefined;
    }
    // ls-remote의 OID가 아직 로컬 object DB에 없으면 ancestor 판정이 모두 실패한다.
    // 실제 원격 ref를 FETCH_HEAD로 받아 현재 OID와 object를 한 번에 고정한다.
    await runGit(
      ["fetch", "--no-tags", remote, `refs/heads/${branch}`],
      this.repoRoot
    );
    return this.resolveCommit("FETCH_HEAD");
  }

  /** commit-ish를 전체 OID로 정규화한다. */
  private async resolveCommit(ref: string): Promise<string> {
    return (await runGit(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      this.repoRoot
    )).trim();
  }

  /** ancestor가 target history에 포함되는지 exit status로 확인한다. */
  private async isAncestor(ancestor: string, target: string): Promise<boolean> {
    return runGit(["merge-base", "--is-ancestor", ancestor, target], this.repoRoot)
      .then(() => true, () => false);
  }
}

/** 선택 branch의 root를 찾은 뒤 parent 우선 DFS로 연결 stack 전체를 반환한다. */
function selectConnectedStack(
  branches: StackLocalBranch[],
  selectedBranch: string
): Array<{ branch: StackLocalBranch; depth: number }> {
  const byName = new Map(branches.map((branch) => [branch.name, branch]));
  let root = byName.get(selectedBranch);
  if (!root?.parentBranch) return [];
  const seenAncestors = new Set<string>();
  while (root.parentBranch && byName.get(root.parentBranch)?.parentBranch) {
    if (seenAncestors.has(root.name)) return [];
    seenAncestors.add(root.name);
    root = byName.get(root.parentBranch)!;
  }
  const children = new Map<string, StackLocalBranch[]>();
  for (const branch of branches.filter((item) => item.parentBranch)) {
    const list = children.get(branch.parentBranch!) || [];
    list.push(branch);
    list.sort((left, right) => left.name.localeCompare(right.name));
    children.set(branch.parentBranch!, list);
  }
  const output: Array<{ branch: StackLocalBranch; depth: number }> = [];
  const visit = (branch: StackLocalBranch, depth: number): void => {
    output.push({ branch, depth });
    for (const child of children.get(branch.name) || []) visit(child, depth + 1);
  };
  visit(root, 0);
  return output;
}

/** branch upstream이 선택 remote를 쓰면 원격 branch 이름을 보존하고 아니면 local 이름을 쓴다. */
function remoteBranchFor(branch: StackLocalBranch, remote: string): string {
  const prefix = `${remote}/`;
  return branch.upstream?.startsWith(prefix)
    ? branch.upstream.slice(prefix.length)
    : branch.name;
}

/** 모든 PR 본문에 삽입할 현재 stack 번호/branch 목록 marker section을 만든다. */
function stackBodySection(
  layers: SubmitLayer[],
  currentRemoteBranch: string,
  numbers: Map<string, number>
): string {
  const rows = layers.map((layer) => {
    const number = numbers.get(layer.remoteBranch);
    const label = number ? `#${number}` : `\`${layer.remoteBranch}\``;
    const current = layer.remoteBranch === currentRemoteBranch;
    const text = current ? `**${label}** ← current` : label;
    return `${"  ".repeat(layer.depth)}- ${text} — \`${layer.parentBranch} ← ${layer.remoteBranch}\``;
  });
  return [
    STACK_BODY_START,
    "### Pull request stack",
    ...rows,
    STACK_BODY_END,
  ].join("\n");
}

/**
 * 기존 PR 본문에서 Git Simple Compare marker만 교체하고 사용자 작성 영역은 그대로 보존한다.
 * @param body GitHub에 저장된 현재 PR 본문
 * @param section 새 marker 시작/끝을 포함한 stack section
 * @returns marker가 교체 또는 본문 끝에 추가된 새 body
 */
export function replacePullRequestStackBody(body: string, section: string): string {
  const start = body.indexOf(STACK_BODY_START);
  const end = body.indexOf(STACK_BODY_END);
  if (start >= 0 && end >= start) {
    return `${body.slice(0, start)}${section}${body.slice(end + STACK_BODY_END.length)}`;
  }
  const trimmed = body.trimEnd();
  return trimmed ? `${trimmed}\n\n${section}\n` : `${section}\n`;
}
