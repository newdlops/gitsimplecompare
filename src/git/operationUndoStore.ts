// 브랜치/PR Undo snapshot을 작업 ID, worktree, Git 작업 세대와 연결해 다른 변경의 폐기를 막는다.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { detectOperation, type MergeOperation } from "./conflictService";
import { readConflictOperationEpoch } from "./conflictOperationEpoch";
import { controlGitOperation } from "./operationControl";
import { GitError, runGit } from "./gitExec";
import { logInfo } from "../ui/outputLog";
import { restoreUnoccupiedBranch } from "./branchRefCas";

type Phase = "prepared" | "completed" | "squash" | "rebase" | "replay" | "restoring";

/** 확인창을 열기 전에 고정하고 실행 직전에 다시 검증할 Undo 대상이다. */
export interface OperationUndoPlan {
  id: string;
  branch: string;
  snapshotRef: string;
  restoredHead: string;
  expectedHead: string;
  phase: Phase;
  operation: MergeOperation;
  worktreeBranch: string;
  worktreeHead: string;
}

interface Binding {
  version: 1;
  id: string;
  branch: string;
  gitDir: string;
  snapshotRef: string;
  beforeHead: string;
  phase: Phase;
  state?: RepositoryState;
}

interface RepositoryState {
  branch: string;
  head: string;
  operation: MergeOperation;
  headLog: string;
  epoch: string;
  squash: string;
  index: string;
  unmerged: boolean;
  rebase: string;
  sequencer: string;
}

/** 동일 worktree에서 만든 브랜치/PR snapshot의 생성·검증·복구 수명주기를 관리한다. */
export class OperationUndoStore {
  /** family로 브랜치와 PR의 기록 영역을 분리하고 기존 브랜치 기록의 형식을 유지한다. */
  constructor(private readonly repoRoot: string, private readonly family: "branch" | "pull-request" = "branch") {}

  /**
   * 새 snapshot에 고유 작업 ID를 부여한다. 아직 결과를 기록하지 않은 상태는 자동 Undo하지 않는다.
   * @param branch 작업 대상 로컬 브랜치
   * @param beforeHead 작업 시작 전 commit OID
   * @param snapshotRef 시작 commit을 보존한 Git ref
   */
  async start(branch: string, beforeHead: string, snapshotRef: string): Promise<void> {
    await this.write({
      version: 1, id: randomUUID(), branch, beforeHead, snapshotRef,
      gitDir: await this.gitDir(), phase: "prepared",
    });
  }

  /**
   * 완료 또는 부분 적용 결과를 기록해 이후 별개의 stash 충돌/새 rebase와 구분한다.
   * @param branch snapshot 소유 브랜치
   * @param snapshotRef 이 호출이 시작한 snapshot ref
   * @param phase 완료, squash 부분 적용, rebase 또는 PR cherry-pick/revert 중단 상태
   * @param allowMissing 이전 버전에서 시작한 rebase의 완료를 허용하되 Undo 기록은 추정하지 않는다.
   */
  async capture(branch: string, snapshotRef: string, phase: "completed" | "squash" | "rebase" | "replay", allowMissing = false): Promise<void> {
    const binding = await this.read(branch);
    // 업데이트 전 시작한 rebase는 계속할 수 있지만 출처 없는 자동 Undo 기록은 새로 만들지 않는다.
    if (!binding && allowMissing) return;
    if (!binding || binding.snapshotRef !== snapshotRef) throw staleUndo();
    await this.assertSnapshot(binding);
    const state = await this.readState();
    if (phase === "rebase") {
      if (state.operation !== "rebase" || !state.rebase) throw staleUndo();
      const owner = await this.rebaseBranch();
      if (owner !== branch) throw staleUndo();
    } else if (phase === "replay") {
      if (state.branch !== branch || !["cherry-pick", "revert"].includes(state.operation)) throw staleUndo();
    } else if (state.branch !== branch || state.operation !== "none") {
      throw staleUndo();
    }
    if (phase === "squash" && state.head !== binding.beforeHead) throw staleUndo();
    await this.write({ ...binding, phase, state });
    logInfo("operation recovery recorded", {
      repoRoot: this.repoRoot, family: this.family, branch, snapshotRef, phase, id: binding.id,
    });
  }

