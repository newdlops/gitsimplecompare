// AI 커밋 그룹을 실제 branch ref와 분리된 private detached HEAD에서 일반 `git commit`으로 만든다.
// - objects/config/hooks는 실제 common dir을 공유하지만 HEAD와 index는 임시 경로만 사용한다.
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { CommitPlanFile, CommitPlanGroup } from "../ai/commitPlanModel";
import {
  applyCommitPlanFilesToIndex,
  commitPlanGitEnvironment,
  writeCommitPlanIndexTree,
} from "./aiCommitPlanIndexEntries";
import { runGit } from "./gitExec";
import { safeUnlink, tempIndexPath } from "./gitPatchApply";
import {
  AiCommitPlanError,
  hasExpectedCommitParents,
  invalidCommitPlan,
  type CommitPlanIndexEntry,
} from "./aiCommitPlanSafety";

/** private Git 실행에 필요한 저장소 경로를 모두 명시한 환경이다. */
interface PrivateGitEnvironment extends Record<string, string> {
  GIT_DIR: string;
  GIT_COMMON_DIR: string;
  GIT_WORK_TREE: string;
  GIT_INDEX_FILE: string;
  GIT_SIMPLE_COMPARE_AI_PLAN_PROVISIONAL: "1";
}

/** private commit 한 건의 검증된 hash/tree와 안전한 hook blob 교체 결과다. */
export interface PrivateCommitResult {
  hash: string;
  tree: string;
  hookEntryOverrides: CommitPlanIndexEntry[];
}

/** formatter hook이 내용만 바꿔도 안전하게 허용할 일반 파일 mode다. */
const HOOK_EDITABLE_MODES = new Set(["100644", "100755"]);

/**
 * 실제 저장소의 objects/config/hooks만 공유하고 HEAD/index는 임시 파일로 격리한 commit transaction이다.
 * - 각 `git commit`은 실제 ref를 전혀 움직이지 않으므로 중간 실패나 외부 변경에 rollback이 필요 없다.
 * - 일반 commit 명령과 hook을 그대로 실행해 사용자의 검증 정책을 우회하지 않는다.
 */
export class AiCommitPlanPrivateRepo {
  private closed = false;

  /**
   * 검증된 경로와 시작 HEAD를 보관하는 private transaction을 만든다.
   * 직접 생성 대신 `create`를 사용해야 Git 초기화와 detached HEAD 검증이 보장된다.
   * @param repoRoot 실제 작업트리 루트
   * @param gitDir 임시 private GIT_DIR
   * @param env private HEAD/index와 실제 common objects를 조합한 환경
   * @param currentHead 현재 private detached HEAD
   */
  private constructor(
    public readonly repoRoot: string,
    public readonly gitDir: string,
    public readonly env: PrivateGitEnvironment,
    private currentHead: string
  ) {}

