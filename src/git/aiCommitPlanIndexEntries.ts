// AI 커밋 계획의 frozen source index를 path argv나 patch 분할 없이 그룹 index에 투영한다.
// - stage 0 mode/OID를 NUL `update-index --index-info` 입력으로 전달해 binary, symlink, gitlink를 보존한다.
import { constants as fsConstants } from "node:fs";
import { copyFile } from "node:fs/promises";
import * as path from "node:path";
import type { CommitPlanFile } from "../ai/commitPlanModel";
import { runGit, runGitWithInput } from "./gitExec";
import { safeUnlink } from "./gitPatchApply";
import {
  AiCommitPlanError,
  invalidCommitPlan,
  type CommitPlanIndexEntry,
} from "./aiCommitPlanSafety";

/** source index entry map과 저장소 object format에 맞는 zero OID를 묶는다. */
export interface CommitPlanIndexSnapshot {
  entries: ReadonlyMap<string, CommitPlanIndexEntry>;
  zeroOid: string;
}

/** index-info에서 제거와 추가를 분리해 D/F 충돌을 피하기 위한 내부 변경 집합이다. */
interface IndexEntryMutation {
  removals: string[];
  additions: CommitPlanIndexEntry[];
}

/** Git object format별 object id 길이다. */
const OBJECT_ID_LENGTHS: Readonly<Record<string, number>> = {
  sha1: 40,
  sha256: 64,
};

/** `ls-files --stage`가 반환할 수 있는 정상 stage 0 mode다. */
const INDEX_ENTRY_MODES = new Set([
  "100644",
  "100755",
  "120000",
  "160000",
]);

/**
 * 실제 index의 raw snapshot을 linked-worktree/split-index 호환 sibling 임시 경로에 복제한다.
 * - actual index 경로는 반드시 Git `rev-parse --git-path index`로 찾는다.
 * - split-index의 `sharedindex.*` 참조는 index 파일 디렉터리 기준이므로 OS tmpdir로 옮기지 않는다.
 * - actual index가 아직 없으면 Git이 보는 빈 index를 sibling 경로에 생성한다.
 * @param repoRoot Git 작업트리 루트
 * @returns 호출자가 finally에서 정리해야 하는 sibling GIT_INDEX_FILE 절대 경로
 */
export async function copyRealIndexToSibling(
  repoRoot: string
): Promise<string> {
  const actualIndexPath = await resolveRealGitIndexPath(repoRoot);
  const indexPath = siblingIndexPath(actualIndexPath);
  try {
    await copyFile(actualIndexPath, indexPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") {
      cleanupCommitPlanIndex(indexPath);
      throw error;
    }
    await runGit(["read-tree", "--empty"], repoRoot, {
      env: { GIT_INDEX_FILE: indexPath },
    });
  }
  return indexPath;
}

/**
 * linked worktree까지 반영한 실제 index 절대 경로를 Git 자체 경로 해석으로 읽는다.
 * @param repoRoot Git 작업트리 루트
 * @returns 검증된 actual index 절대 경로
 */
export async function resolveRealGitIndexPath(repoRoot: string): Promise<string> {
  const [insideRaw, indexRaw] = await Promise.all([
    runGit(["rev-parse", "--is-inside-work-tree"], repoRoot),
    runGit(
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      repoRoot
    ),
  ]);
  if (insideRaw.trim() !== "true") {
    throw invalidCommitPlan("AI commit plans require a Git working tree.");
  }
  const indexPath = singleGitOutputLine(indexRaw, "Git index path");
  if (!path.isAbsolute(indexPath)) {
    throw invalidCommitPlan("Git did not return an absolute index path.");
  }
  return path.normalize(indexPath);
}

/**
 * 이 기능이 만든 sibling/temp index와 해당 Git lock만 조용히 정리한다.
 * @param indexPath 무작위 전용 GIT_INDEX_FILE 경로
 */
export function cleanupCommitPlanIndex(indexPath: string): void {
  safeUnlink(indexPath);
  safeUnlink(`${indexPath}.lock`);
}