  /**
   * 현재 저장소가 저장된 작업과 같은 상태인지 확인하여 확인창에 전달할 대상을 만든다.
   * @param branch 확인할 브랜치. 생략하면 현재/진행 중 rebase의 브랜치를 찾는다.
   * @returns snapshot ID와 현재 HEAD에 고정된 Undo 계획
   */
  async prepare(branch?: string): Promise<OperationUndoPlan> {
    const target = branch || await this.currentBranch() || await this.rebaseBranch();
    if (!target) throw staleUndo();
    const binding = await this.read(target);
    if (!binding || !binding.state || binding.phase === "prepared") throw staleUndo();
    await this.assertSnapshot(binding);
    const state = await this.readState();
    const offBranch = state.branch !== target;
    const targetHead = offBranch
      ? (await runGit(["rev-parse", "--verify", `refs/heads/${target}^{commit}`], this.repoRoot)).trim()
      : state.head;
    if (binding.phase === "rebase") {
      if (state.operation !== "rebase" || !state.rebase || state.rebase !== binding.state.rebase ||
          await this.rebaseBranch() !== binding.branch) throw staleUndo();
    } else if (binding.phase === "replay") {
      // 충돌 뒤 새로 스테이징한 사용자 변경은 abort가 폐기할 수 있어 자동 Undo를 중단한다.
      if (offBranch || state.head !== binding.state.head || state.operation !== binding.state.operation ||
          state.epoch !== binding.state.epoch || state.sequencer !== binding.state.sequencer ||
          state.index !== binding.state.index) throw staleUndo();
    } else {
      if ((offBranch && (this.family !== "pull-request" || !["completed", "restoring"].includes(binding.phase))) ||
          targetHead !== binding.state.head || state.operation !== "none") throw staleUndo();
      if (binding.phase === "squash") {
        if (state.headLog !== binding.state.headLog || state.epoch !== binding.state.epoch ||
            state.squash !== binding.state.squash || state.index !== binding.state.index ||
            (this.family === "pull-request" && state.sequencer !== binding.state.sequencer)) throw staleUndo();
      } else if (state.unmerged || (this.family === "pull-request" && state.sequencer)) {
        // 완료된 작업의 snapshot으로 나중에 발생한 stash/checkout 충돌을 폐기하지 않는다.
        throw staleUndo();
      }
    }
    return {
      id: binding.id, branch: target, snapshotRef: binding.snapshotRef,
      restoredHead: binding.beforeHead, expectedHead: targetHead,
      phase: binding.phase, operation: state.operation,
      worktreeBranch: state.branch, worktreeHead: state.head,
    };
  }

  /**
   * 승인한 작업을 다시 검증한 뒤 Git 자체의 변경 보호를 사용해 복원한다.
   * @param plan 확인창 이전에 확정한 작업 ID/HEAD
   * @returns 복원 완료 후의 브랜치와 HEAD는 plan.branch/restoredHead와 같다.
   */
  async undo(plan: OperationUndoPlan): Promise<void> {
    const current = await this.prepare(plan.branch);
    if (JSON.stringify(current) !== JSON.stringify(plan)) throw staleUndo();
    if (this.family === "pull-request" && plan.worktreeBranch !== plan.branch) {
      await restoreUnoccupiedBranch(this.repoRoot, plan.branch, plan.expectedHead, plan.restoredHead);
    } else if (plan.operation !== "none") {
      await controlGitOperation(this.repoRoot, plan.operation, "abort");
      if (plan.phase === "replay") {
        await runGit(["reset", "--keep", plan.restoredHead], this.repoRoot, { retryOnLock: false });
      }
    } else if (plan.phase !== "restoring") {
      // 완료 후 따로 stage한 내용은 --keep도 index에서 지우므로 reset 전에 그대로 두고 중단한다.
      if (plan.phase === "completed" && await runGit(["diff", "--cached", "--name-only", "-z"], this.repoRoot)) {
        throw new Error("Undo stopped because staged changes would be reset. Commit or stash these changes before retrying. Your index, working files, and recovery snapshot were kept.");
      }
      // --merge는 squash의 index를 되돌리면서 다른 파일의 unstaged 변경을 보존한다.
      const mode = plan.phase === "squash" ? "--merge" : "--keep";
      await runGit(["reset", mode, plan.restoredHead], this.repoRoot, { retryOnLock: false });
    }
    await this.assertRestored(plan);
    const binding = await this.read(plan.branch);
    if (!binding || binding.id !== plan.id) throw staleUndo();
    const state = await this.readState();
    await this.write({ ...binding, phase: "restoring", state: { ...state, head: plan.restoredHead } });
  }