  /**
   * 실제 common dir을 Git에 묻고 임시 bare gitdir의 HEAD를 시작 OID에 detached로 고정한다.
   * - actual symbolic branch ref에는 어떤 쓰기도 하지 않는다.
   * - 최초 커밋 전 저장소는 안전한 private detached 기준점이 없으므로 호출 전에 거부해야 한다.
   * @param repoRoot 실제 Git 작업트리 루트
   * @param initialHead 계획 컨텍스트의 시작 commit OID
   * @returns 초기화와 HEAD/tree 검증이 끝난 transaction
   */
  static async create(
    repoRoot: string,
    initialHead: string
  ): Promise<AiCommitPlanPrivateRepo> {
    const commonDir = await resolveCommonGitDir(repoRoot);
    const gitDir = await mkdtemp(path.join(tmpdir(), "gsc-ai-plan-gitdir-"));
    const indexPath = tempIndexPath();
    const env: PrivateGitEnvironment = commitPlanGitEnvironment({
      GIT_DIR: gitDir,
      GIT_COMMON_DIR: commonDir,
      GIT_WORK_TREE: repoRoot,
      GIT_INDEX_FILE: indexPath,
      // post-commit을 포함한 hook이 provisional 실행을 감지해 외부 부작용을 skip/defer할 수 있게 한다.
      GIT_SIMPLE_COMPARE_AI_PLAN_PROVISIONAL: "1",
    });
    try {
      await runGit(["init", "--bare", "--quiet", gitDir], repoRoot, {
        retryOnLock: false,
      });
      await copyWorktreeConfig(repoRoot, gitDir);
      await runGit(
        ["update-ref", "--no-deref", "HEAD", initialHead],
        repoRoot,
        { env, retryOnLock: false }
      );
      const transaction = new AiCommitPlanPrivateRepo(
        repoRoot,
        gitDir,
        env,
        initialHead
      );
      await transaction.assertPrivateHead(initialHead, "initialization");
      return transaction;
    } catch (error) {
      cleanupPrivateIndex(indexPath);
      await rm(gitDir, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * destination index를 private parent tree에서 시작해 한 그룹 entry만 반영하고 일반 commit을 만든다.
   * - `update-index --index-info -z` stdin을 사용해 path 수/길이가 argv에 들어가지 않는다.
   * - hook이 현재 그룹의 일반 파일 내용만 바꾼 경우 새 blob을 반환하고, 다른 path/type 변경은 거부한다.
   * @param group 검증된 message와 exact current path 목록
   * @param files group path에 대응하는 status/rename 메타데이터
   * @param sourceEntries 실행 시작에 고정한 최종 source index entry map
   * @param zeroOid 저장소 object format 길이의 zero OID
   * @returns parent 연결과 tree가 모두 검증된 private commit
   */
  async commitGroup(
    group: CommitPlanGroup,
    files: readonly CommitPlanFile[],
    sourceEntries: ReadonlyMap<string, CommitPlanIndexEntry>,
    zeroOid: string
  ): Promise<PrivateCommitResult> {
    this.assertOpen();
    const parent = this.currentHead;
    await runGit(["read-tree", parent], this.repoRoot, { env: this.env });
    await applyCommitPlanFilesToIndex(
      this.repoRoot,
      this.env,
      files,
      sourceEntries,
      zeroOid
    );
    await this.assertDestinationHasChanges(group);
    const expectedTree = await writeCommitPlanIndexTree(this.repoRoot, this.env);
    const unsafeHookPaths = await this.readWorktreeMismatchPaths(files);
    await runGit(["commit", "-m", group.message], this.repoRoot, {
      env: this.env,
      retryOnLock: false,
    });
    const createdHead = await this.readPrivateHead();
    await this.assertCommitParent(createdHead, parent);
    const actualTree = await this.readCommitTree(createdHead);
    await this.assertCommitEffects(createdHead, parent, files, sourceEntries);
    const hookEntryOverrides = await this.readAllowedHookEntryOverrides(
      expectedTree,
      actualTree,
      files,
      unsafeHookPaths
    );
    this.currentHead = createdHead;
    return { hash: createdHead, tree: actualTree, hookEntryOverrides };
  }

  /**
   * 현재 private HEAD를 반환한다.
   * @returns 마지막으로 검증한 private commit OID
   */
  get head(): string {
    return this.currentHead;
  }

  /**
   * private index/lock/gitdir를 성공·실패와 관계없이 제거한다.
   * - objects는 실제 common dir에 저장돼 unreachable로 남을 수 있지만 실제 refs/index에는 영향이 없다.
   */
  async dispose(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    cleanupPrivateIndex(this.env.GIT_INDEX_FILE);
    await rm(this.gitDir, { recursive: true, force: true });
  }

  /**
   * destination index가 parent와 다른 entry를 실제로 포함하는지 확인한다.
   * @param group 오류 메시지에 path를 표시할 현재 그룹
   */
  private async assertDestinationHasChanges(group: CommitPlanGroup): Promise<void> {
    const names = await runGit(
      ["diff", "--cached", "--name-only", "-z"],
      this.repoRoot,
      { env: this.env }
    );
    if (!names) {
      throw invalidCommitPlan(
        `AI commit plan group would be empty: ${group.paths.join(", ")}`
      );
    }
  }

  /**
   * hook 직전 실제 worktree가 prepared index와 다른 현재 그룹 path를 찾는다.
   * - staged 파일에 별도 unstaged 편집이 있거나 실행 중 사용자가 파일을 바꾼 경우를 기록한다.
   * - 해당 path의 hook blob 변경을 허용하면 승인하지 않은 worktree 내용까지 `git add`될 수 있어 이후 거부한다.
   * @param files 현재 그룹이 소유한 context 파일
   * @returns prepared index와 worktree 내용/mode가 다른 current path 집합
   */
  private async readWorktreeMismatchPaths(
    files: readonly CommitPlanFile[]
  ): Promise<ReadonlySet<string>> {
    // index-info로 만든 entry는 stat 정보가 비어 있어 내용이 같아도 diff-files가 modified로 볼 수 있다.
    // 다른 그룹의 실제 변경 때문에 refresh가 non-zero여도, 일치한 현재 그룹 entry의 stat 갱신은 보존한다.
    await runGit(["update-index", "--refresh"], this.repoRoot, {
      env: this.env,
      retryOnLock: false,
    }).catch(() => undefined);
    const raw = await runGit(
      ["diff-files", "--name-only", "--no-renames", "-z"],
      this.repoRoot,
      { env: this.env }
    );
    const groupPaths = new Set(files.map((file) => file.path));
    return new Set(
      raw.split("\0").filter((filePath) => groupPaths.has(filePath))
    );
  }

  /**
   * hook 전 prepared tree와 생성 commit tree를 비교해 현재 그룹의 안전한 blob 교체만 추출한다.
   * - 일반 파일의 mode/존재 여부를 유지한 `M`만 허용해 삭제, 추가, symlink/gitlink, chmod를 차단한다.
   * - hook 직전 worktree가 prepared 내용과 달랐던 path는 staged 범위 밖 내용 유입 가능성이 있어 차단한다.
   * @param expectedTree hook 직전 private index tree
   * @param actualTree hook을 거쳐 생성된 commit tree
   * @param files 현재 승인 그룹의 exact current path 메타데이터
   * @param unsafeHookPaths hook 전에 worktree와 prepared index가 달랐던 path
   * @returns publish index에 안전하게 반영할 hook 생성 entry 목록
   */
  private async readAllowedHookEntryOverrides(
    expectedTree: string,
    actualTree: string,
    files: readonly CommitPlanFile[],
    unsafeHookPaths: ReadonlySet<string>
  ): Promise<CommitPlanIndexEntry[]> {
    if (actualTree === expectedTree) {
      return [];
    }
    const raw = await runGit(
      [
        "diff-tree", "--no-commit-id", "--raw", "--full-index",
        "--no-renames", "-r", "-z", expectedTree, actualTree,
      ],
      this.repoRoot,
      { env: this.env }
    );
    const allowedPaths = new Set(files.map((file) => file.path));
    const parsed = parseHookTreeEntryOverrides(raw);
    const rejected = parsed.filter(
      ({ entry, safeContentChange }) =>
        !safeContentChange ||
        !allowedPaths.has(entry.path) ||
        unsafeHookPaths.has(entry.path)
    );
    if (parsed.length === 0 || rejected.length > 0) {
      const paths = rejected
        .map(({ entry, safeContentChange }) => {
          if (!entry.path) {
            return "(unparseable hook change)";
          }
          if (unsafeHookPaths.has(entry.path)) {
            return `${entry.path} (worktree differed before hook)`;
          }
          return safeContentChange ? entry.path : `${entry.path} (non-content change)`;
        })
        .filter(Boolean);
      const detail = paths.length > 0 ? ` Changed paths: ${paths.slice(0, 8).join(", ")}.` : "";
      throw new AiCommitPlanError(
        "commit-tree-mismatch",
        `A commit hook changed content outside the safe current AI plan group.${detail} The real branch and Git index were not changed.`
      );
    }
    return parsed.map(({ entry }) => entry);
  }

  /**
   * private HEAD가 예상 OID와 같은지 확인해 GIT_DIR/GIT_COMMON_DIR 조합 오류를 조기에 잡는다.
   * @param expected 예상 detached HEAD OID
   * @param stage 오류에 표시할 초기화/실행 단계
   */
  private async assertPrivateHead(
    expected: string,
    stage: string
  ): Promise<void> {
    const actual = await this.readPrivateHead();
    if (actual !== expected) {
      throw invalidCommitPlan(
        `Private AI commit HEAD changed unexpectedly during ${stage}.`
      );
    }
  }

  /**
   * private `git commit`이 정확히 직전 private HEAD 하나만 parent로 가졌는지 검사한다.
   * @param commit 새 private commit OID
   * @param expectedParent commit 직전 private HEAD
   */
  private async assertCommitParent(
    commit: string,
    expectedParent: string
  ): Promise<void> {
    const line = (await runGit(
      ["rev-list", "--parents", "-n", "1", commit],
      this.repoRoot,
      { env: this.env }
    )).trim().split(/\s+/);
    if (!hasExpectedCommitParents(line.slice(1), expectedParent)) {
      throw new AiCommitPlanError(
        "commit-tree-mismatch",
        "A commit hook changed the private AI plan HEAD ancestry. The real branch was not changed."
      );
    }
  }

  /**
   * parent→created tree의 실제 changed path 집합이 현재 그룹의 명시적 effect와 정확히 같은지 검사한다.
   * - `update-index`는 file↔directory 충돌에서 입력에 없는 반대쪽 entry를 암묵 제거할 수 있다.
   * - R oldPath가 final source에 없을 때만 제거 effect를 기대하고, 재생성된 oldPath는 다른 그룹에 맡긴다.
   * - 다른 그룹 path가 암묵 변경되면 private commit에서 중단해 실제 branch/index를 publish하지 않는다.
   * @param commit 검증할 새 private commit OID
   * @param parent 직전 private parent OID
   * @param files 현재 그룹이 명시적으로 소유한 context 파일 메타데이터
   * @param sourceEntries frozen 최종 source entry map
   */
  private async assertCommitEffects(
    commit: string,
    parent: string,
    files: readonly CommitPlanFile[],
    sourceEntries: ReadonlyMap<string, CommitPlanIndexEntry>
  ): Promise<void> {
    const raw = await runGit(
      [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "--no-renames",
        "-r",
        "-z",
        parent,
        commit,
      ],
      this.repoRoot,
      { env: this.env }
    );
    const actual = new Set(raw.split("\0").filter(Boolean));
    const expected = expectedCommitEffectPaths(files, sourceEntries);
    if (!samePathSet(actual, expected)) {
      throw new AiCommitPlanError(
        "commit-tree-mismatch",
        "A commit group implicitly changed paths assigned to another AI plan group. The real branch and index were not changed."
      );
    }
  }

  /**
   * private Git 환경에서 HEAD 전체 OID를 읽는다.
   * @returns private detached HEAD commit OID
   */
  private async readPrivateHead(): Promise<string> {
    const head = (await runGit(
      ["rev-parse", "--verify", "HEAD"],
      this.repoRoot,
      { env: this.env }
    )).trim();
    if (!head) {
      throw invalidCommitPlan("Private AI commit transaction lost its HEAD.");
    }
    return head;
  }

  /**
   * 지정 private commit의 tree OID를 읽는다.
   * @param commit private commit OID
   * @returns commit이 가리키는 root tree OID
   */
  private async readCommitTree(commit: string): Promise<string> {
    const tree = (await runGit(
      ["rev-parse", `${commit}^{tree}`],
      this.repoRoot,
      { env: this.env }
    )).trim();
    if (!tree) {
      throw invalidCommitPlan("Private AI commit does not contain a tree.");
    }
    return tree;
  }

  /** transaction 정리 뒤 메서드 재사용을 명시적으로 거부한다. */
  private assertOpen(): void {
    if (this.closed) {
      throw invalidCommitPlan("The private AI commit transaction is already closed.");
    }
  }
}

/**
 * linked worktree를 포함한 실제 objects/config/hooks 공유 디렉터리를 Git에 묻는다.
 * @param repoRoot 실제 작업트리 루트
 * @returns Git이 검증해 반환한 absolute common dir
 */
async function resolveCommonGitDir(repoRoot: string): Promise<string> {
  const raw = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repoRoot
  );
  const commonDir = raw.trim();
  if (!commonDir || !path.isAbsolute(commonDir)) {
    throw invalidCommitPlan("Git did not return an absolute common directory.");
  }
  return path.normalize(commonDir);
}

/**
 * linked worktree의 선택적 `config.worktree`를 private gitdir에 복제한다.
 * - common config의 `extensions.worktreeConfig=true`는 `$GIT_DIR/config.worktree`를 추가로 읽으므로,
 *   이를 생략하면 worktree별 user.name/core.hooksPath 같은 commit 정책이 private 실행에서 달라질 수 있다.
 * - 실제 경로는 `rev-parse --git-path`로 Git에 묻고, 없는 파일만 정상적으로 무시한다.
 * @param repoRoot 실제 작업트리 루트
 * @param privateGitDir 복사 대상 임시 GIT_DIR
 */
async function copyWorktreeConfig(
  repoRoot: string,
  privateGitDir: string
): Promise<void> {
  const raw = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"],
    repoRoot
  );
  const source = raw.trim();
  if (!source || !path.isAbsolute(source)) {
    throw invalidCommitPlan("Git did not return an absolute worktree config path.");
  }
  try {
    await copyFile(source, path.join(privateGitDir, "config.worktree"));
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

/** unknown Node 파일 오류에서 문자열 code만 안전하게 읽는다. */
function fileErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * 무작위 private GIT_INDEX_FILE과 해당 lock을 조용히 정리한다.
 * @param indexPath private destination index 절대 경로
 */
function cleanupPrivateIndex(indexPath: string): void {
  safeUnlink(indexPath);
  safeUnlink(`${indexPath}.lock`);
}

/**
 * 그룹 파일 메타데이터를 명시적으로 허용된 tree effect path 집합으로 바꾼다.
 * @param files 현재 그룹 context 파일
 * @param sourceEntries frozen 최종 source entry map
 * @returns current path와 실제 제거되는 rename oldPath를 포함한 exact 집합
 */
function expectedCommitEffectPaths(
  files: readonly CommitPlanFile[],
  sourceEntries: ReadonlyMap<string, CommitPlanIndexEntry>
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file.path);
    if (
      file.status === "R" &&
      file.oldPath &&
      !sourceEntries.has(file.oldPath)
    ) {
      paths.add(file.oldPath);
    }
  }
  return paths;
}

/**
 * 두 exact Git path 집합이 순서와 무관하게 같은지 검사한다.
 * @param left 실제 diff-tree path 집합
 * @param right context가 허용한 effect path 집합
 * @returns 모든 path가 양쪽에 정확히 존재하면 true
 */
function samePathSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const filePath of left) {
    if (!right.has(filePath)) {
      return false;
    }
  }
  return true;
}

