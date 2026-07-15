// 충돌 파일의 index stage와 작업트리 내용을 원본 보존 방식으로 읽고 적용한다.
// - commit/operation 의미는 다루지 않고, mode/OID/바이트/경로 안전성과 해결 mutation만 책임진다.
// - 모든 경로 인자는 literal pathspec으로 취급해 특수 파일명이 다른 파일까지 확장되지 않게 한다.
import * as fs from "node:fs";
import * as path from "node:path";
import { unmergedSourceVersion } from "./conflictContentIdentity";
import { resolveConflictRegularFileMode } from "./conflictFileMode";
import { withConflictIndexTransaction } from "./conflictIndexTransaction";
import {
  claimConflictWorkingLeaf,
  readConflictWorkingLeaf,
  type ConflictDesiredLeaf,
  type ConflictWorktreeClaim,
} from "./conflictWorktreeCas";
import { runGit, runGitBuffer, runGitWithInput } from "./gitExec";

/** 충돌 stage나 작업 파일 내용을 UI가 안전하게 다룰 수 있도록 분류한 종류다. */
export type ConflictContentKind =
  | "text"
  | "binary"
  | "submodule"
  | "symlink"
  | "nonfile"
  | "absent";

/** git index의 stage 1/2/3 한쪽 내용과 객체 식별 정보다. */
export interface ConflictContentSide {
  stage: 1 | 2 | 3;
  exists: boolean;
  kind: ConflictContentKind;
  oid?: string;
  mode?: string;
  truncated?: boolean;
  content: string;
}

/** 사용자가 편집할 작업트리 Result의 존재/내용 상태다. */
export interface ConflictResultState {
  exists: boolean;
  kind: ConflictContentKind;
  oid?: string;
  mode?: string;
  truncated?: boolean;
}

/** 작업트리 Result의 표시 문자열과 안전 분류다. */
export interface ConflictWorkingResult {
  content: string;
  state: ConflictResultState;
  version: string;
}

/** 한 충돌 파일의 세 stage와 작업트리 미리보기다. */
export interface ConflictContentDocument {
  base: ConflictContentSide;
  current: ConflictContentSide;
  incoming: ConflictContentSide;
  result: string;
  resultState: ConflictResultState;
  sourceVersion: string;
  resultVersion: string;
  both: string;
  bothAvailable: boolean;
}

/** index 한 항목의 mode/blob 식별자다. */
interface IndexEntry {
  mode: string;
  oid: string;
}

/** `git ls-files --unmerged` 한 stage의 mode/blob 식별자다. */
interface UnmergedStageEntry extends IndexEntry {
  stage: 1 | 2 | 3;
}

/** marker 기반 Accept Both 파싱 결과다. */
interface BothParseResult {
  valid: boolean;
  changed: boolean;
  content: string;
}

const MAX_CONFLICT_TEXT_BYTES = 512 * 1024;
const LITERAL_PATH_ENV = { GIT_LITERAL_PATHSPECS: "1" };

/**
 * 한 저장소의 conflict stage/working-result 바이트를 안전하게 다루는 서비스다.
 */
export class ConflictContentService {
  constructor(public readonly repoRoot: string) {}

  /**
   * 세 index stage와 작업트리 Result를 한 번에 읽는다.
   * @param rel 저장소 상대 충돌 경로
   * @returns source commit 정보가 제외된 콘텐츠 문서
   */
  async readDocument(
    rel: string,
    fullResult = false
  ): Promise<ConflictContentDocument> {
    this.assertRelativePath(rel);
    const [entries, forcedBinary] = await Promise.all([
      this.readUnmergedStages(rel),
      this.isDiffDisabled(rel),
    ]);
    this.assertStillConflicted(entries);
    const [base, current, incoming, result] = await Promise.all([
      this.readStage(1, entries, forcedBinary),
      this.readStage(2, entries, forcedBinary),
      this.readStage(3, entries, forcedBinary),
      this.readWorkingResult(
        rel,
        forcedBinary,
        !fullResult,
        [...entries.values()].some((entry) => entry.mode === "160000")
      ),
    ]);
    const both = this.bothPreview(current, incoming, result);
    return {
      base,
      current,
      incoming,
      result: result.content,
      resultState: result.state,
      sourceVersion: unmergedSourceVersion(entries),
      resultVersion: result.version,
      both: both.content,
      bothAvailable: both.available,
    };
  }

