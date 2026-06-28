// git reflog 조회 전용 서비스.
// - 그래프 UI 에서 히스토리 복구 후보를 보여주고, 사용자가 브랜치를 만들어 수동 복구할 수 있게 한다.
import { runGit, runGitWithInput } from "./gitExec";
import {
  directDropSourcesByHash,
  inheritedDropSourcesByHash,
  type ReflogDropSource,
} from "./reflogDropSources";
import {
  readUnreachableCommitRecords,
  type UnreachableCommitRecord,
} from "./unreachableCommitService";

const FS = "\x1f";
const RS = "\0";

/** reflog commit 이 어느 ref reflog 에서 관찰됐는지 나타내는 근거 */
export interface ReflogBranchSource {
  ref: string;
  name: string;
  selector: string;
  message: string;
  dateIso?: string;
  kind: "local" | "remote";
}

/** reflog commit 이 현재 어떤 ref tip 과 정확히 같은지 나타내는 근거 */
export interface ReflogCurrentRef {
  ref: string;
  name: string;
  kind: "local" | "remote" | "tag";
}

/** HEAD reflog 의 checkout 이동 메시지에서 추출한 from/to 정보 */
export interface ReflogCheckoutMove {
  from: string;
  to: string;
}

/** HEAD reflog 한 항목이 나타내는 포인터 이동 전후 commit */
export interface ReflogTransition {
  fromHash?: string;
  toHash: string;
  changed: boolean;
}

/** reflog commit 을 UI 에서 복구 대상으로 쓸 수 있는지 나타내는 상태 */
export interface ReflogRecoveryState {
  kind: "recoverable" | "reachable" | "expired";
  available: boolean;
  reason: string;
}

/** reflog 항목이 현재 브랜치 그래프 흐름과 어떤 관계인지 나타내는 상태 */
export type ReflogFlowStatus = "reachable" | "dropped" | "detached" | "unreachable";

/** recovery 패널에 표시하는 항목이 어떤 git 기록에서 왔는지 나타내는 출처 */
export type ReflogEntrySource = "head" | "unreachable";

/** reflog 메시지를 UI 에서 빠르게 이해할 수 있도록 분류한 이벤트 종류 */
export type ReflogEventKind =
  | "commit"
  | "amend"
  | "rebase"
  | "reset"
  | "checkout"
  | "merge"
  | "pull"
  | "cherryPick"
  | "branch"
  | "unreachable"
  | "other";

/** 그래프 UI 에 표시할 reflog 한 항목 */
export interface ReflogEntry {
  hash: string;
  source: ReflogEntrySource;
  parentHashes?: string[];
  selector: string;
  shortSelector: string;
  message: string;
  dateIso?: string;
  branchSources: ReflogBranchSource[];
  dropSources: ReflogDropSource[];
  currentRefs: ReflogCurrentRef[];
  checkoutMove?: ReflogCheckoutMove;
  transition: ReflogTransition;
  recovery: ReflogRecoveryState;
  flowStatus: ReflogFlowStatus;
  eventKind: ReflogEventKind;
}

interface ParsedReflogRecord {
  hash: string;
  selector: string;
  shortSelector: string;
  message: string;
  dateIso?: string;
}

/** reflog 조회 범위와 느린 복구 보조 정보를 제어하는 옵션 */
export interface ReflogReadOptions {
  limit?: number;
  includeUnreachable?: boolean;
}

/**
 * 저장소의 HEAD reflog 를 최신 항목부터 읽는다.
 * - 기본 경로는 터미널 `git reflog` 처럼 빠르게 보여주기 위해 HEAD reflog 만 읽는다.
 * - dangling/unreachable object 스캔은 대형 저장소에서 매우 비싸므로 사용자가 명시 요청할 때만 포함한다.
 * @param repoRoot 저장소 루트
 * @param input    읽을 최대 항목 수 또는 조회 옵션
 * @returns reflog 항목 배열
 */
