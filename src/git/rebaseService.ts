// 인터랙티브 rebase 를 비대화식으로 수행하는 서비스 모듈.
// - git 의 시퀀스 에디터/커밋 에디터를 우리 헬퍼 스크립트로 대체해, 사용자가 UI 에서
//   짠 계획(todo)과 메시지를 주입한다. 사용자 입력은 모두 호출부에서 받아 전달받는다.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitError, runGit } from "./gitExec";
import { detectOperation } from "./conflictService";
import { parseNameStatusZ, parseNumstat, parsePorcelainGroups } from "./diffParse";
import {
  applyRebaseEditTempFiles,
  cleanupRebaseEditTempFiles,
} from "./rebaseEditSession";
import {
  collectHistoryExcludePaths,
} from "./rebaseFileExcludes";
import { rebaseFileRewriteExecLine } from "./rebaseFileRewriteOps";
import {
  cleanupRebaseMessageQueue,
  initializeRebaseMessageQueue,
} from "./rebaseMessageQueue";
import { usableRebaseOntoTarget } from "./rebaseOntoTarget";
import { readRebaseTodoProgress } from "./rebaseTodoProgress";
import { validateRebaseTodoCoverage } from "./rebaseTodoValidation";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** rebase 계획에서 커밋별로 보여줄 변경 파일 한 건 */
export interface RebaseCommitFile {
  status: string;
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
}
/** rebase 대상 커밋 한 건(계획 UI 표시용) */
export interface RebaseCommit {
  hash: string;
  subject: string;
  body: string;
  files: RebaseCommitFile[];
}
/** todo 한 줄의 동작 */
export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";
/** 한 커밋의 파일 변경을 다른 커밋으로 옮기는 계획 */
export interface RebaseFileMove { sourceHash: string; sourcePath: string; sourceOldPath?: string; targetHash: string; }
/** 사용자가 짠 계획 한 항목 */
export interface RebaseItem {
  hash: string;
  action: RebaseAction;
  /** UI 복원과 rename 처리용 파일 목록 */
  files?: RebaseCommitFile[];
  /** reword/squash 시 사용할 메시지(빈 값이면 git 기본 메시지 유지) */
  message?: string;
  /** 이 커밋에서 제외할 파일 경로 목록 */ excludePaths?: string[];
  /** 계획 범위 전체 커밋에서 제외할 파일 경로 목록 */
  historyExcludePaths?: string[];
  /** 다른 커밋으로 옮길 파일 변경 목록 */ fileMoves?: RebaseFileMove[];
}
/** rebase 실행 결과 */
export interface RebaseResult {
  status: "completed" | "conflicts" | "failed" | "noop" | "paused" | "stopped";
  message?: string;
  paused?: RebasePausedState;
  stopped?: RebaseStoppedState;
}
/** rebase 가 edit todo 에서 멈췄을 때 UI 가 이어받을 상태 */
export interface RebasePausedState {
  hash: string;
  originalHash?: string;
  parent?: string;
  files: RebaseCommitFile[];
}
/** rebase 가 충돌/실패로 특정 todo 항목에서 멈춘 위치 */
export interface RebaseStoppedState {
  /** 현재 HEAD. 충돌 중에는 실패한 커밋 직전의 새 커밋일 수 있다. */
  hash?: string;
  /** git rebase 상태 파일의 원본 todo 커밋 해시(stopped-sha). */
  originalHash?: string;
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
  /** 진행 중인 rebase 복원 시 UI action/message/order 를 되살리기 위한 저장된 todo 항목 */
  items?: RebaseItem[];
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
    const commits = out
      .split("\0")
      .filter((e) => e.length > 0)
      .map((entry) => {
        const [hash, subject, body] = entry.split("\x1f");
        return { hash, subject: subject ?? "", body: (body ?? "").trim(), files: [] };
      });
    return Promise.all(
      commits.map(async (commit) => ({
        ...commit,
        files: await this.getCommitFiles(commit.hash),
      }))
    );
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
    const onto = await usableRebaseOntoTarget(
      this.repoRoot,
      ontoHash,
      base,
      root
    );
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
   * - 이미 rebase 중이면 새로 시작하지 않고 현재 Git todo 상태를 반환한다.
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
    const active = await detectOperation(this.repoRoot);
    if (active === "rebase") {
      const paused = await this.getPausedEditState();
      const stopped = await this.getStoppedState();
      if (paused) return { status: "paused", paused };
      return await this.hasUnmergedFiles()
        ? { status: "conflicts", stopped }
        : { status: "stopped", stopped };
    }
    if (active !== "none") {
      return { status: "failed", message: `Cannot start rebase while ${active} is in progress.` };
    }
    const todoItems = items.slice();
    if (todoItems.length === 0) {
      return { status: "noop" };
    }
    const validation = validateRebaseTodoCoverage(
      await this.getCommits(base, root),
      todoItems
    );
    if (!validation.ok) {
      return {
        status: "failed",
        message: validation.message,
      };
    }
    // 첫 replay 항목은 squash/fixup 대상이 없으므로 pick 으로 보정한다.
    const firstKeptIndex = todoItems.findIndex((item) => item.action !== "drop");
    if (firstKeptIndex >= 0 && (todoItems[firstKeptIndex].action === "squash" || todoItems[firstKeptIndex].action === "fixup")) {
      todoItems[firstKeptIndex] = { ...todoItems[firstKeptIndex], action: "pick" };
    }

