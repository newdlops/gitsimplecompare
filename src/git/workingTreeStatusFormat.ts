import { parsePorcelainGroups } from "./diffParse";
import type { StatusGroups } from "./statusCache";

/** porcelain 형식 차이를 흡수해 Changes·Graph·외부 API가 같은 authoritative 결과를 소비한다. */
export interface WorkingTreeSnapshot {
  repoRoot: string; head?: string; branch: string; upstream?: string; groups: StatusGroups; porcelain: string; hasChanges: boolean;
}
export interface WorkingTreeEntry { xy: string; path: string; oldPath?: string }
export interface ParsedWorkingTree { head?: string; branch: string; upstream?: string; entries: WorkingTreeEntry[] }

/** NUL 경계를 먼저 나눠 개행/공백 파일명과 rename 원본을 그대로 보존한다. */
export function parseWorkingTreeV2(raw: string): ParsedWorkingTree {
  const result: ParsedWorkingTree = { branch: "", entries: [] }, tokens = raw.split("\0");
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.startsWith("# branch.oid ")) {
      const oid = token.slice(13); if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) result.head = oid;
    } else if (token.startsWith("# branch.head ")) {
      const branch = token.slice(14); result.branch = branch === "(detached)" ? "" : branch;
    } else if (token.startsWith("# branch.upstream ")) {
      result.upstream = token.slice(18);
    } else if (token.startsWith("# ") || token.startsWith("! ")) continue;
    else if (token.startsWith("? ")) result.entries.push({ xy: "??", path: token.slice(2) });
    else {
      const match = token.startsWith("1 ") ? /^1 (\S{2})(?: \S+){6} ([\s\S]*)$/.exec(token)
        : token.startsWith("2 ") ? /^2 (\S{2})(?: \S+){7} ([\s\S]*)$/.exec(token)
        : token.startsWith("u ") ? /^u (\S{2})(?: \S+){8} ([\s\S]*)$/.exec(token) : null;
      if (!match) throw new Error("Unsupported porcelain v2 status record.");
      const oldPath = token.startsWith("2 ") ? tokens[++index] : undefined;
      if (token.startsWith("2 ") && oldPath === undefined) throw new Error("Incomplete Git rename record.");
      result.entries.push({ xy: match[1].replace(/\./g, " "), path: match[2], ...(oldPath === undefined ? {} : { oldPath }) });
    }
  }
  return result;
}

/** 원문의 XY를 보존하는 v1 출력도 제공해 기존 소비자의 parser를 유지한다. */
export function workingTreeSnapshot(root: string, parsed: ParsedWorkingTree): WorkingTreeSnapshot {
  const porcelain = parsed.entries.map(entry => `${entry.xy} ${entry.path}\0${entry.oldPath === undefined ? "" : `${entry.oldPath}\0`}`).join("");
  return { repoRoot: root, head: parsed.head, branch: parsed.branch, upstream: parsed.upstream, porcelain, groups: parsePorcelainGroups(porcelain), hasChanges: parsed.entries.length > 0 };
}
