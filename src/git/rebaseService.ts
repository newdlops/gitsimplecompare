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
  base: string;
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
   * - rebase 는 깨끗한 작업트리를 요구하므로 시작 전에 검사한다(추적되지 않은 파일은 무시).
   */
  async isClean(): Promise<boolean> {
    const out = await runGit(
      ["status", "--porcelain", "--untracked-files=no"],
      this.repoRoot
    );
    return out.trim().length === 0;
  }

  /**
   * base..HEAD 범위의 커밋들을 오래된 것부터(rebase todo 순서로) 반환한다.
   * @param base 편집 대상의 직전 커밋(이 커밋은 포함되지 않음)
   */
  async getCommits(base: string): Promise<RebaseCommit[]> {
    const out = await runGit(
      ["log", "--reverse", "--pretty=format:%H\x1f%s\x1f%b", "-z", `${base}..HEAD`],
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
   * 현재 checkout 된 로컬 브랜치에서 그래프 rebase 계획의 기준점을 자동 계산한다.
   * - upstream 이 있고 로컬 전용 커밋이 있으면 merge-base 를 기준점으로 삼아 원격 공개 이력을 피한다.
   * - 그렇지 않으면 사용자가 드래그한 커밋의 부모를 기준점으로 삼는다.
   * @param startHash 사용자가 그래프에서 드래그한 시작 커밋 해시
   */
  async prepareCurrentBranchPlan(startHash?: string): Promise<RebasePlanInfo> {
    const branch = (
      await runGit(["branch", "--show-current"], this.repoRoot)
    ).trim();
    if (!branch) {
      throw new Error("Interactive rebase requires a checked-out local branch.");
    }
    if (startHash) {
      await this.assertHeadAncestor(startHash);
    }

    const upstream = await optionalGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      this.repoRoot
    );
    let base = "";
    let baseReason: RebasePlanInfo["baseReason"] = "selected";
    if (upstream) {
      const mergeBase = (
        await runGit(["merge-base", "HEAD", upstream], this.repoRoot)
      ).trim();
      const localCount = Number(
        (
          await runGit(["rev-list", "--count", `${mergeBase}..HEAD`], this.repoRoot)
        ).trim()
      );
      const startIsLocal = startHash
        ? await isAncestor(mergeBase, startHash, this.repoRoot)
        : true;
      if (localCount > 0 && startIsLocal) {
        base = mergeBase;
        baseReason = "upstream";
      }
    }
    if (!base && startHash) {
      base = await this.parentOf(startHash);
    }
    if (!base) {
      throw new Error("Drag a commit on the current branch to choose the rebase start point.");
    }

    const commits = await this.getCommits(base);
    return {
      branch,
      upstream: upstream || undefined,
      base,
      baseReason,
      commits,
    };
  }

  /**
   * 사용자가 짠 계획대로 인터랙티브 rebase 를 실행한다.
   * - todo 와 메시지 큐를 임시 파일로 만들고, GIT_SEQUENCE_EDITOR/GIT_EDITOR 를
   *   우리 헬퍼 스크립트로 지정해 비대화식으로 주입한다.
   * - 충돌로 멈추면 status="conflicts" 를 반환한다(충돌 뷰가 이어받음).
   * @param base         편집 대상 직전 커밋(rebase 기준점)
   * @param items        계획(최종 표시 순서, 오래된 것부터)
   * @param editorScript 헬퍼 스크립트(rebaseEditor.js) 절대 경로
   */
  async start(
    base: string,
    items: RebaseItem[],
    editorScript: string
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
      await runGit(["rebase", "-i", base], this.repoRoot, env);
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

  /** 지정 커밋이 현재 HEAD 의 조상인지 확인한다. */
  private async assertHeadAncestor(hash: string): Promise<void> {
    if (!(await isAncestor(hash, "HEAD", this.repoRoot))) {
      throw new Error(
        "Only commits on the current branch can be rebased from the graph."
      );
    }
  }

  /** 지정 커밋의 첫 부모를 반환한다. 루트 커밋은 이 POC 에서 지원하지 않는다. */
  private async parentOf(hash: string): Promise<string> {
    try {
      return (await runGit(["rev-parse", `${hash}^`], this.repoRoot)).trim();
    } catch {
      throw new Error(
        "Root commit rebase is not supported by the graph POC yet."
      );
    }
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