export async function readReflogEntries(
  repoRoot: string,
  input: number | ReflogReadOptions = 80
): Promise<ReflogEntry[]> {
  const options = normalizeReadOptions(input);
  const safeLimit = options.limit;
  const [headOut, allOut, currentRefs] = await Promise.all([
    runGit(reflogArgs(safeLimit, "HEAD"), repoRoot),
    options.includeUnreachable
      ? runGit(reflogArgs(Math.max(240, safeLimit * 6), "--all"), repoRoot)
      : Promise.resolve(""),
    options.includeUnreachable
      ? currentTipRefsByHash(repoRoot)
      : Promise.resolve(new Map<string, ReflogCurrentRef[]>()),
  ]);
  const headRecords = parseReflogRecords(headOut);
  const allRecords = parseReflogRecords(allOut);
  const branchSources = branchSourcesByHash(allRecords);
  const directDropSources = directDropSourcesByHash(allRecords);
  const headHashes = new Set(headRecords.map((record) => record.hash));
  const objectRecords = options.includeUnreachable
    ? (await readUnreachableCommitRecords(repoRoot, safeLimit))
      .filter((record) => !headHashes.has(record.hash))
    : [];
  const objectDropSources = inheritedDropSourcesByHash(
    objectRecords,
    directDropSources
  );
  const existingCommits = options.includeUnreachable
    ? await existingCommitsByHash(repoRoot, headRecords.map((record) => record.hash))
    : assumedExistingCommitsByHash(headRecords.map((record) => record.hash));
  return [
    ...headRecords.map((record, index) => headEntryFromRecord(record, index, headRecords, branchSources, directDropSources, currentRefs, existingCommits)),
    ...objectRecords.map((record) => unreachableEntryFromRecord(record, branchSources, objectDropSources, currentRefs)),
  ];
}

/**
 * 호출자가 숫자 limit 만 넘긴 기존 방식과 옵션 객체 방식을 같은 형태로 정규화한다.
 * @param input limit 숫자 또는 세부 조회 옵션
 */
function normalizeReadOptions(input: number | ReflogReadOptions): Required<ReflogReadOptions> {
  const rawLimit = typeof input === "number" ? input : input.limit ?? 80;
  return {
    limit: Math.max(1, Math.floor(rawLimit)),
    includeUnreachable: typeof input === "object" ? Boolean(input.includeUnreachable) : false,
  };
}

/**
 * HEAD reflog record 를 UI 에서 쓰는 복구 항목으로 변환한다.
 * @param record          HEAD reflog 원본 record
 * @param index           HEAD reflog 안에서의 최신순 위치
 * @param headRecords     fromHash 계산에 쓰는 HEAD reflog 전체 목록
 * @param branchSources   같은 commit 을 관찰한 branch reflog 근거
 * @param dropSources     이 commit 이 branch tip 에서 밀려난 reflog 근거
 * @param currentRefs     현재 commit 을 tip 으로 가리키는 ref 근거
 * @param existingCommits commit object 존재 여부 캐시
 */
function headEntryFromRecord(
  record: ParsedReflogRecord,
  index: number,
  headRecords: ParsedReflogRecord[],
  branchSources: Map<string, ReflogBranchSource[]>,
  dropSources: Map<string, ReflogDropSource[]>,
  currentRefs: Map<string, ReflogCurrentRef[]>,
  existingCommits: Map<string, boolean>
): ReflogEntry {
  const sources = branchSources.get(record.hash) || [];
  const refs = currentRefs.get(record.hash) || [];
  const checkoutMove = checkoutMoveFromMessage(record.message);
  const fromHash = headRecords[index + 1]?.hash;
  return {
    ...record,
    source: "head",
    branchSources: sources,
    dropSources: dropSources.get(record.hash) || [],
    currentRefs: refs,
    checkoutMove,
    transition: {
      fromHash,
      toHash: record.hash,
      changed: Boolean(fromHash && fromHash !== record.hash),
    },
    recovery: recoveryStateFor(Boolean(existingCommits.get(record.hash)), refs),
    flowStatus: flowStatusFor(refs, sources),
    eventKind: eventKindFromMessage(record.message),
  };
}

/**
 * reflog 에 직접 나타나지 않는 unreachable commit object 를 복구 항목으로 변환한다.
 * @param record        fsck 로 찾은 commit object record
 * @param branchSources 같은 commit 을 관찰한 branch reflog 근거
 * @param dropSources   이 commit 이 branch 흐름 밖으로 빠진 시점 추정 근거
 * @param currentRefs   현재 commit 을 tip 으로 가리키는 ref 근거
 */