/**
 * 선택된 index의 모든 stage 0 entry를 path 기준 map으로 읽는다.
 * - 경로 인자를 Git argv에 나열하지 않고 한 번의 NUL 출력으로 읽어 ARG_MAX 영향을 없앤다.
 * - 충돌 stage가 섞이면 계획 전제와 다르므로 실행 전에 명시적으로 거부한다.
 * @param repoRoot Git 저장소 루트
 * @param env source/destination GIT_INDEX_FILE을 담은 선택 환경
 * @returns path→mode/OID map과 삭제 record용 zero OID
 */
export async function readCommitPlanIndexSnapshot(
  repoRoot: string,
  env?: Record<string, string>
): Promise<CommitPlanIndexSnapshot> {
  const options = env ? { env } : undefined;
  const [rawEntries, objectFormatRaw] = await Promise.all([
    runGit(["ls-files", "--stage", "-z"], repoRoot, options),
    runGit(["rev-parse", "--show-object-format"], repoRoot, options),
  ]);
  const objectFormat = objectFormatRaw.trim();
  const objectIdLength = OBJECT_ID_LENGTHS[objectFormat];
  if (!objectIdLength) {
    throw invalidCommitPlan(
      `Unsupported Git object format for AI commit planning: ${objectFormat}`
    );
  }
  return {
    entries: parseStageZeroEntries(rawEntries, objectIdLength),
    zeroOid: "0".repeat(objectIdLength),
  };
}

/**
 * 한 계획 그룹의 최종 source entry만 현재 destination index에 반영한다.
 * - M/A/T/C는 current path entry를 복사하고, D는 current path를 제거한다.
 * - R은 oldPath를 먼저 제거하고 current entry를 추가하며, C는 oldPath를 유지한다.
 * - 전체 NUL 입력을 stdin으로 보내므로 파일 수나 특수문자가 process argv 크기에 영향을 주지 않는다.
 * @param repoRoot Git 저장소 루트
 * @param env 수정할 destination GIT_INDEX_FILE 환경
 * @param files 그룹 path에 대응하는 검증된 context 파일 메타데이터
 * @param sourceEntries frozen source index의 전체 entry map
 * @param zeroOid 저장소 hash 형식 길이에 맞춘 all-zero object id
 */
export async function applyCommitPlanFilesToIndex(
  repoRoot: string,
  env: Record<string, string>,
  files: readonly CommitPlanFile[],
  sourceEntries: ReadonlyMap<string, CommitPlanIndexEntry>,
  zeroOid: string
): Promise<void> {
  const mutation = collectIndexEntryMutation(files, sourceEntries);
  const input = serializeIndexInfo(mutation, zeroOid);
  if (!input) {
    throw invalidCommitPlan("A commit group does not change any Git index entries.");
  }
  await runGitWithInput(
    ["update-index", "-z", "--index-info"],
    repoRoot,
    input,
    { env }
  );
}

/**
 * 실제 staged binary diff를 HEAD 기반 임시 source index에 적용한다.
 * - 실제 index를 `write-tree`로 복제하지 않아 intent-to-add나 scope 밖 index flags에 영향받지 않는다.
 * - patch는 path argv가 아니라 stdin으로 전달하며, snapshot에 사용한 full binary diff를 그대로 재사용한다.
 * @param repoRoot Git 저장소 루트
 * @param env HEAD tree로 초기화된 source GIT_INDEX_FILE 환경
 * @param binaryDiff 실제 index와 HEAD 사이의 full binary cached diff
 */
export async function applyFrozenBinaryDiffToIndex(
  repoRoot: string,
  env: Record<string, string>,
  binaryDiff: Uint8Array
): Promise<void> {
  if (binaryDiff.byteLength === 0) {
    throw invalidCommitPlan("The staged AI commit plan source diff is empty.");
  }
  await runGitWithInput(
    ["apply", "--cached", "--binary", "--whitespace=nowarn"],
    repoRoot,
    binaryDiff,
    { env }
  );
}

