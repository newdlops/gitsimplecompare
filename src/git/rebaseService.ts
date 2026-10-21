// 인터랙티브 rebase 를 비대화식으로 수행하는 서비스 모듈.
// - git 의 시퀀스 에디터/커밋 에디터를 우리 헬퍼 스크립트로 대체해, 사용자가 UI 에서
//   짠 계획(todo)과 메시지를 주입한다. 사용자 입력은 모두 호출부에서 받아 전달받는다.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitError, runGit } from "./gitExec";
import { withGitStatePathScope } from "./gitStatePathScope";
import { detectOperation } from "./conflictService";
import { readRebaseCommits, readRebaseCommitDetails } from "./rebaseCommitReader";
import { listUnmergedFiles } from "./unmergedFiles";
import { amendRebaseEdit } from "./rebaseEditApply";
import { assertGitOperation, captureGitOperation, type GitOperationIdentity } from "./operationControl";
import { assertRebaseCheckout, captureRebaseCheckout, REBASE_RESTORE_CONFLICT_MESSAGE, type RebaseCheckoutIdentity } from "./rebasePlanSafety";
import { readLinearRebaseRange } from "./rebaseStartRange";
import { readRebaseStartContext } from "./rebaseStartContext";
import {
  collectHistoryExcludePaths,
} from "./rebaseFileExcludes";
import { RebaseFileRewritePlanner } from "./rebaseFileRewriteOps";
import {
  cleanupRebaseMessageQueue,
  initializeRebaseMessageQueue,
} from "./rebaseMessageQueue";
import { usableRebaseOntoTarget } from "./rebaseOntoTarget";
import { rebaseSequenceEditor } from "./rebaseNativeEditors";
import { readRebaseTodoProgress, type RebaseTodoProgress } from "./rebaseTodoProgress";
import { validateRebaseTodoCoverage } from "./rebaseTodoValidation";
import { logError, logInfo } from "../ui/outputLog";

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
  restoringLocalChanges?: boolean;
}
/** rebase 가 edit todo 에서 멈췄을 때 UI 가 이어받을 상태 */
export interface RebasePausedState {
  hash: string;
  originalHash?: string;
  parent?: string;
  files: RebaseCommitFile[];
  /** 같은 커밋으로 rebase를 재시작한 경우도 구분하기 위한 native 작업 식별자 */
  operation?: GitOperationIdentity;
}
/** rebase 가 충돌/실패로 특정 todo 항목에서 멈춘 위치 */
export interface RebaseStoppedState {
  /** 현재 HEAD. 충돌 중에는 실패한 커밋 직전의 새 커밋일 수 있다. */
  hash?: string;
  /** git rebase 상태 파일의 원본 todo 커밋 해시(stopped-sha). */
  originalHash?: string;
}

/** 한 번의 최신 작업 검증 안에서 함께 읽은 복원용 rebase 상태다. */
export interface RebaseRuntimeState {
  operation: GitOperationIdentity;
  conflicts: string[];
  progress?: RebaseTodoProgress;
  stopped?: RebaseStoppedState;
  paused?: RebasePausedState;
}
/** 현재 브랜치에서 그래프 rebase UI 가 편집할 계획 범위 */
export interface RebasePlanInfo {
  branch: string;
  checkout?: RebaseCheckoutIdentity;
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
/** 번들 seq 규약의 todo 복사만 대체한다. 별도 editorScript를 쓰는 독립 호출은 기본 Node 규약을 유지한다. */
export interface RebaseServiceOptions { nativeEditors?: boolean }
/**
 * 한 저장소의 인터랙티브 rebase 를 다루는 서비스.
 */
export class RebaseService {
  private preparedCheckout?: RebaseCheckoutIdentity;
  /** @param repoRoot 작업 저장소 @param options 번들 helper임을 아는 조립 계층만 nativeEditors를 허용한다. */
  constructor(public readonly repoRoot: string, private readonly options: RebaseServiceOptions = {}) {}
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
   * @param includeFiles false면 파일 diff 없이 현재 커밋 범위와 원본 메시지만 새로 읽는다.
   */
  async getCommits(base: string, root = false, includeFiles = true): Promise<RebaseCommit[]> {
    return readRebaseCommits(this.repoRoot, base, root, includeFiles);
  }