    const todoLines: string[] = [];
    const opFiles: string[] = [];
    const historyExcludePaths = collectHistoryExcludePaths(items);
    const rewriteItems = todoItems.filter((item) => item.action !== "drop");
    for (const item of todoItems) {
      todoLines.push(`${item.action} ${item.hash}`);
      const rewrite = await rebaseFileRewriteExecLine(this.repoRoot, item, rewriteItems, historyExcludePaths, process.execPath, editorScript);
      if (rewrite) {
        opFiles.push(rewrite.opFile);
        todoLines.push(rewrite.line);
      }
    }

    const todoFile = tempPath("todo");
    let keepTempFiles = false;
    fs.writeFileSync(todoFile, todoLines.join("\n") + "\n", "utf8");

    // VS Code 확장 호스트의 실행 파일을 node 로 동작시켜 헬퍼를 실행한다.
    const editorCmd = `"${process.execPath}" "${editorScript}"`;
    const messageEditorEnv = await initializeRebaseMessageQueue(this.repoRoot, todoItems, editorScript);
    const env: Record<string, string> = {
      ...messageEditorEnv,
      GIT_SEQUENCE_EDITOR: `${editorCmd} seq`,
      GSC_TODO: todoFile,
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
      const paused = await this.getPausedEditState();
      if (paused) {
        keepTempFiles = true;
        return { status: "paused", paused };
      }
      if (await detectOperation(this.repoRoot) === "rebase") {
        keepTempFiles = true;
        return { status: "stopped", stopped: await this.getStoppedState() };
      }
      return { status: "completed" };
    } catch (err) {
      // 비정상 종료 시, rebase 가 진행 중이면 충돌로 멈춘 것이다.
      const op = await detectOperation(this.repoRoot);
      if (op === "rebase") {
        keepTempFiles = true;
        const stopped = await this.getStoppedState();
        if (await this.hasUnmergedFiles()) {
          return { status: "conflicts", stopped };
        }
        const paused = await this.getPausedEditState();
        if (paused) {
          return { status: "paused", paused };
        }
        return { status: "stopped", stopped, message: stopMessage(err) };
      }
      return {
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (!keepTempFiles) {
        safeUnlink(todoFile);
        await cleanupRebaseMessageQueue(this.repoRoot);
        for (const opFile of opFiles) {
          safeUnlink(opFile);
        }
      }
    }
  }

