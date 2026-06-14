// 인터랙티브 rebase 를 비대화식으로 수행하는 서비스 모듈.
// - git 의 시퀀스 에디터/커밋 에디터를 우리 헬퍼 스크립트로 대체해, 사용자가 UI 에서
//   짠 계획(todo)과 메시지를 주입한다. 사용자 입력은 모두 호출부에서 받아 전달받는다.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGit } from "./gitExec";
import { detectOperation } from "./conflictService";

/** rebase 대상 커밋 한 건(계획 UI 표시용) */
export interface RebaseCommit {
  hash: string;
  subject: string;
  body: string;
}

/** todo 한 줄의 동작 */
export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

/** 사용자가 짠 계획 한 항목 */
export interface RebaseItem {
  hash: string;
  action: RebaseAction;
  /** reword/squash 시 사용할 메시지(빈 값이면 git 기본 메시지 유지) */
  message?: string;
}

/** rebase 실행 결과 */
export interface RebaseResult {
  status: "completed" | "conflicts" | "failed" | "noop";
  message?: string;
}

/** 현재 브랜치에서 그래프 rebase UI 가 편집할 계획 범위 */
export interface RebasePlanInfo {
  branch: string;
  upstream?: string;
  /** rebase 기준 커밋. root=true 일 때는 빈 문자열이다. */
  base: string;
  /** true 면 `git rebase -i --root` 로 현재 브랜치의 루트부터 편집한다. */
  root?: boolean;
  /** --onto 대상 커밋. 없으면 git rebase -i base 형태로 실행한다. */
  onto?: string;
  baseReason: "upstream" | "selected";
  commits: RebaseCommit[];
}

/**
 * 한 저장소의 인터랙티브 rebase 를 다루는 서비스.
 */
export class RebaseService {
  constructor(public readonly repoRoot: string) {}

  /**
   * 작업트리가 깨끗한지(추적 파일에 미커밋 변경이 없는지) 확인한다.
   * - 현재 그래프 기반 rebase 는 --autostash 로 미커밋 변경을 보존하므로 필수 검사는 아니다.
   * - 기존 명령/테스트가 상태를 표시해야 할 때 재사용할 수 있도록 유지한다(추적되지 않은 파일은 무시).
   */
  async isClean(): Promise<boolean> {
    const out = await runGit(
      ["status", "--porcelain", "--untracked-files=no"],
      this.repoRoot
    );
    return out.trim().length === 0;
  }

  /**
   * rebase 대상 커밋들을 오래된 것부터(rebase todo 순서로) 반환한다.
   * @param base 편집 대상의 직전 커밋(이 커밋은 포함되지 않음)
   * @param root true 면 HEAD 의 전체 조상 커밋을 root 부터 반환한다.
   */
  async getCommits(base: string, root = false): Promise<RebaseCommit[]> {
    const out = await runGit(
      [
        "log",
        "--reverse",
        "--pretty=format:%H\x1f%s\x1f%b",
        "-z",
        root ? "HEAD" : `${base}..HEAD`,
      ],
      this.repoRoot
    );
    return out
      .split("\0")
      .filter((e) => e.length > 0)
      .map((entry) => {
        const [hash, subject, body] = entry.split("\x1f");
        return { hash, subject: subject ?? "", body: (body ?? "").trim() };
      });
  }

  /**
   * 현재 checkout 된 로컬 브랜치에서 그래프 rebase 계획의 기준점을 계산한다.
   * - 사용자가 커밋을 지정했으면 HEAD 조상 여부와 무관하게 그 커밋의 부모를 기준점으로 삼는다.
   * - 사용자가 root 커밋을 지정했으면 --root rebase 로 현재 브랜치 전체를 편집한다.
   * - 커밋을 지정하지 않았을 때만 upstream merge-base 를 자동 기준점으로 사용한다.
   * @param startHash 사용자가 그래프에서 드래그한 시작 커밋 해시
   * @param ontoHash  드래그를 놓은 대상 커밋. 재작성 범위 바깥이면 --onto 대상으로 사용한다.
   */
  async prepareCurrentBranchPlan(
    startHash?: string,
    ontoHash?: string
  ): Promise<RebasePlanInfo> {
    const branch = (
      await runGit(["branch", "--show-current"], this.repoRoot)
    ).trim();
    if (!branch) {
      throw new Error("Interactive rebase requires a checked-out local branch.");
    }
    const upstream = await optionalGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      this.repoRoot
    );
    let base = "";
    let root = false;
    let baseReason: RebasePlanInfo["baseReason"] = "selected";
    if (startHash) {
      base = (await this.parentOf(startHash)) ?? "";
      root = !base;
    } else if (upstream) {
      const mergeBase = (
        await runGit(["merge-base", "HEAD", upstream], this.repoRoot)
      ).trim();
      const localCount = Number(
        (
          await runGit(["rev-list", "--count", `${mergeBase}..HEAD`], this.repoRoot)
        ).trim()
      );
      if (localCount > 0) {
        base = mergeBase;
        baseReason = "upstream";
      }
    }
    if (!base && !root) {
      throw new Error("Drag a commit to choose the rebase start point.");
    }