/**
 * 계획 그룹 path를 context의 정확한 현재 path 메타데이터로 바꾼다.
 * - 실행 전 allowlist 검증을 통과했더라도 호출부 실수를 조용히 무시하지 않는다.
 * @param paths 검증된 그룹 current path 목록
 * @param filesByPath 전체 context의 current path map
 * @returns 입력 순서를 유지한 파일 메타데이터 배열
 */
export function commitPlanFilesForPaths(
  paths: readonly string[],
  filesByPath: ReadonlyMap<string, CommitPlanFile>
): CommitPlanFile[] {
  return paths.map((filePath) => {
    const file = filesByPath.get(filePath);
    if (!file) {
      throw invalidCommitPlan(`Missing Git metadata for planned path: ${filePath}`);
    }
    return file;
  });
}

/**
 * frozen source entry map이 context의 추가/수정/삭제 전제를 모두 만족하는지 확인한다.
 * - 삭제는 source에 current entry가 없어야 하고 나머지 상태는 정확한 current entry가 있어야 한다.
 * - rename oldPath는 최종 source에 재사용된 entry가 없을 때만 제거 대상이며, 재사용은 정상으로 허용한다.
 * @param files 현재 scope의 전체 context 파일 메타데이터
 * @param sourceEntries 실행 시작에 고정한 최종 source entry map
 */
export function assertCommitPlanSourceEntries(
  files: readonly CommitPlanFile[],
  sourceEntries: ReadonlyMap<string, CommitPlanIndexEntry>
): void {
  for (const file of files) {
    const entry = sourceEntries.get(file.path);
    if (file.status === "D") {
      if (entry) {
        throw invalidCommitPlan(
          `Frozen source unexpectedly retains deleted path: ${file.path}`
        );
      }
      continue;
    }
    if (!entry) {
      throw invalidCommitPlan(
        `Frozen source is missing changed path: ${file.path}`
      );
    }
    if (entry.path !== file.path) {
      throw invalidCommitPlan(
        `Frozen source path metadata does not match context: ${file.path}`
      );
    }
  }
}

/**
 * index가 나타내는 tree id를 Git으로 계산한다.
 * - 호출자는 그룹 commit 전 기대 tree와 최종 실제 index tree 검증에 같은 함수를 재사용한다.
 * @param repoRoot Git 저장소 루트
 * @param env 검사할 GIT_INDEX_FILE 환경
 * @returns 전체 tree object id
 */
export async function writeCommitPlanIndexTree(
  repoRoot: string,
  env: Record<string, string>
): Promise<string> {
  const tree = (await runGit(["write-tree"], repoRoot, { env })).trim();
  if (!tree) {
    throw invalidCommitPlan("Git did not create a tree from the AI commit plan index.");
  }
  return tree;
}

/**
 * NUL `ls-files --stage` 원문을 stage 0 entry map으로 파싱한다.
 * @param raw `<mode> <oid> <stage>\t<path>\0` record 목록
 * @param objectIdLength 현재 저장소 SHA-1/SHA-256 OID 길이
 * @returns exact path를 key로 쓰는 entry map
 */
function parseStageZeroEntries(
  raw: string,
  objectIdLength: number
): ReadonlyMap<string, CommitPlanIndexEntry> {
  const entries = new Map<string, CommitPlanIndexEntry>();
  for (const record of raw.split("\0")) {
    if (!record) {
      continue;
    }
    const tab = record.indexOf("\t");
    const fields = tab >= 0 ? record.slice(0, tab).split(" ") : [];
    const filePath = tab >= 0 ? record.slice(tab + 1) : "";
    if (
      fields.length !== 3 ||
      !INDEX_ENTRY_MODES.has(fields[0]) ||
      !isObjectId(fields[1], objectIdLength) ||
      fields[2] !== "0" ||
      !filePath
    ) {
      throw new AiCommitPlanError(
        "invalid-plan",
        "The Git index contains an unsupported or conflicted entry for AI commit planning."
      );
    }
    if (entries.has(filePath)) {
      throw invalidCommitPlan(`The Git index contains duplicate path metadata: ${filePath}`);
    }
    entries.set(filePath, {
      path: filePath,
      mode: fields[0],
      oid: fields[1],
    });
  }
  return entries;
}