/** hook tree raw diff 한 건과 내용 교체 안전 판정을 함께 보관한다. */
interface ParsedHookTreeOverride {
  entry: CommitPlanIndexEntry;
  safeContentChange: boolean;
}

/**
 * `diff-tree --raw -z`를 hook이 만든 최종 entry 목록으로 파싱한다.
 * - `--no-renames` 출력은 `<header>\0<path>\0` 쌍이므로 특수문자 path도 문자열 분할로 보존한다.
 * - 파싱이 불완전한 record도 안전하지 않은 항목으로 남겨 호출자가 tree 불일치를 반드시 거부하게 한다.
 * @param raw expected tree와 actual tree 사이의 NUL raw diff
 * @returns 새 mode/OID/path와 일반 파일 내용-only 변경 여부
 */
function parseHookTreeEntryOverrides(raw: string): ParsedHookTreeOverride[] {
  const tokens = raw.split("\0");
  if (tokens.at(-1) === "") {
    tokens.pop();
  }
  const results: ParsedHookTreeOverride[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const header = tokens[index] ?? "";
    const filePath = tokens[index + 1] ?? "";
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/.exec(
      header
    );
    const oldMode = match?.[1] ?? "";
    const newMode = match?.[2] ?? "";
    const newOid = match?.[4] ?? "";
    const status = match?.[5] ?? "";
    results.push({
      entry: { path: filePath, mode: newMode, oid: newOid },
      safeContentChange:
        tokens.length % 2 === 0 &&
        Boolean(match) &&
        Boolean(filePath) &&
        status === "M" &&
        oldMode === newMode &&
        HOOK_EDITABLE_MODES.has(newMode),
    });
  }
  return results;
}