function unreachableEntryFromRecord(
  record: UnreachableCommitRecord,
  branchSources: Map<string, ReflogBranchSource[]>,
  dropSources: Map<string, ReflogDropSource[]>,
  currentRefs: Map<string, ReflogCurrentRef[]>
): ReflogEntry {
  const refs = currentRefs.get(record.hash) || [];
  return {
    hash: record.hash,
    source: "unreachable",
    parentHashes: record.parentHashes,
    selector: `unreachable@{${record.dateIso || record.hash.slice(0, 10)}}`,
    shortSelector: `object:${record.hash.slice(0, 10)}`,
    message: record.message || "Unreachable commit object",
    dateIso: record.dateIso,
    branchSources: branchSources.get(record.hash) || [],
    dropSources: dropSources.get(record.hash) || [],
    currentRefs: refs,
    transition: {
      toHash: record.hash,
      changed: false,
    },
    recovery: recoveryStateFor(true, refs),
    flowStatus: refs.length > 0 ? "reachable" : "unreachable",
    eventKind: "unreachable",
  };
}

/**
 * NUL 로 분리한 reflog 한 행을 구조화한다.
 * @param raw `hash FS selector FS shortSelector FS message` 형태의 원문
 */
function parseReflogEntry(raw: string): ParsedReflogRecord | undefined {
  const [rawHash, rawSelector, rawShortSelector, rawMessage] = raw.split(FS);
  const hash = rawHash?.trim();
  const selector = rawSelector?.trim();
  const shortSelector = rawShortSelector?.trim();
  const message = rawMessage?.trim();
  if (!hash || !selector) {
    return undefined;
  }
  return {
    hash,
    selector,
    shortSelector: shortSelector || selector,
    message: message || "",
    dateIso: dateFromSelector(selector),
  };
}

/**
 * git reflog 출력 전체를 파싱한다.
 * @param out NUL 로 구분된 git reflog 출력
 * @returns 구조화된 reflog record 목록
 */
function parseReflogRecords(out: string): ParsedReflogRecord[] {
  return out
    .split(RS)
    .map(parseReflogEntry)
    .filter((entry): entry is ParsedReflogRecord => Boolean(entry));
}

/**
 * reflog show 명령 인자를 만든다.
 * @param limit 읽을 최대 항목 수
 * @param target HEAD 또는 --all
 */
function reflogArgs(limit: number, target: "HEAD" | "--all"): string[] {
  return [
    "reflog",
    "show",
    target,
    "--date=iso-strict",
    "--format=%H%x1f%gD%x1f%gd%x1f%gs%x00",
    "-n",
    String(limit),
  ];
}

/**
 * --all reflog 에서 commit hash 별 branch ref 근거를 묶는다.
 * @param records git reflog --all 파싱 결과
 */
function branchSourcesByHash(
  records: ParsedReflogRecord[]
): Map<string, ReflogBranchSource[]> {
  const byHash = new Map<string, ReflogBranchSource[]>();
  for (const record of records) {
    const source = branchSourceFromRecord(record);
    if (!source) {
      continue;
    }
    const list = byHash.get(record.hash) || [];
    if (!list.some((item) => item.ref === source.ref && item.selector === source.selector)) {
      list.push(source);
    }
    byHash.set(record.hash, list.slice(0, 6));
  }
  return byHash;
}

/**
 * 현재 local/remote/tag ref tip 을 hash 별로 묶는다.
 * - `--contains=<hash>` 를 항목마다 실행하면 대형 저장소에서 reflog 조회보다 훨씬 느려진다.
 * - 그래서 기본 조회에서는 ref 가 정확히 가리키는 tip 만 한 번에 읽고, ancestor 판정은 그래프 표시/사용자 액션에 맡긴다.
 * @param repoRoot 저장소 루트
 */