  /**
   * 현재 checkout 된 로컬 브랜치에서 그래프 rebase 계획의 기준점을 계산한다.
   * - 사용자가 커밋을 지정했으면 현재 HEAD 이력에 포함된 행인지 확인한 뒤 그 부모를 기준점으로 삼는다.
   * - 다른 브랜치 행을 현재 HEAD 기준 범위로 계산하면 브랜치 시작까지 잘못 포함되므로 명시적으로 거부한다.
   * - 사용자가 root 커밋을 지정했으면 --root rebase 로 현재 브랜치 전체를 편집한다.
   * - 커밋을 지정하지 않았을 때만 upstream merge-base 를 자동 기준점으로 사용한다.
   * @param startHash 사용자가 그래프에서 드래그한 시작 커밋 해시
   * @param ontoHash  드래그를 놓은 대상 커밋. 재작성 범위 바깥이면 --onto 대상으로 사용한다.
   */
  async prepareCurrentBranchPlan(
    startHash?: string,
    ontoHash?: string
  ): Promise<RebasePlanInfo> {
    const checkout = await captureRebaseCheckout(this.repoRoot);
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
      await this.assertHeadAncestor(startHash);
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
    await assertRebaseCheckout(this.repoRoot, checkout);
    this.preparedCheckout = checkout;
    return {
      branch,
      checkout,
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
   * @param expectedCheckout 계획 UI가 검증한 checkout. 실행 전 두 안전 경계에서 최신 상태와 대조한다.
   */
  async start(
    base: string,
    root: boolean,
    items: RebaseItem[],
    editorScript: string,
    onto?: string,
    expectedCheckout?: RebaseCheckoutIdentity
  ): Promise<RebaseResult> {
    return withGitStatePathScope(this.repoRoot, () => this.startScoped(base, root, items, editorScript, onto, expectedCheckout));
  }

  /**
   * 한 Start 호출 안에서 검증된 Git 디렉터리와 private 큐 경로만 공유한다.
   * - 매 접근마다 metadata/실행 환경이 같은지 확인하며 HEAD·todo·충돌 파일 내용은 재사용하지 않는다.
   * - 완료·충돌·오류 반환 뒤 scope를 해제하므로 다음 Start/Continue는 현재 경로를 새로 읽는다.
   * @param base/root/items/editorScript/onto/expectedCheckout 공개 Start가 받은 실행 계획과 안전 식별자
   * @returns 실제 native rebase의 완료·정지·충돌 상태
   */
  private async startScoped(
    base: string, root: boolean, items: RebaseItem[], editorScript: string,
    onto?: string, expectedCheckout?: RebaseCheckoutIdentity
  ): Promise<RebaseResult> {
    const context = await readRebaseStartContext(this.repoRoot, expectedCheckout ?? this.preparedCheckout);
    if (context.operation === "rebase") {
      const paused = await this.getPausedEditState();
      const stopped = await this.getStoppedState();
      if (paused) return { status: "paused", paused };
      return await this.hasUnmergedFiles()
        ? { status: "conflicts", stopped }
        : { status: "stopped", stopped };
    }
    if (context.operation !== "none") {
      return { status: "failed", message: `Cannot start rebase while ${context.operation} is in progress.` };
    }
    const checkout = context.checkout;
    const todoItems = items.slice();
    if (todoItems.length === 0) {
      return { status: "noop" };
    }
    const rangeStarted = Date.now(), range = await readLinearRebaseRange(this.repoRoot, base, root);
    logInfo("rebase range metadata read", { repoRoot: this.repoRoot, commits: range.length, elapsedMs: Date.now() - rangeStarted });
    const validation = validateRebaseTodoCoverage(range, todoItems);
    if (!validation.ok) {
      let message = validation.message;
      if (validation.missing.length) {
        // 설명 조회가 다른 HEAD를 보더라도 이미 실패한 coverage를 성공으로 바꾸지 않는다.
        const details = await readRebaseCommits(this.repoRoot, base, root, false);
        if (details.length === range.length && details.every((commit, index) => commit.hash === range[index].hash)) {
          const labeled = validateRebaseTodoCoverage(details, todoItems);
          if (!labeled.ok) message = labeled.message;
        }
      }
      return {
        status: "failed",
        message,
      };
    }
    // 첫 replay 항목은 squash/fixup 대상이 없으므로 pick 으로 보정한다.
    const firstKeptIndex = todoItems.findIndex((item) => item.action !== "drop");
    if (firstKeptIndex >= 0 && (todoItems[firstKeptIndex].action === "squash" || todoItems[firstKeptIndex].action === "fixup")) {
      todoItems[firstKeptIndex] = { ...todoItems[firstKeptIndex], action: "pick" };
    }

    const todoLines: string[] = [];
    const todoStarted = Date.now();
    const opFiles: string[] = [];
    const historyExcludePaths = collectHistoryExcludePaths(items);
    const rewriteItems = todoItems.filter((item) => item.action !== "drop");
    const rewritePlanner = new RebaseFileRewritePlanner(this.repoRoot, rewriteItems, historyExcludePaths, process.execPath, editorScript);
    for (const item of todoItems) {
      todoLines.push(`${item.action} ${item.hash}`);
      const rewrite = await rewritePlanner.execLine(item);
      if (rewrite) {
        opFiles.push(rewrite.opFile);
        todoLines.push(rewrite.line);
      }
    }
    logInfo("rebase todo prepared", { repoRoot: this.repoRoot, items: todoItems.length,
      fileRewriteExecs: opFiles.length, elapsedMs: Date.now() - todoStarted });

    const todoFile = tempPath("todo");
    let keepTempFiles = false;
    let discardInputOnPause = false;
    fs.writeFileSync(todoFile, todoLines.join("\n") + "\n", "utf8");

    try {
      const messageEditorEnv = await initializeRebaseMessageQueue(this.repoRoot, todoItems, editorScript);
      const sequenceEditor = await rebaseSequenceEditor(todoFile, editorScript, process.execPath, this.options.nativeEditors === true);
      logInfo("rebase sequence editor selected", { repoRoot: this.repoRoot, editor: sequenceEditor.kind });
      const env: Record<string, string> = {
        ...messageEditorEnv,
        GIT_SEQUENCE_EDITOR: sequenceEditor.command,
        GSC_TODO: todoFile,
      };
      await assertRebaseCheckout(this.repoRoot, checkout);
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
      discardInputOnPause = sequenceEditor.kind === "copy";
      const paused = await this.getPausedEditState();
      if (paused) {
        keepTempFiles = true;
        return { status: "paused", paused };
      }
      if (await detectOperation(this.repoRoot) === "rebase") {
        keepTempFiles = true;
        return { status: "stopped", stopped: await this.getStoppedState() };
      }
      if (await this.hasUnmergedFiles()) {
        return { status: "conflicts", restoringLocalChanges: true, message: REBASE_RESTORE_CONFLICT_MESSAGE };
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
      // 성공한 번들 복사 뒤의 pause에는 exec 파일만 남긴다. custom helper나 초기 실패의 입력 수명은 보존한다.
      if (!keepTempFiles || discardInputOnPause) safeUnlink(todoFile);
      if (!keepTempFiles) {
        // metadata 교체로 큐 접근이 중단돼도 이 호출이 만든 외부 임시 파일은 반드시 회수한다.
        try { await cleanupRebaseMessageQueue(this.repoRoot); }
        finally { for (const opFile of opFiles) safeUnlink(opFile); }
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
    const operation = await captureGitOperation(this.repoRoot);
    const progress = await readRebaseTodoProgress(this.repoRoot, operation.gitDir).catch(() => undefined);
    const currentAction = progress?.items.find((item) => item.role === "current")?.action;
    if (currentAction !== "edit") {
      return undefined;
    }
    const originalHash = await this.currentOriginalHash(operation.gitDir, Promise.resolve(progress));
    const state = await this.readPausedEditDetails(operation, originalHash);
    await assertGitOperation(this.repoRoot, operation);
    return state;
  }

  /**
   * 복원에 필요한 HEAD·index·todo·정지 위치를 같은 호출의 작업 identity에서 함께 읽는다.
   * - 호출 사이의 캐시는 두지 않으며 설명 조회가 실패해도 정지 위치/진행률은 반환한다.
   * - index 조회 실패는 충돌 없음으로 확정하지 않아 edit 상태를 추정하지 않는다.
   * @param expected 복원 시작 때 확인한 identity. 제공되면 읽기 시작 전에 실제 작업과 재검증한다.
   * @returns 작업이 끝까지 일치한 복원 상태. 읽는 도중 Native Continue/Abort가 바뀌면 실패한다.
   */
  async getRuntimeState(expected?: GitOperationIdentity): Promise<RebaseRuntimeState> {
    const operation = expected ? { ...expected } : await captureGitOperation(this.repoRoot);
    if (expected) await assertGitOperation(this.repoRoot, operation);
    const rebase = operation.operation === "rebase";
    const progressRead = rebase
      ? readRebaseTodoProgress(this.repoRoot, operation.gitDir).catch(() => undefined) : Promise.resolve(undefined);
    /**
     * 각 단계의 index를 독립적으로 읽어 충돌 목록과 조회 성공 여부를 함께 보존한다.
     * @param phase 첫 조회인지 최종 확인인지 나타내는 오류 로그 구분
     * @returns 성공한 경로 목록과 known=true, 실패하면 빈 목록과 known=false
     */
    const readConflicts = (phase: "initial" | "final") => listUnmergedFiles(this.repoRoot).then(files => ({ files, known: true })).catch(error => {
      logError("rebase runtime conflict read failed", error, { repoRoot: this.repoRoot, phase });
      return { files: [] as string[], known: false };
    });
    const [conflicts, progress, originalHash] = await Promise.all([
      readConflicts("initial"), progressRead,
      rebase ? this.currentOriginalHash(operation.gitDir, progressRead) : Promise.resolve(undefined),
    ]);
    let paused: RebasePausedState | undefined;
    if (rebase && conflicts.known && !conflicts.files.length
      && progress?.items.find(item => item.role === "current")?.action === "edit") {
      paused = await this.readPausedEditDetails(operation, originalHash).catch(error => {
        logError("rebase runtime paused details read failed", error, { repoRoot: this.repoRoot });
        return undefined;
      });
    }
    // 파일 metadata를 기다리는 동안 외부 도구가 index를 바꿨을 수 있어 마지막 목록은 새로 확인한다.
    const latest = rebase ? await readConflicts("final") : conflicts;
    if (!latest.known || latest.files.length) paused = undefined;
    await assertGitOperation(this.repoRoot, operation);
    return { operation, conflicts: latest.known ? latest.files : conflicts.files, progress, paused,
      stopped: rebase ? { hash: operation.head, originalHash } : undefined };
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
    return amendRebaseEdit(this.repoRoot, state);
  }

  /**
   * 현재 edit 커밋의 첫 부모와 파일을 같은 metadata 조회에서 읽는다.
   * @param operation 이번 호출에서 실제로 확인한 작업 identity @param originalHash 원래 todo 항목의 OID
   * @returns identity가 포함된 edit 상태. 호출자가 전체 읽기를 마친 뒤 작업 일치를 다시 확인한다.
   */
  private async readPausedEditDetails(operation: GitOperationIdentity, originalHash: string | undefined): Promise<RebasePausedState> {
    const { parent, files } = await readRebaseCommitDetails(this.repoRoot, operation.head);
    return { hash: operation.head, originalHash, parent, files, operation };
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
   * 그래프에서 선택한 커밋이 현재 checkout 브랜치의 HEAD 이력에 포함되는지 확인한다.
   * - 다른 브랜치 커밋의 부모가 우연히 현재 브랜치의 공통 조상이면 `parent..HEAD`가 현재 브랜치
   *   시작 구간 전체로 확장될 수 있으므로, 기준점을 계산하기 전에 선택 커밋 자체를 검증한다.
   * @param hash 그래프 row/node에서 전달된 시작 커밋 해시
   * @throws 선택 커밋이 현재 HEAD의 조상이 아니거나 유효한 커밋으로 확인되지 않을 때
   */
  private async assertHeadAncestor(hash: string): Promise<void> {
    try {
      await runGit(["merge-base", "--is-ancestor", hash, "HEAD"], this.repoRoot);
    } catch {
      throw new Error(
        "The selected commit is not on the checked-out branch. Check out that branch before starting interactive rebase."
      );
    }
  }

  /** rebase 충돌로 unmerged index entry 가 있는지 확인한다. */
  private async hasUnmergedFiles(): Promise<boolean> {
    return (await listUnmergedFiles(this.repoRoot)).length > 0;
  }

  /** 이미 확인한 Git directory가 있으면 경로 조회만 재사용하고 rebase 상태 파일은 새로 읽는다. */
  private async readRebaseStateFile(name: string, knownGitDir?: string): Promise<string | undefined> {
    const gitDir = knownGitDir ?? path.resolve(this.repoRoot, (await runGit(["rev-parse", "--git-dir"], this.repoRoot)).trim());
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      const file = path.join(gitDir, dir, name);
      const value = await fs.promises.readFile(file, "utf8").catch(() => "");
      if (value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  /**
   * stopped-sha가 없으면 같은 호출의 진행률을 공유하거나 새로 읽어 원래 항목을 확인한다.
   * @param knownGitDir 이번 호출에서 확인한 worktree 전용 Git directory
   * @param freshProgress 이번 호출에서 시작한 진행률 조회. 이전 호출의 결과/캐시는 전달하지 않는다.
   * @returns 원래 todo 항목의 OID. 상태 파일과 진행률 모두 없으면 undefined
   */
  private async currentOriginalHash(knownGitDir?: string, freshProgress?: Promise<RebaseTodoProgress | undefined>): Promise<string | undefined> {
    return (await this.readRebaseStateFile("stopped-sha", knownGitDir)) ??
      (await (freshProgress ?? readRebaseTodoProgress(this.repoRoot, knownGitDir).catch(() => undefined)))?.currentHash;
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