    const commits = await this.getCommits(base, root);
    const onto = await this.usableOntoTarget(ontoHash, base, root);
    return {
      branch,
      upstream: upstream || undefined,
      base,
      root,
      onto,
      baseReason,
      commits,
    };
  }

  /**
   * 사용자가 짠 계획대로 인터랙티브 rebase 를 실행한다.
   * - todo 와 메시지 큐를 임시 파일로 만들고, GIT_SEQUENCE_EDITOR/GIT_EDITOR 를
   *   우리 헬퍼 스크립트로 지정해 비대화식으로 주입한다.
   * - staged/unstaged 변경이 있어도 --autostash 로 잠시 보관한 뒤 rebase 를 진행한다.
   * - 충돌로 멈추면 status="conflicts" 를 반환한다(충돌 뷰가 이어받음).
   * @param base         편집 대상 직전 커밋(rebase 기준점)
   * @param root         true 면 root commit 부터 편집한다.
   * @param items        계획(최종 표시 순서, 오래된 것부터)
   * @param editorScript 헬퍼 스크립트(rebaseEditor.js) 절대 경로
   * @param onto         선택 사항. 있으면 `git rebase -i --onto onto base` 로 실행한다.
   */
  async start(
    base: string,
    root: boolean,
    items: RebaseItem[],
    editorScript: string,
    onto?: string
  ): Promise<RebaseResult> {
    const kept = items.filter((i) => i.action !== "drop");
    if (kept.length === 0) {
      return { status: "noop" };
    }
    // 첫 항목은 squash/fixup 대상이 없으므로 pick 으로 보정한다.
    if (kept[0].action === "squash" || kept[0].action === "fixup") {
      kept[0] = { ...kept[0], action: "pick" };
    }

    const todoLines: string[] = [];
    const messageQueue: (string | null)[] = [];
    for (const item of kept) {
      todoLines.push(`${item.action} ${item.hash}`);
      if (item.action === "reword" || item.action === "squash") {
        const msg = item.message && item.message.trim() ? item.message : null;
        messageQueue.push(msg);
      }
    }

    const todoFile = tempPath("todo");
    const queueFile = tempPath("queue");
    fs.writeFileSync(todoFile, todoLines.join("\n") + "\n", "utf8");
    fs.writeFileSync(queueFile, JSON.stringify(messageQueue), "utf8");

    // VS Code 확장 호스트의 실행 파일을 node 로 동작시켜 헬퍼를 실행한다.
    const editorCmd = `"${process.execPath}" "${editorScript}"`;
    const env: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: "1",
      GIT_SEQUENCE_EDITOR: `${editorCmd} seq`,
      GIT_EDITOR: `${editorCmd} msg`,
      GSC_TODO: todoFile,
      GSC_MSG_QUEUE: queueFile,
    };

    try {
      await runGit(
        [
          "rebase",
          "-i",
          "--autostash",
          ...(onto ? ["--onto", onto] : []),
          ...(root ? ["--root"] : [base]),
        ],
        this.repoRoot,
        env
      );
      return { status: "completed" };
    } catch (err) {
      // 비정상 종료 시, rebase 가 진행 중이면 충돌로 멈춘 것이다.
      const op = await detectOperation(this.repoRoot);
      if (op === "rebase") {
        return { status: "conflicts" };
      }
      return {
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      safeUnlink(todoFile);
      safeUnlink(queueFile);
    }
  }

  /**
   * 지정 커밋의 첫 부모를 반환한다.
   * @param hash 부모를 찾을 커밋 해시
   * @returns 첫 부모 해시. 루트 커밋이면 undefined
   */
  private async parentOf(hash: string): Promise<string | undefined> {
    try {
      return (await runGit(["rev-parse", `${hash}^`], this.repoRoot)).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * 드래그 drop 대상 커밋을 --onto 로 사용할 수 있는지 판단한다.
   * - 대상이 base 이거나 base..HEAD 재작성 범위 내부면 reorder 의도로 보고 --onto 를 생략한다.
   * - 대상이 다른 브랜치/과거 커밋처럼 범위 밖이면 현재 브랜치를 그 커밋 위로 옮기는 계획이 된다.
   * @param ontoHash 사용자가 드래그를 놓은 대상 커밋 해시
   * @param base     rebase 기준점
   * @returns --onto 로 넘길 정규화된 커밋 해시. 사용할 수 없으면 undefined
   */
  private async usableOntoTarget(
    ontoHash: string | undefined,
    base: string,
    root: boolean
  ): Promise<string | undefined> {
    if (!ontoHash) {
      return undefined;
    }
    const onto = await this.normalizeCommit(ontoHash);
    if (!root && onto === base) {
      return undefined;
    }
    const insideRewrittenRange = root
      ? await isAncestor(onto, "HEAD", this.repoRoot)
      : (await isAncestor(base, onto, this.repoRoot)) &&
        (await isAncestor(onto, "HEAD", this.repoRoot));
    return insideRewrittenRange ? undefined : onto;
  }

  /**
   * 사용자가 그래프에서 넘긴 해시가 실제 commit 인지 확인하고 전체 해시로 정규화한다.
   * @param hash 그래프 row/node 에서 넘어온 커밋 식별자
   * @returns git 이 확인한 commit 해시
   */
  private async normalizeCommit(hash: string): Promise<string> {
    return (
      await runGit(["rev-parse", "--verify", `${hash}^{commit}`], this.repoRoot)
    ).trim();
  }
}

/** 실패해도 undefined 로 삼을 수 있는 git 조회를 실행한다. */
async function optionalGit(
  args: string[],
  repoRoot: string
): Promise<string | undefined> {
  try {
    const out = await runGit(args, repoRoot);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** ancestor 가 target 의 조상인지 확인한다. */
async function isAncestor(
  ancestor: string,
  target: string,
  repoRoot: string
): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, target], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/** 임시 파일 경로를 만든다(충돌 방지를 위해 난수 접미사 사용). */
function tempPath(kind: string): string {
  const suffix = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `gsc-rebase-${kind}-${suffix}`);
}

/** 파일을 조용히 삭제한다(없어도 무시). */
function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 무시 */
  }
}