  /**
   * stash 복원 직전과 정리 직전에 원래 브랜치/HEAD가 유지되는지 확인한다.
   * @param plan 복원 중인 작업
   */
  async assertRestored(plan: OperationUndoPlan): Promise<void> {
    const branch = await this.currentBranch();
    const head = (await runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot)).trim();
    const offBranch = this.family === "pull-request" && plan.worktreeBranch !== plan.branch;
    const targetHead = offBranch
      ? (await runGit(["rev-parse", "--verify", `refs/heads/${plan.branch}^{commit}`], this.repoRoot)).trim() : head;
    if (branch !== (offBranch ? plan.worktreeBranch : plan.branch) || targetHead !== plan.restoredHead ||
        (offBranch && head !== plan.worktreeHead) || await detectOperation(this.repoRoot) !== "none") {
      throw staleUndo();
    }
  }

  /**
   * 복원이 끝난 동일 작업의 ref와 메타데이터만 삭제한다.
   * @param plan 성공적으로 복원한 작업
   */
  async remove(plan: OperationUndoPlan): Promise<void> {
    await this.assertRestored(plan);
    const binding = await this.read(plan.branch);
    if (!binding || binding.id !== plan.id) throw staleUndo();
    await runGit(["update-ref", "-d", plan.snapshotRef, plan.restoredHead], this.repoRoot, { retryOnLock: false });
    if ((await this.read(plan.branch))?.id === plan.id) await rm(await this.file(plan.branch), { force: true });
  }

  /** snapshot ref가 이 작업의 시작 commit을 가리키는지 확인한다. */
  private async assertSnapshot(binding: Binding): Promise<void> {
    const hash = (await runGit(["rev-parse", "--verify", `${binding.snapshotRef}^{commit}`], this.repoRoot)).trim();
    if (hash !== binding.beforeHead) throw staleUndo();
  }

  /**
   * HEAD, index와 Git 작업 표식의 세대를 읽는다. 조회 실패는 빈 결과로 바꾸지 않는다.
   * @returns Undo의 출처 및 변경 여부를 확인하는 현재 상태
   */
  private async readState(): Promise<RepositoryState> {
    const gitDir = await this.gitDir();
    const [branch, head, operation, indexText, epoch, headLog, squash, rebase, sequencer] = await Promise.all([
      this.currentBranch(),
      runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot),
      detectOperation(this.repoRoot),
      runGit(["ls-files", "--stage", "-z"], this.repoRoot),
      readConflictOperationEpoch(this.repoRoot),
      fileIdentity(path.join(gitDir, "logs/HEAD")),
      fileIdentity(path.join(gitDir, "SQUASH_MSG")),
      this.rebaseIdentity(gitDir),
      this.sequencerIdentity(gitDir),
    ]);
    return {
      branch, head: head.trim(), operation, epoch, headLog, squash, rebase, sequencer,
      index: createHash("sha256").update(indexText).digest("hex"),
      unmerged: indexText.split("\0").some(entry => /^\d+ [a-f0-9]+ [123]\t/.test(entry)),
    };
  }

  /** no-commit cherry-pick도 marker 없이 sequencer를 남기므로 생성 세대와 todo를 별도로 고정한다. */
  private async sequencerIdentity(gitDir: string): Promise<string> {
    const directory = path.join(gitDir, "sequencer");
    try {
      const info = await stat(directory, { bigint: true });
      const metadata = await Promise.all(["head", "todo"].map(file => readFile(path.join(directory, file), "utf8")));
      return [info.dev, info.ino, info.birthtimeNs, ...metadata].join("\0");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  /**
   * rebase가 진행돼도 유지되고 abort 후 재시작하면 바뀌는 디렉터리 세대를 읽는다.
   * @param gitDir 현재 worktree Git 디렉터리
   * @returns rebase 디렉터리 identity와 시작 metadata. 진행 중이 아니면 빈 문자열
   */
  private async rebaseIdentity(gitDir: string): Promise<string> {
    for (const name of ["rebase-merge", "rebase-apply"]) {
      const directory = path.join(gitDir, name);
      try {
        const info = await stat(directory, { bigint: true });
        const metadata = await Promise.all(["head-name", "orig-head", "onto"].map(file => readFile(path.join(directory, file), "utf8")));
        return [info.dev, info.ino, info.birthtimeNs, ...metadata].join("\0");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return "";
  }

  /** detached rebase의 원래 브랜치를 Git metadata에서 찾는다. */
  private async rebaseBranch(): Promise<string> {
    const gitDir = await this.gitDir();
    for (const directory of ["rebase-merge", "rebase-apply"]) {
      try {
        return (await readFile(path.join(gitDir, directory, "head-name"), "utf8")).trim().replace(/^refs\/heads\//, "");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return "";
  }

  /** 정상 detached 상태만 빈 브랜치로 허용하고 다른 Git 오류는 전달한다. */
  private async currentBranch(): Promise<string> {
    try { return (await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], this.repoRoot)).trim(); }
    catch (error) { if (error instanceof GitError && error.code === 1) return ""; throw error; }
  }

  /** 연결 정보가 없는 이전 버전의 snapshot은 자동 복구 대상으로 추정하지 않는다. */
  private async read(branch: string): Promise<Binding | undefined> {
    let raw: string;
    try { raw = await readFile(await this.file(branch), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const value = JSON.parse(raw) as Binding;
    if (value.version !== 1 || value.branch !== branch || value.gitDir !== await this.gitDir() ||
        typeof value.id !== "string" || typeof value.beforeHead !== "string" || typeof value.snapshotRef !== "string" ||
        !["prepared", "completed", "squash", "rebase", "replay", "restoring"].includes(value.phase)) throw staleUndo();
    return value;
  }

  /** atomic rename으로 중단된 기록 쓰기가 정상 snapshot으로 보이지 않게 한다. */
  private async write(binding: Binding): Promise<void> {
    const file = await this.file(binding.branch);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(binding), { flag: "wx" }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }

  /** 브랜치 이름의 slash/특수 문자가 파일 경계를 바꾸지 않도록 hex key를 사용한다. */
  private async file(branch: string): Promise<string> {
    return path.join(await this.gitDir(), "gitsimplecompare", `${this.family}-operation-undo`, `${Buffer.from(branch).toString("hex")}.json`);
  }

  /** linked worktree끼리 복구 기록을 공유하지 않도록 실제 개별 git-dir를 사용한다. */
  private async gitDir(): Promise<string> {
    return realpath((await runGit(["rev-parse", "--absolute-git-dir"], this.repoRoot)).trim());
  }
}

/** 정상 부재만 허용하며 파일 교체/재작성을 구분할 identity를 읽는다. */
async function fileIdentity(file: string): Promise<string> {
  try {
    const info = await stat(file, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** 출처나 현재 상태가 달라지면 snapshot을 보존한 채 Undo를 중단하는 오류다. */
function staleUndo(): Error {
  return new Error("The saved operation no longer matches this worktree or its changes. Undo was stopped; the recovery snapshot was preserved.");
}