  /**
   * 진행 중인 rebase 가 현재 어느 todo 항목에서 멈췄는지 읽는다.
   * - 충돌 중에는 HEAD 가 실패 커밋 자체가 아니라 직전 커밋을 가리킬 수 있으므로,
   *   `.git/rebase-merge/stopped-sha` 의 원본 해시를 함께 반환해 그래프의 원래 row 와 연결한다.
   * @returns rebase 가 진행 중이고 위치를 읽을 수 있으면 현재 HEAD/원본 todo 해시
   */
  async getStoppedState(): Promise<RebaseStoppedState | undefined> {
    if (await detectOperation(this.repoRoot) !== "rebase") {
      return undefined;
    }
    const [hash, originalHash] = await Promise.all([
      optionalGit(["rev-parse", "HEAD"], this.repoRoot),
      this.currentOriginalHash(),
    ]);
    return hash || originalHash ? { hash, originalHash } : undefined;
  }

  /**
   * rebase 가 edit 지점에서 멈춘 상태를 읽는다.
   * - 충돌이 없더라도 todo 의 현재 action 이 `edit` 일 때만 파일 편집 pause 로 본다.
   * - `.git/rebase-merge/stopped-sha` 는 원래 커밋 해시이므로 그래프 계획의 row 와 다시 연결하는 데 쓴다.
   */
  async getPausedEditState(): Promise<RebasePausedState | undefined> {
    if (await detectOperation(this.repoRoot) !== "rebase") {
      return undefined;
    }
    if (await this.hasUnmergedFiles()) {
      return undefined;
    }
    const progress = await readRebaseTodoProgress(this.repoRoot).catch(() => undefined);
    const currentAction = progress?.items.find((item) => item.role === "current")?.action;
    if (currentAction !== "edit") {
      return undefined;
    }
    const hash = (await runGit(["rev-parse", "HEAD"], this.repoRoot)).trim();
    const originalHash = await this.currentOriginalHash();
    const parent = await this.parentOf(hash);
    return {
      hash,
      originalHash,
      parent,
      files: await this.getCommitFiles(hash),
    };
  }