async function currentTipRefsByHash(repoRoot: string): Promise<Map<string, ReflogCurrentRef[]>> {
  const result = new Map<string, ReflogCurrentRef[]>();
  try {
    const out = await runGit([
      "for-each-ref",
      "--format=%(objectname)%x1f%(*objectname)%x1f%(refname)%x00",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ], repoRoot, { retryOnLock: false });
    out.split(RS).forEach((raw) => {
      const [objectHash, peeledHash, refName] = raw.split(FS);
      const hash = (peeledHash || objectHash)?.trim();
      const ref = currentRefFromName(refName?.trim() || "");
      if (hash && ref) {
        pushCurrentRef(result, hash, ref);
      }
    });
  } catch {
    return result;
  }
  return result;
}

/**
 * 빠른 기본 조회에서 reflog commit 이 존재한다고 간주하는 캐시를 만든다.
 * - `git reflog --format=%H` 가 성공했다면 UI 표시와 복구 액션은 우선 가능하다고 보고, 실패는 실제 액션에서 처리한다.
 * - object 만료 검증은 사용자가 느린 object 스캔을 요청했을 때 batch-check 로 수행한다.
 * @param hashes HEAD reflog 에서 읽은 commit hash 목록
 */
function assumedExistingCommitsByHash(hashes: string[]): Map<string, boolean> {
  const uniqueHashes = Array.from(new Set(hashes.map((hash) => hash.trim()).filter(Boolean)));
  return new Map(uniqueHashes.map((hash) => [hash, true]));
}

/**
 * reflog commit 객체가 아직 저장소에 남아 있는지 한 번의 batch-check 로 확인한다.
 * @param repoRoot 저장소 루트
 * @param hashes   확인할 reflog commit hash 목록
 */
async function existingCommitsByHash(
  repoRoot: string,
  hashes: string[]
): Promise<Map<string, boolean>> {
  const uniqueHashes = Array.from(new Set(hashes.map((hash) => hash.trim()).filter(Boolean)));
  const result = new Map(uniqueHashes.map((hash) => [hash, true]));
  if (uniqueHashes.length === 0) {
    return result;
  }
  try {
    const input = `${uniqueHashes.map((hash) => `${hash}^{commit}`).join("\n")}\n`;
    const out = await runGitWithInput(
      ["cat-file", "--batch-check=%(objecttype)"],
      repoRoot,
      input,
      { retryOnLock: false }
    );
    const lines = out.split(/\r?\n/);
    uniqueHashes.forEach((hash, index) => {
      result.set(hash, lines[index]?.trim() === "commit");
    });
  } catch {
    uniqueHashes.forEach((hash) => result.set(hash, true));
  }
  return result;
}

/**
 * 현재 ref 포함 여부와 object 존재 여부로 복구 가능 상태를 만든다.
 * @param exists      commit object 존재 여부
 * @param currentRefs 이 commit 을 현재 tip 으로 가리키는 ref 목록
 */
function recoveryStateFor(
  exists: boolean,
  currentRefs: ReflogCurrentRef[]
): ReflogRecoveryState {
  if (!exists) {
    return {
      kind: "expired",
      available: false,
      reason: "Commit object is no longer available in this repository.",
    };
  }
  if (currentRefs.length > 0) {
    return {
      kind: "reachable",
      available: false,
      reason: "Commit is already the tip of an existing ref.",
    };
  }
  return {
    kind: "recoverable",
    available: true,
    reason: "Create a branch at this reflog commit if you need a named restore point.",
  };
}

/**
 * hash 별 ref 목록에 현재 ref 를 중복 없이 추가한다.
 * @param result hash 별 ref 목록
 * @param hash   ref tip commit hash
 * @param ref    추가할 ref 정보
 */
function pushCurrentRef(
  result: Map<string, ReflogCurrentRef[]>,
  hash: string,
  ref: ReflogCurrentRef
): void {
  const refs = dedupeCurrentRefs([...(result.get(hash) || []), ref]).slice(0, 12);
  result.set(hash, refs);
}

/**
 * ref 전체 이름을 UI 표시용 현재 ref 근거로 변환한다.
 * @param ref git ref 전체 이름
 */
