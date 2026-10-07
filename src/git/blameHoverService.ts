// blame 호버에 필요한 전체 커밋 메시지·공동 작성자·파일 통계를 한 번의 Git 조회로 읽는다.
// - UI나 기본 Git 확장에 의존하지 않으며, 파일 경로는 기존 NUL raw/numstat 파서로 보존한다.
import { runGit } from "./gitExec";
import { parseRawNumstatZ } from "./diffParse";
import type { FileChange } from "./gitTypes";

/** 초기 blame 메타데이터와 상세 커밋 조회가 공유하는 작성자·메시지 구조다. */
export interface BlameCommitSummary {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorDateIso: string;
  message: string;
}

/** 실제 커밋의 첫 부모 변경과 전체 메시지에서 읽은 호버 정보다. */
export interface BlameCommitInfo extends BlameCommitSummary {
  parents: string[];
  files: Array<FileChange & { binary?: true }>;
  coAuthors: Array<{ name: string; email: string }>;
  stats: { files: number; insertions: number; deletions: number; binaryFiles: number };
}

/**
 * 선택한 커밋만 조회하므로 파일 blame 로딩 때 모든 커밋의 상세를 미리 읽지 않는다.
 * @param repoRoot 조회할 저장소 루트, hash blame에서 검증한 전체 SHA, signal 소비자의 취소 신호
 * @returns 루트·merge·rename·binary 파일을 포함한 첫 부모 기준의 실제 커밋 정보
 */
export async function readBlameCommitInfo(repoRoot: string, hash: string, signal?: AbortSignal): Promise<BlameCommitInfo> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash) || /^0+$/.test(hash)) throw new Error("Invalid blame commit");
  const format = ["%H", "%P", "%an", "%ae", "%aI", "%B"].join("%x00") + "%x00";
  const output = await runGit([
    "show", `--format=format:${format}`, "--raw", "--numstat", "-z", "--first-parent", "--root",
    "--find-renames", "--no-color", "--no-ext-diff", "--no-textconv", hash, "--",
  ], repoRoot, { signal });
  signal?.throwIfAborted();
  return parseBlameCommitInfo(output, hash);
}

/**
 * 여섯 개 NUL 헤더 뒤의 raw/numstat을 나눠 메시지의 개행과 특수 파일명을 그대로 유지한다.
 * @param output readBlameCommitInfo의 Git 출력, expectedHash 요청한 SHA와 결과의 일치 경계
 * @returns 전체 메시지, 공동 작성자, 파일 목록과 text/binary 구분을 가진 통계
 */
export function parseBlameCommitInfo(output: string, expectedHash: string): BlameCommitInfo {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < 6; index++) {
    const end = output.indexOf("\0", offset);
    if (end < 0) throw new Error("Incomplete blame commit header");
    fields.push(output.slice(offset, end));
    offset = end + 1;
  }
  if (fields[0] !== expectedHash) throw new Error("Blame commit identity changed");
  const files = parseRawNumstatZ(output.slice(offset).replace(/^\n+/, ""), true);
  const message = fields[5].trimEnd();
  const coAuthors: BlameCommitInfo["coAuthors"] = [];
  const seen = new Set<string>();
  for (const match of message.matchAll(/^Co-authored-by:\s*(.+?)\s*<([^<>\r\n]+)>\s*$/gim)) {
    const email = match[2].trim(), key = email.toLocaleLowerCase();
    if (!seen.has(key)) { seen.add(key); coAuthors.push({ name: match[1].trim(), email }); }
  }
  return {
    hash: fields[0], parents: fields[1].split(" ").filter(Boolean), authorName: fields[2],
    authorEmail: fields[3], authorDateIso: fields[4], message, files, coAuthors,
    stats: {
      files: files.length,
      insertions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      binaryFiles: files.filter(file => file.binary).length,
    },
  };
}

/**
 * 로컬 remote 설정에서 GitHub/GitLab/Bitbucket의 커밋 URL을 만든다. 인증이나 네트워크 조회는 하지 않는다.
 * @param repoRoot 저장소 루트, hash 검증된 커밋 SHA, signal 설정 조회를 취소할 신호
 * @returns origin 우선의 알려진 웹 주소. 원격 없음/알 수 없는 호스트는 undefined
 */
export async function readBlameCommitRemoteUrl(repoRoot: string, hash: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const output = await runGit(["config", "--null", "--get-regexp", "^remote\\..*\\.url$"], repoRoot, { signal });
    const remotes = output.split("\0").filter(Boolean).map(record => {
      const newline = record.indexOf("\n");
      return { name: record.slice(0, newline), url: record.slice(newline + 1) };
    }).sort((left, right) => Number(right.name === "remote.origin.url") - Number(left.name === "remote.origin.url"));
    for (const remote of remotes) {
      const url = blameCommitRemoteUrl(remote.url, hash);
      if (url) return url;
    }
    return undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

/**
 * SSH/HTTPS remote에서 인증 정보를 제거하고 알려진 provider의 실제 커밋 경로만 조립한다.
 * @param remote Git 설정의 remote URL, hash 전체 SHA
 * @returns HTTPS 커밋 주소. 파일·기타 프로토콜·알 수 없는 provider는 undefined
 */
export function blameCommitRemoteUrl(remote: string, hash: string): string | undefined {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) return undefined;
  try {
    const scp = /^(?:[^@\s]+@)?([^/:\s]+):(.+)$/.exec(remote);
    const url = new URL(scp && !remote.includes("://") ? `ssh://${scp[1]}/${scp[2]}` : remote);
    if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol)) return undefined;
    const paths = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
    if (paths.length < 2 || paths.some(part => !part || part === "." || part === "..")) return undefined;
    const base = `https://${url.host}/${paths.join("/")}`;
    if (url.hostname === "github.com") return `${base}/commit/${hash}`;
    if (url.hostname === "gitlab.com") return `${base}/-/commit/${hash}`;
    if (url.hostname === "bitbucket.org") return `${base}/commits/${hash}`;
    return undefined;
  } catch { return undefined; }
}