/**
 * 파일 상태와 frozen source를 제거 path 및 추가/교체 entry로 변환한다.
 * - rename oldPath가 최종 source에서 재사용되면 제거하지 않아 그룹 순서와 무관하게 그 entry를 보존한다.
 * - 모든 실제 제거를 추가보다 먼저 직렬화해 `dir`↔`dir/file` 전환의 index D/F 충돌을 최소화한다.
 * @param files 한 그룹 또는 전체 context 파일 메타데이터
 * @param sourceEntries frozen 최종 source index entry map
 * @returns 중복 제거된 removals/additions
 */
function collectIndexEntryMutation(
  files: readonly CommitPlanFile[],
  sourceEntries: ReadonlyMap<string, CommitPlanIndexEntry>
): IndexEntryMutation {
  const removals = new Set<string>();
  const additions = new Map<string, CommitPlanIndexEntry>();
  for (const file of files) {
    if (
      file.status === "R" &&
      file.oldPath &&
      !sourceEntries.has(file.oldPath)
    ) {
      removals.add(file.oldPath);
    }
    if (file.status === "D") {
      removals.add(file.path);
      continue;
    }
    const entry = sourceEntries.get(file.path);
    if (!entry) {
      throw invalidCommitPlan(
        `Frozen Git index entry is missing for planned path: ${file.path}`
      );
    }
    additions.set(file.path, entry);
  }
  return {
    removals: [...removals],
    additions: [...additions.values()],
  };
}

/**
 * 제거와 추가 mutation을 `update-index -z --index-info` stdin 형식으로 직렬화한다.
 * - path는 NUL로 끝나므로 공백, 탭, 개행, glob 문자를 quoting 없이 그대로 보존한다.
 * @param mutation 제거 path와 source entry 목록
 * @param zeroOid 현재 object format 길이의 zero OID
 * @returns NUL로 끝나는 index-info 원문
 */
function serializeIndexInfo(
  mutation: IndexEntryMutation,
  zeroOid: string
): string {
  const records = [
    ...mutation.removals.map((filePath) => `0 ${zeroOid}\t${filePath}\0`),
    ...mutation.additions.map(
      (entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`
    ),
  ];
  return records.join("");
}

/**
 * Git object id가 현재 저장소 형식 길이의 lowercase hex인지 검사한다.
 * @param value ls-files가 반환한 OID
 * @param expectedLength SHA-1은 40, SHA-256은 64
 * @returns entry에 안전하게 재사용할 수 있으면 true
 */
function isObjectId(value: string, expectedLength: number): boolean {
  return value.length === expectedLength && /^[0-9a-f]+$/.test(value);
}

/**
 * actual index와 같은 디렉터리에 충돌 가능성이 낮은 snapshot 경로를 만든다.
 * @param actualIndexPath Git이 반환한 actual index 절대 경로
 * @returns split-index 상대 참조를 유지하는 sibling 경로
 */
function siblingIndexPath(actualIndexPath: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(
    path.dirname(actualIndexPath),
    `${path.basename(actualIndexPath)}.gsc-ai-source-${suffix}`
  );
}

/**
 * Git 단일 행 출력에서 끝 개행만 제거하고 경로의 유효한 앞뒤 공백은 보존한다.
 * @param raw runGit 표준 출력
 * @param label 오류에 표시할 값 이름
 * @returns 검증된 단일 행
 */
function singleGitOutputLine(raw: string, label: string): string {
  const value = raw.replace(/\r?\n$/, "");
  if (!value || value.includes("\n") || value.includes("\0")) {
    throw invalidCommitPlan(`Git returned an invalid ${label}.`);
  }
  return value;
}

/**
 * unknown Node 파일 오류에서 문자열 code만 안전하게 읽는다.
 * @param error fs API가 던진 임의 오류
 * @returns ENOENT/EEXIST 같은 code 또는 undefined
 */
function fileErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