function currentRefFromName(ref: string): ReflogCurrentRef | undefined {
  if (ref.startsWith("refs/heads/")) {
    return { ref, name: ref.slice("refs/heads/".length), kind: "local" };
  }
  if (ref.startsWith("refs/remotes/") && !/\/HEAD$/.test(ref)) {
    return { ref, name: ref.slice("refs/remotes/".length), kind: "remote" };
  }
  if (ref.startsWith("refs/tags/")) {
    return { ref, name: ref.slice("refs/tags/".length), kind: "tag" };
  }
  return undefined;
}

/**
 * 같은 ref 가 여러 번 나오는 경우 첫 항목만 남긴다.
 * @param refs 현재 ref 근거 목록
 */
function dedupeCurrentRefs(refs: ReflogCurrentRef[]): ReflogCurrentRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.ref)) {
      return false;
    }
    seen.add(ref.ref);
    return true;
  });
}

/**
 * reflog record 의 selector 에서 local/remote branch 근거를 만든다.
 * @param record reflog record
 */
function branchSourceFromRecord(record: ParsedReflogRecord): ReflogBranchSource | undefined {
  const ref = refFromSelector(record.selector);
  if (!ref) {
    return undefined;
  }
  if (ref.startsWith("refs/heads/")) {
    return {
      ref,
      name: ref.slice("refs/heads/".length),
      selector: record.shortSelector,
      message: record.message,
      dateIso: record.dateIso,
      kind: "local",
    };
  }
  if (ref.startsWith("refs/remotes/")) {
    return {
      ref,
      name: ref.slice("refs/remotes/".length),
      selector: record.shortSelector,
      message: record.message,
      dateIso: record.dateIso,
      kind: "remote",
    };
  }
  return undefined;
}

/**
 * `refs/heads/main@{...}` selector 에서 ref 이름만 분리한다.
 * @param selector reflog selector 문자열
 */
function refFromSelector(selector: string): string | undefined {
  const match = /^(.+)@\{.+\}$/.exec(selector);
  return match?.[1];
}

/**
 * `checkout: moving from A to B` 메시지에서 이동 정보를 추출한다.
 * @param message HEAD reflog 메시지
 */
function checkoutMoveFromMessage(message: string): ReflogCheckoutMove | undefined {
  const match = /^checkout: moving from (.+) to (.+)$/.exec(message);
  if (!match) {
    return undefined;
  }
  return { from: match[1].trim(), to: match[2].trim() };
}

/**
 * 현재 ref 포함 여부와 과거 reflog 근거로 브랜치 흐름 관계를 분류한다.
 * @param currentRefs  현재 이 commit 을 tip 으로 가리키는 ref 목록
 * @param branchSources 과거 branch reflog 에서 관찰된 근거
 */
function flowStatusFor(
  currentRefs: ReflogCurrentRef[],
  branchSources: ReflogBranchSource[]
): ReflogFlowStatus {
  if (currentRefs.length > 0) {
    return "reachable";
  }
  if (branchSources.length > 0) {
    return "dropped";
  }
  return "detached";
}

/**
 * reflog 메시지를 사용자가 판단하기 쉬운 이벤트 종류로 분류한다.
 * @param message HEAD reflog 메시지
 */
function eventKindFromMessage(message: string): ReflogEventKind {
  const text = message.toLowerCase();
  if (text.startsWith("commit (amend):")) {
    return "amend";
  }
  if (text.startsWith("commit")) {
    return "commit";
  }
  if (text.startsWith("rebase")) {
    return "rebase";
  }
  if (text.startsWith("reset:")) {
    return "reset";
  }
  if (text.startsWith("checkout:")) {
    return "checkout";
  }
  if (text.startsWith("merge")) {
    return "merge";
  }
  if (text.startsWith("pull")) {
    return "pull";
  }
  if (text.startsWith("cherry-pick")) {
    return "cherryPick";
  }
  if (text.startsWith("branch:")) {
    return "branch";
  }
  return "other";
}

/**
 * `HEAD@{2026-06-27T17:37:34+09:00}` selector 에서 날짜만 추출한다.
 * @param selector reflog selector 문자열
 */
function dateFromSelector(selector: string): string | undefined {
  const match = /@\{(.+)\}$/.exec(selector);
  return match?.[1];
}
