// 한 줄의 마지막 변경 commit을 고정해 Git line-log 한 번으로 필요한 이력만 조회한다.
import path from "node:path";
import { runGit } from "./gitExec";
import { GitBlameService } from "./blameService";
import { EMPTY_TREE_REF } from "./fileHistoryService";
import { decodeGitQuotedPath } from "../utils/gitQuotedPath";
import { logInfo } from "../ui/outputLog";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MARKER = "\0GSC_LINE_HISTORY_V1\0";
const FORMAT = "--format=%x00GSC_LINE_HISTORY_V1%x00%H%x00%P%x00%an%x00%aI%x00%s%x00";

/** 파일 이름이나 줄 위치가 달라져도 같은 변경 이력을 조회하는 불변 시작점이다. */
export interface LineHistoryAnchor { hash: string; path: string; line: number }
/** 줄 이력에서 선택한 commit의 파일 diff를 여는 데 필요한 최소 정보다. */
export interface LineHistoryEntry {
  hash: string; baseRef: string; author: string; dateIso: string; title: string;
  path: string; oldPath?: string; line: number;
}
/** 첫 페이지와 이후 추가 조회가 같은 anchor와 최대 개수 제한을 공유한다. */
export interface LineHistoryPage { anchor?: LineHistoryAnchor; entries: LineHistoryEntry[]; hasMore: boolean }

/** 저장소만 주입받아 UI 없이도 줄 이력을 조회할 수 있는 서비스다. */
export class LineHistoryService {
  constructor(private readonly root: string) {}

  /**
   * 저장된 현재 줄의 원래 commit/파일/줄을 blame으로 찾아 고정한다. 미커밋 줄은 추측하지 않는다.
   * @param fsPath 저장소 파일 @param line 현재 문서의 1-based 줄 @param signal 사용자 취소
   * @returns 이미 적용된 줄의 불변 anchor, 조회할 수 없거나 미커밋 줄이면 undefined
   */
  async anchor(fsPath: string, line: number, signal?: AbortSignal): Promise<LineHistoryAnchor | undefined> {
    if (!Number.isSafeInteger(line) || line < 1) return undefined;
    const relative = path.isAbsolute(fsPath) ? path.relative(this.root, fsPath) : fsPath;
    if (!safePath(relative)) return undefined;
    const [blame] = await new GitBlameService(this.root).getFileBlame(fsPath, { startLine: line, endLine: line }, { signal });
    if (!blame || !OID.test(blame.commit) || /^0+$/.test(blame.commit) || !blame.originalLine || !safePath(blame.filename)) return undefined;
    return { hash: blame.commit, path: blame.filename, line: blame.originalLine };
  }

  /**
   * 전체 파일/저장소 이력 대신 -L로 한 줄의 변경만 읽는다. 첫 부모 기준의 rename 추적은 Git에 맡긴다.
   * @param anchor 고정된 commit과 그 시점의 실제 파일/줄 @param limit 보여 줄 누적 개수(최대 200)
   * @param signal 소비자 취소 신호 @returns 다음 페이지 유무를 포함한 최신순 변경 목록
   */
  async read(anchor: LineHistoryAnchor, limit = 30, signal?: AbortSignal): Promise<LineHistoryPage> {
    if (!OID.test(anchor.hash) || !safePath(anchor.path) || !Number.isSafeInteger(anchor.line) || anchor.line < 1) throw new Error("Invalid line history anchor.");
    const count = Math.max(1, Math.min(200, Math.floor(limit) || 30));
    const started = Date.now();
    const raw = await runGit(["--literal-pathspecs", "-c", "core.quotePath=true", "-c", "log.showSignature=false", "log", "--first-parent", "--no-color", "--no-ext-diff", "--no-textconv",
      "--no-notes", "--no-decorate", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--root",
      "-M", `--max-count=${count + 1}`, FORMAT, `-L${anchor.line},${anchor.line}:${anchor.path}`, anchor.hash, "--"], this.root,
    { signal, readTimeoutMs: 10_000, maxBuffer: 4 * 1024 * 1024 });
    const entries = parseLineHistory(raw, anchor.path);
    logInfo("blame line history read", { repoRoot: this.root, path: anchor.path, line: anchor.line, hash: anchor.hash,
      entries: Math.min(entries.length, count), limit: count, durationMs: Date.now() - started });
    return { anchor, entries: entries.slice(0, count), hasMore: entries.length > count };
  }
}

/**
 * NUL 필드와 patch 경로를 분리해 긴/제어 문자 subject에도 레코드 경계를 유지한다.
 * @param raw 위 pretty-format으로 받은 Git 출력 @param initialPath 최초 파일 경로
 * @returns 각 commit의 실제 오른쪽/왼쪽 파일 경로와 변경 줄 번호
 */
export function parseLineHistory(raw: string, initialPath: string): LineHistoryEntry[] {
  const entries: LineHistoryEntry[] = [];
  let cursor = 0, currentPath = initialPath;
  while (cursor < raw.length) {
    const start = raw.indexOf(MARKER, cursor);
    if (start < 0) break;
    let fieldCursor = start + MARKER.length;
    const fields: string[] = [];
    for (let index = 0; index < 5; index++) {
      const end = raw.indexOf("\0", fieldCursor);
      if (end < 0) throw new Error("Incomplete line history metadata.");
      fields.push(raw.slice(fieldCursor, end)); fieldCursor = end + 1;
    }
    const next = raw.indexOf(MARKER, fieldCursor);
    const patch = raw.slice(fieldCursor, next < 0 ? undefined : next);
    const [hash, parentText, author, dateIso, title] = fields;
    if (!OID.test(hash)) throw new Error("Invalid line history commit.");
    const before = patchPath(patch, "---"), after = patchPath(patch, "+++");
    const file = after || currentPath;
    if (!safePath(file) || before && !safePath(before)) throw new Error("Invalid line history path.");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m.exec(patch);
    const parent = parentText.split(" ")[0];
    if (parent && !OID.test(parent)) throw new Error("Invalid line history parent.");
    entries.push({ hash, baseRef: OID.test(parent) ? parent : EMPTY_TREE_REF, author, dateIso, title, path: file,
      oldPath: before && before !== file ? before : undefined, line: Math.max(1, Number(hunk?.[1]) || 1) });
    currentPath = before || file;
    cursor = next < 0 ? raw.length : next;
  }
  return entries;
}

/** Git patch의 C-quoted 또는 일반 a/b 경로에서 prefix만 제거하고 실제 파일명을 복원한다. */
function patchPath(patch: string, marker: string): string | undefined {
  const found = new RegExp(`^${marker.replace(/\+/g, "\\+")} ([^\\n]+)$`, "m").exec(patch);
  if (!found || found[1] === "/dev/null") return undefined;
  return decodeGitQuotedPath(found[1]).slice(2);
}

/** 저장소 밖이나 옵션/빈 경로를 조회하지 않도록 실제 Git 상대 경로만 허용한다. */
function safePath(value: string): boolean {
  return Boolean(value && !value.includes("\0") && !path.isAbsolute(value) && !value.split("/").some(part => part === ".." || part === ""));
}