  /**
   * edit 으로 멈춘 커밋에서 사용자가 수정한 파일을 현재 커밋에 반영한다.
   * - rebase edit 중 VS Code diff 로 바꾼 내용은 우선 작업트리 변경으로 남는다.
   * - Continue 전에 해당 커밋의 변경 파일만 stage 한 뒤 `commit --amend --no-edit` 로 커밋 자체를 갱신한다.
   * - rebase 중 다른 파일에 충돌 마커가 남아 있을 수 있으므로, 내부 amend 는 hook 검증을 건너뛴다.
   * @param paused 이미 읽어 둔 edit 정지 상태. 없으면 현재 상태를 다시 읽는다.
   * @returns amend 할 staged 변경이 있어 커밋을 갱신했으면 true
   */
  async amendPausedEditChanges(paused?: RebasePausedState): Promise<boolean> {
    if (await detectOperation(this.repoRoot) !== "rebase") {
      return false;
    }
    if (await this.hasUnmergedFiles()) {
      return false;
    }
    const state = paused ?? await this.getPausedEditState();
    if (!state) {
      return false;
    }
    const stagedFromTemp = await applyRebaseEditTempFiles(this.repoRoot, state);
    const candidates = uniquePaths((state.files ?? []).map((file) => file.path));
    const paths = stagedFromTemp.length > 0
      ? stagedFromTemp
      : await this.changedPausedEditPaths(candidates);
    if (paths.length === 0) {
      return false;
    }
    if (stagedFromTemp.length === 0) {
      await runGit(["add", "-A", "--", ...paths], this.repoRoot);
    }
    if (!(await this.hasStagedChanges(paths))) {
      return false;
    }
    await runGit(
      ["commit", "--amend", "--no-edit", "--allow-empty", "--no-verify"],
      this.repoRoot,
      { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" }
    );
    await cleanupRebaseEditTempFiles(this.repoRoot, state);
    return true;
  }

  /**
   * 커밋 한 건의 변경 파일 목록을 첫 부모 기준으로 반환한다.
   * @param hash 대상 커밋 해시
   */
  private async getCommitFiles(hash: string): Promise<RebaseCommitFile[]> {
    const base = (await this.parentOf(hash)) ?? EMPTY_TREE;
    const [nameStatus, numstat] = await Promise.all([
      runGit(["diff", "--name-status", "-M", "-z", base, hash], this.repoRoot),
      runGit(["diff", "--numstat", "-z", "-M", base, hash], this.repoRoot),
    ]);
    const counts = parseNumstat(numstat);
    return parseNameStatusZ(nameStatus).map((change) => {
      const stat = counts.get(change.path);
      return {
        status: change.status,
        path: change.path,
        oldPath: change.oldPath,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
      };
    });
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

  /** rebase 충돌로 unmerged index entry 가 있는지 확인한다. */
  private async hasUnmergedFiles(): Promise<boolean> {
    const out = await runGit(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      this.repoRoot
    ).catch(() => "");
    return out.split("\0").some((entry) => entry.length > 0);
  }

  /** 지정 경로 중 index 에 커밋할 변경이 stage 되어 있는지 확인한다. */
  private async hasStagedChanges(paths: string[]): Promise<boolean> {
    try {
      await runGit(["diff", "--cached", "--quiet", "--", ...paths], this.repoRoot);
      return false;
    } catch {
      return true;
    }
  }

  /** edit 커밋 후보 경로 중 실제 작업트리/index 에 변경이 있는 경로만 고른다. */
  private async changedPausedEditPaths(candidates: string[]): Promise<string[]> {
    const wanted = new Set(candidates);
    if (wanted.size === 0) {
      return [];
    }
    const raw = await runGit(
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      this.repoRoot
    );
    const { staged, unstaged } = parsePorcelainGroups(raw);
    const changed = new Set<string>();
    for (const change of [...staged, ...unstaged]) {
      if (wanted.has(change.path)) {
        changed.add(change.path);
      }
      if (change.oldPath && wanted.has(change.oldPath)) {
        changed.add(change.oldPath);
      }
    }
    return Array.from(changed);
  }

  /** rebase-merge/rebase-apply 내부 상태 파일을 조용히 읽는다. */
  private async readRebaseStateFile(name: string): Promise<string | undefined> {
    const gitDirRaw = (await runGit(["rev-parse", "--git-dir"], this.repoRoot)).trim();
    const gitDir = path.resolve(this.repoRoot, gitDirRaw);
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      const file = path.join(gitDir, dir, name);
      const value = await fs.promises.readFile(file, "utf8").catch(() => "");
      if (value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  /** rebase 상태 파일이 비어 있을 때 done/todo 진행률에서 원본 todo 해시를 보강한다. */
  private async currentOriginalHash(): Promise<string | undefined> {
    return (await this.readRebaseStateFile("stopped-sha")) ??
      (await readRebaseTodoProgress(this.repoRoot).catch(() => undefined))?.currentHash;
  }

}

/** 실패해도 undefined 로 삼을 수 있는 git 조회를 실행한다. */
async function optionalGit(
  args: string[],
  repoRoot: string
): Promise<string | undefined> {
  try { return (await runGit(args, repoRoot)).trim() || undefined; } catch { return undefined; }
}

/** 임시 파일 경로를 만든다(충돌 방지를 위해 난수 접미사 사용). */
function tempPath(kind: string): string {
  const suffix = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `gsc-rebase-${kind}-${suffix}`);
}

/**
 * 경로 배열의 빈 값과 중복을 제거한다.
 * @param paths 경로 후보 목록
 */
function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** rebase 가 충돌 없이 멈춘 이유를 Git stderr/stdout 에서 짧게 뽑는다. */
function stopMessage(err: unknown): string | undefined {
  const text = err instanceof GitError
    ? `${err.stderr}\n${err.stdout}`.trim()
    : err instanceof Error ? err.message : String(err);
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 4).join(" ");
}

/** 파일을 조용히 삭제한다(없어도 무시). */
function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 무시 */
  }
}