  /**
   * mutation 이후 실제 작업트리 Result 상태만 다시 읽는다.
   * @param rel 저장소 상대 경로
   * @returns 해소된 파일의 현재 표시 상태
   */
  async readResult(
    rel: string,
    fullResult = false
  ): Promise<ConflictWorkingResult> {
    this.assertRelativePath(rel);
    return this.readWorkingResult(
      rel,
      await this.isDiffDisabled(rel),
      !fullResult
    );
  }

  /**
   * 아직 unmerged인 파일의 현재 작업트리 version을 전체 바이트 기준으로 다시 읽는다.
   * @param rel 저장소 상대 충돌 경로
   * @returns 패널 load 이후 외부 변경 여부를 비교할 opaque version
   */
  async readUnresolvedResultVersion(rel: string): Promise<string> {
    this.assertRelativePath(rel);
    const entries = await this.readUnmergedStages(rel);
    this.assertStillConflicted(entries);
    const forcedBinary = await this.isDiffDisabled(rel);
    return (await this.readWorkingResult(
      rel, forcedBinary, false, [...entries.values()].some((entry) => entry.mode === "160000")
    )).version;
  }

  /**
   * 선택한 Current/Incoming stage의 mode와 OID를 index에 정확히 기록한다.
   * - submodule은 worktree HEAD를 `git add`하지 않고 cacheinfo를 직접 기록한다.
   * - 삭제 side는 일반 파일/링크만 제거하며 디렉터리와 submodule worktree는 보존한다.
   * @param rel 저장소 상대 충돌 경로
   * @param stage 2는 Current/Ours, 3은 Incoming/Theirs
   * @returns claim 뒤 원본에 동시 편집이 들어왔으면 보존한 recovery 경로
   */
  async takeStage(
    rel: string,
    stage: 2 | 3,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<string | undefined> {
    this.assertRelativePath(rel);
    const absolute = await this.safeWorkingPath(rel);
    let claim: ConflictWorktreeClaim | undefined;
    try {
      await this.withLockedMutation(rel, expectedSourceVersion, true, async (entries, indexEnv) => {
        const entry = entries.get(stage);
        const current = await readConflictWorkingLeaf(absolute);
        this.assertMatchingVersion(current.version, expectedVersion);
        if (entry?.mode === "160000" || (!entry && current.kind === "nonfile")) {
          await this.updateExactIndexEntry(rel, entry, indexEnv);
          return;
        }
        if (current.kind === "nonfile") throw new Error("Manual Result editing is not available for symlink, directory, or other non-regular file conflicts.");
        claim = await claimConflictWorkingLeaf(absolute, current.version);
        await claim.install(await this.desiredStageLeaf(rel, entry));
        await this.updateExactIndexEntry(rel, entry, indexEnv);
      });
    } catch (error) {
      await this.rollbackClaim(claim, error);
    }
    return claim?.commit();
  }

  /**
   * 완전한 text conflict marker가 있는 경우에만 양쪽 블록을 보존해 해결한다.
   * @param rel 저장소 상대 충돌 경로
   * @returns 동시 편집 원본을 별도 보존했으면 recovery 경로
   */
  async acceptBoth(
    rel: string,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<string | undefined> {
    this.assertRelativePath(rel);
    const [entries, forcedBinary] = await Promise.all([
      this.readUnmergedStages(rel),
      this.isDiffDisabled(rel),
    ]);
    this.assertStillConflicted(entries);
    this.assertSourceVersion(entries, expectedSourceVersion);
    const sourceVersion = expectedSourceVersion ?? unmergedSourceVersion(entries);
    const [current, incoming, result] = await Promise.all([
      this.readStage(2, entries, forcedBinary, false),
      this.readStage(3, entries, forcedBinary, false),
      this.readWorkingResult(rel, forcedBinary, false),
    ]);
    if (!current.exists || !incoming.exists || current.kind !== "text" || incoming.kind !== "text") {
      throw new Error("Accept Both requires two text conflict sides.");
    }
    if (result.state.kind !== "text") {
      throw new Error("Accept Both requires a text working-tree Result.");
    }
    this.assertMatchingVersion(result.version, expectedVersion);
    const parsed = acceptBothFromMarkers(result.content);
    if (!parsed.valid || !parsed.changed) {
      throw new Error("Accept Both requires complete conflict marker blocks.");
    }
    return this.writeResolvedContent(rel, parsed.content, true, result.version, sourceVersion);
  }

  /**
   * 사용자가 편집한 Result를 안전한 일반 파일 경로에 저장한다.
   * @param rel 저장소 상대 충돌 경로
   * @param content 저장할 UTF-8 Result
   * @param markResolved true면 저장 직후 stage 0으로 해결 처리한다
   * @returns 동시 편집 원본을 별도 보존했으면 recovery 경로
   */
  async writeResolvedContent(
    rel: string,
    content: string,
    markResolved = false,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<string | undefined> {
    this.assertRelativePath(rel);
    const absolute = await this.safeWorkingPath(rel);
    const buffer = Buffer.from(content, "utf8");
    let claim: ConflictWorktreeClaim | undefined;
    try {
      await this.withLockedMutation(rel, expectedSourceVersion, markResolved, async (entries, indexEnv) => {
        claim = await claimConflictWorkingLeaf(absolute, expectedVersion);
        if (claim.snapshot.kind !== "regular" && claim.snapshot.kind !== "absent") {
          throw new Error("Manual Result editing is not available for symlink, directory, or other non-regular file conflicts.");
        }
        const mode = await resolveConflictRegularFileMode(this.repoRoot, entries, claim.snapshot.mode);
        await claim.install({ kind: "regular", buffer, mode });
        if (markResolved) await this.stageExactBuffer(rel, buffer, mode, indexEnv);
      });
    } catch (error) {
      await this.rollbackClaim(claim, error);
    }
    return claim?.commit();
  }

  /**
   * 이미 해결된 native virtual 문서의 일반 파일 내용을 index 변경 없이 CAS 저장한다.
   * - leaf를 먼저 격리하고 symlink/nonfile 전이를 거부해 VS Code save가 링크 대상을 따라가지 않는다.
   * @param rel 저장소 상대 경로
   * @param content 저장할 UTF-8 text
   * @param expectedVersion 편집기가 마지막으로 읽은 작업트리 version
   * @returns 좁은 동시 writer 경합으로 원본을 보존한 recovery 경로
   */
  async writeWorkingContent(
    rel: string,
    content: string,
    expectedVersion?: string
  ): Promise<string | undefined> {
    this.assertRelativePath(rel);
    const absolute = await this.safeWorkingPath(rel);
    const buffer = Buffer.from(content, "utf8");
    let claim: ConflictWorktreeClaim | undefined;
    try {
      claim = await claimConflictWorkingLeaf(absolute, expectedVersion);
      if (claim.snapshot.kind !== "regular" && claim.snapshot.kind !== "absent") {
        throw new Error("Manual Result editing is not available for symlink, directory, or other non-regular file conflicts.");
      }
      const executable = claim.snapshot.kind === "regular" &&
        claim.snapshot.mode !== undefined && (claim.snapshot.mode & 0o100) !== 0;
      await claim.install({
        kind: "regular",
        buffer,
        mode: executable ? "100755" : "100644",
      });
    } catch (error) {
      await this.rollbackClaim(claim, error);
    }
    return claim?.commit();
  }
  /**
   * 현재 작업트리 상태를 stage 0으로 기록해 충돌을 해결한다.
   * @param rel 저장소 상대 충돌 경로
   */
  async markResolved(
    rel: string,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<void> {
    this.assertRelativePath(rel);
    const absolute = await this.safeWorkingPath(rel);
    await this.withLockedMutation(rel, expectedSourceVersion, true, async (entries, indexEnv) => {
      const snapshot = await readConflictWorkingLeaf(absolute);
      this.assertMatchingVersion(snapshot.version, expectedVersion);
      if (snapshot.kind === "nonfile") {
        throw new Error("Manual Result editing is not available for symlink, directory, or other non-regular file conflicts.");
      }
      if (snapshot.kind === "absent") {
        await this.updateExactIndexEntry(rel, undefined, indexEnv);
        return;
      }
      const mode = snapshot.kind === "symlink"
        ? "120000"
        : await resolveConflictRegularFileMode(this.repoRoot, entries, snapshot.mode);
      await this.stageExactBuffer(rel, snapshot.buffer!, mode, indexEnv);
    });
  }
  /** 저장소 상대 경로를 검증한 절대 경로로 바꾼다. */
  absPath(rel: string): string {
    this.assertRelativePath(rel);
    return path.resolve(this.repoRoot, rel);
  }
  /** index stage 객체를 text/binary/submodule/symlink/absent로 분류한다. */
  private async readStage(
    stage: 1 | 2 | 3,
    entries: Map<1 | 2 | 3, UnmergedStageEntry>,
    forcedBinary: boolean,
    truncate = true
  ): Promise<ConflictContentSide> {
    const entry = entries.get(stage);
    if (!entry) return { stage, exists: false, kind: "absent", content: "" };
    if (entry.mode === "160000") {
      return { stage, exists: true, kind: "submodule", oid: entry.oid, mode: entry.mode, content: "" };
    }
    const buffer = await runGitBuffer(["cat-file", "blob", entry.oid], this.repoRoot);
    if (entry.mode === "120000") {
      return {
        stage, exists: true, kind: "symlink", oid: entry.oid, mode: entry.mode,
        content: decodeUtf8(buffer) || "",
      };
    }
    const decoded = forcedBinary ? undefined : decodeUtf8(buffer);
    const truncated = decoded !== undefined && truncate && buffer.length > MAX_CONFLICT_TEXT_BYTES;
    return {
      stage,
      exists: true,
      kind: decoded === undefined ? "binary" : "text",
      oid: entry.oid,
      mode: entry.mode,
      truncated: truncated || undefined,
      content: decoded === undefined
        ? ""
        : truncated
          ? buffer.subarray(0, MAX_CONFLICT_TEXT_BYTES).toString("utf8")
          : decoded,
    };
  }

  /** 작업트리 Result를 링크를 따라가지 않고 읽고 표시 크기만 제한한다. */
  private async readWorkingResult(
    rel: string,
    forcedBinary: boolean,
    truncate = true,
    knownSubmodule = false
  ): Promise<ConflictWorkingResult> {
    const absolute = await this.safeWorkingPath(rel);
    const snapshot = await readConflictWorkingLeaf(absolute);
    if (snapshot.kind === "absent") {
      return { content: "", state: { exists: false, kind: "absent" }, version: snapshot.version };
    }
    if (snapshot.kind === "symlink") {
      return {
        content: decodeUtf8(snapshot.buffer!) || "",
        state: { exists: true, kind: "symlink" },
        version: snapshot.version,
      };
    }
    if (snapshot.kind === "nonfile") {
      return {
        content: "",
        state: { exists: true, kind: knownSubmodule ? "submodule" : "nonfile" },
        version: snapshot.version,
      };
    }
    const buffer = snapshot.buffer!;
    const decoded = forcedBinary ? undefined : decodeUtf8(buffer);
    if (decoded === undefined) {
      return { content: "", state: { exists: true, kind: "binary" }, version: snapshot.version };
    }
    const truncated = truncate && buffer.length > MAX_CONFLICT_TEXT_BYTES;
    return {
      content: truncated ? buffer.subarray(0, MAX_CONFLICT_TEXT_BYTES).toString("utf8") : decoded,
      state: { exists: true, kind: "text", truncated: truncated || undefined },
      version: snapshot.version,
    };
  }

  /** unmerged index의 stage 1/2/3 mode와 OID를 NUL 안전 형식으로 읽는다. */
  private async readUnmergedStages(
    rel: string,
    indexEnv: Record<string, string> = {}
  ): Promise<Map<1 | 2 | 3, UnmergedStageEntry>> {
    const raw = await runGit(
      ["ls-files", "--unmerged", "-z", "--", rel],
      this.repoRoot,
      { ...LITERAL_PATH_ENV, ...indexEnv }
    );
    const entries = new Map<1 | 2 | 3, UnmergedStageEntry>();
    for (const record of raw.split("\0")) {
      const match = /^(\d+) ([0-9a-f]{4,64}) ([123])\t/.exec(record);
      if (!match || record.slice(record.indexOf("\t") + 1) !== rel) continue;
      const stage = Number(match[3]) as 1 | 2 | 3;
      entries.set(stage, { stage, mode: match[1], oid: match[2] });
    }
    return entries;
  }

  /** `.gitattributes`의 `-diff`가 현재 경로를 binary로 강제하는지 읽는다. */
  private async isDiffDisabled(rel: string): Promise<boolean> {
    const raw = await runGit(
      ["check-attr", "-z", "diff", "--", rel],
      this.repoRoot,
      LITERAL_PATH_ENV
    ).catch(() => "");
    return raw.split("\0")[2] === "unset";
  }

  /** 미리보기 범위 안에서 완전한 marker가 있고 두 text side가 존재하는지 계산한다. */
  private bothPreview(
    current: ConflictContentSide,
    incoming: ConflictContentSide,
    result: ConflictWorkingResult
  ): { available: boolean; content: string } {
    if (
      !current.exists || !incoming.exists ||
      current.kind !== "text" || incoming.kind !== "text" ||
      current.truncated || incoming.truncated ||
      result.state.kind !== "text" || result.state.truncated
    ) {
      return { available: false, content: "" };
    }
    const parsed = acceptBothFromMarkers(result.content);
    return parsed.valid && parsed.changed
      ? { available: true, content: parsed.content }
      : { available: false, content: "" };
  }

  /** 경로가 저장소 밖으로 탈출하거나 절대 경로가 되는 것을 거부한다. */
  private assertRelativePath(rel: string): void {
    const root = path.resolve(this.repoRoot);
    const absolute = path.resolve(root, rel);
    if (!rel || path.isAbsolute(rel) || (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))) {
      throw new Error("Conflict path must stay inside the repository.");
    }
  }

  /** unmerged stage가 사라진 stale action을 삭제 side로 오인하지 않게 막는다. */
  private assertStillConflicted(entries: Map<1 | 2 | 3, UnmergedStageEntry>): void {
    if (entries.size === 0) throw new Error("This file is no longer conflicted. Reload the conflict editor.");
  }

  /** 표시 당시 stage 1/2/3와 현재 unmerged index가 다르면 오래된 side 선택을 거부한다. */
  private assertSourceVersion(
    entries: Map<1 | 2 | 3, UnmergedStageEntry>,
    expectedVersion: string | undefined
  ): void {
    if (expectedVersion !== undefined && unmergedSourceVersion(entries) !== expectedVersion) {
      throw new Error("The conflict sources changed outside this editor. Reload it before resolving.");
    }
  }

  /** real index snapshot을 고정한 뒤 실제 index.lock 안에서 source를 재검증하고 mutation을 실행한다. */
  private async withLockedMutation<T>(
    rel: string,
    expectedSourceVersion: string | undefined,
    publishIndex: boolean,
    action: (
      entries: Map<1 | 2 | 3, UnmergedStageEntry>,
      indexEnv: Record<string, string>
    ) => Promise<T>
  ): Promise<T> {
    const initial = await this.readUnmergedStages(rel);
    this.assertStillConflicted(initial);
    this.assertSourceVersion(initial, expectedSourceVersion);
    const pinnedVersion = expectedSourceVersion ?? unmergedSourceVersion(initial);
    return withConflictIndexTransaction(this.repoRoot, publishIndex, async ({ indexEnv }) => {
      const entries = await this.readUnmergedStages(rel, indexEnv);
      this.assertStillConflicted(entries);
      this.assertSourceVersion(entries, pinnedVersion);
      return action(entries, indexEnv);
    });
  }

  /** 실제/예상 version이 다르면 호출자가 reload 또는 overwrite를 선택하도록 mutation을 중단한다. */
  private assertMatchingVersion(actual: string, expected: string | undefined): void {
    if (expected !== undefined && actual !== expected) {
      throw new Error("The conflict Result changed outside this editor. Reload it before resolving.");
    }
  }

  /** 선택 stage를 worktree filter가 적용된 exact regular/symlink/absent leaf로 만든다. */
  private async desiredStageLeaf(
    rel: string,
    entry: UnmergedStageEntry | undefined
  ): Promise<ConflictDesiredLeaf> {
    if (!entry) return { kind: "absent" };
    if (entry.mode === "120000") {
      return { kind: "symlink", target: await runGitBuffer(["cat-file", "blob", entry.oid], this.repoRoot) };
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new Error(`Unsupported conflict stage mode: ${entry.mode}`);
    }
    const buffer = await runGitBuffer(
      ["cat-file", "--filters", `--path=${rel}`, entry.oid],
      this.repoRoot
    );
    return { kind: "regular", buffer, mode: entry.mode };
  }

  /** 전달받은 정확한 바이트를 Git filter로 blob화하고 transaction index stage 0에 기록한다. */
  private async stageExactBuffer(
    rel: string,
    buffer: Buffer,
    mode: string,
    indexEnv: Record<string, string>
  ): Promise<void> {
    const args = mode === "120000" ? ["hash-object", "-w", "--stdin"] : ["hash-object", "-w", `--path=${rel}`, "--stdin"];
    const oid = (await runGitWithInput(args, this.repoRoot, buffer, {
      env: indexEnv,
      retryOnLock: false,
    })).trim();
    await runGit(
      ["update-index", "--add", "--cacheinfo", mode, oid, rel],
      this.repoRoot,
      { env: { ...LITERAL_PATH_ENV, ...indexEnv }, retryOnLock: false }
    );
  }

  /** 선택 stage entry 또는 삭제를 transaction index에 정확한 stage 0 결과로 쓴다. */
  private async updateExactIndexEntry(
    rel: string,
    entry: UnmergedStageEntry | undefined,
    indexEnv: Record<string, string>
  ): Promise<void> {
    const args = entry
      ? ["update-index", "--add", "--cacheinfo", entry.mode, entry.oid, rel]
      : ["update-index", "--force-remove", "--", rel];
    await runGit(args, this.repoRoot, {
      env: { ...LITERAL_PATH_ENV, ...indexEnv },
      retryOnLock: false,
    });
  }

  /** index transaction 실패 시 외부 leaf를 덮지 않는 claim rollback을 우선하고 원래 오류를 다시 던진다. */
  private async rollbackClaim(
    claim: ConflictWorktreeClaim | undefined,
    originalError: unknown
  ): Promise<never> {
    if (claim) {
      try {
        await claim.rollback();
      } catch (recoveryError) {
        throw recoveryError;
      }
    }
    throw originalError;
  }

  /** 저장소 루트 자체의 symlink는 허용하되 하위 부모 symlink를 통한 다른 경로 쓰기는 막는다. */
  private async safeWorkingPath(rel: string): Promise<string> {
    const absolute = this.absPath(rel);
    const lexicalRoot = path.resolve(this.repoRoot);
    const lexicalParent = path.dirname(absolute);
    const [root, parent] = await Promise.all([
      fs.promises.realpath(this.repoRoot),
      fs.promises.realpath(lexicalParent),
    ]);
    const expectedParent = path.resolve(
      root,
      path.relative(lexicalRoot, lexicalParent)
    );
    if (parent !== expectedParent) {
      throw new Error("Conflict path parent contains a symbolic link.");
    }
    return absolute;
  }
}

/** NUL과 잘못된 UTF-8을 binary로 분류하면서 유효 text만 원문으로 반환한다. */
function decodeUtf8(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) return undefined;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * 정상 종료된 conflict marker 블록만 Current → Incoming 순서로 합친다.
 * @param raw 작업트리 전체 text
 * @returns 불완전/중첩 marker 여부와 변환 결과
 */
function acceptBothFromMarkers(raw: string): BothParseResult {
  const lines = raw.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const out: string[] = [];
  let mode: "normal" | "current" | "base" | "incoming" = "normal";
  let completed = 0;
  for (const line of lines) {
    if (mode === "normal") {
      if (line.startsWith("<<<<<<<")) mode = "current";
      else out.push(line);
      continue;
    }
    if (line.startsWith("<<<<<<<")) return { valid: false, changed: false, content: raw };
    if (mode === "current" && line.startsWith("|||||||")) {
      mode = "base";
    } else if ((mode === "current" || mode === "base") && line.startsWith("=======")) {
      mode = "incoming";
    } else if (mode === "incoming" && line.startsWith(">>>>>>>")) {
      mode = "normal";
      completed++;
    } else if (line.startsWith("|||||||") || line.startsWith("=======") || line.startsWith(">>>>>>>")) {
      return { valid: false, changed: false, content: raw };
    } else if (mode !== "base") {
      out.push(line);
    }
  }
  const valid = mode === "normal" && completed > 0;
  return { valid, changed: valid, content: valid ? out.join("") : raw };
}
