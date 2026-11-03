// 표시용 stash 메타데이터만 재사용한다. apply/drop/pop의 선택 검증은 이 캐시를 사용하지 않는다.
import { lstat } from "node:fs/promises";
import path from "node:path";
import { readRepositoryMetadata } from "./repositoryMetadata";
import { resolveGitExecutable } from "./gitExec";
import type { StashEntry } from "./gitTypes";
import { LruCache } from "../utils/lruCache";
import { logInfo } from "../ui/outputLog";

interface Snapshot { stamp: string; at: number; entries: StashEntry[]; complete: boolean }
const snapshots = new LruCache<string, Snapshot>(16, 8 * 1024 * 1024, (root, snapshot) =>
  root.length * 2 + snapshot.stamp.length * 2 + snapshot.entries.reduce((bytes, entry) => bytes + 128
    + [entry.ref, entry.hash, entry.branch, entry.message, entry.relativeDate].reduce((n, value) => n + (value?.length ?? 0) * 2, 0), 0));
const owners = new Map<string, symbol>();

/** 확장 종료 때 목록과 실행 세대를 비워 진행 중인 이전 조회가 완료 캐시를 되살리지 않게 한다. */
export function clearStashListSnapshots(): void { snapshots.clear(); owners.clear(); }

/**
 * 첫 페이지는 작은 조회로 열고, 추가 페이지는 전체 메타데이터를 한 번 읽어 앞부분 반복 조회를 피한다.
 * @param repoRoot 대상 저장소 @param load 선택 검증과 분리된 메타데이터 조회. 요청 상한을 native Git에 전달한다.
 * @param refresh 명시 새로고침이면 캐시를 사용하지 않는다. 추가 페이지는 reflog/저장소 증거를 먼저 검증한다.
 * @param limit 첫 화면은 필요한 앞부분만 읽고, 추가 페이지는 전체 목록을 한 번 읽어 이후에 재사용한다.
 * @returns 현재 목록 사본. 증거를 읽을 수 없는 저장 형식에서는 기존 native 조회로 안전하게 돌아간다.
 */
export async function readStashListForDisplay(repoRoot: string, load: (limit: number) => Promise<StashEntry[]>, refresh = false, limit = 10000): Promise<StashEntry[]> {
  // 첫 화면은 native 앞부분 조회만 한다. 이후 첫 추가 페이지가 전체 snapshot을 만들므로 지문 I/O가 필요 없다.
  if (refresh) {
    snapshots.delete(repoRoot); owners.delete(repoRoot);
    return load(limit);
  }
  const before = await stashListStamp(repoRoot), cached = snapshots.get(repoRoot);
  if (before && cached?.stamp === before && (cached.complete || cached.entries.length >= limit) && Date.now() - cached.at < 30_000) {
    logInfo("stash list snapshot reused", { repoRoot, entries: cached.entries.length });
    return cached.entries.map(entry => ({ ...entry }));
  }
  snapshots.delete(repoRoot);
  const owner = Symbol(); owners.set(repoRoot, owner);
  try {
    let stamp = before;
    for (let attempt = 0; attempt < 2; attempt++) {
      const entries = await load(limit), after = await stashListStamp(repoRoot);
      if (stamp && after && stamp !== after) {
        logInfo("stash list snapshot changed during read", { repoRoot, attempt });
        stamp = after; continue;
      }
      if (stamp && after === stamp && owners.get(repoRoot) === owner) {
        snapshots.set(repoRoot, { stamp, at: Date.now(), complete: entries.length < limit || limit === 10000,
          entries: entries.map(entry => ({ ...entry })) });
      }
      return entries;
    }
    throw new Error("Stash list changed while loading. Refresh and try again.");
  } finally { if (owners.get(repoRoot) === owner) owners.delete(repoRoot); }
}

/**
 * reflog의 추가·삭제·교체·원복과 linked worktree 연결을 구분하는 읽기 전용 증거다.
 * - reftable/파일 접근 실패/사용자 지정 Git 경계에서는 native 조회를 사용한다.
 * - atime을 제외한 inode·크기·ctime·mtime과 설정·실행 환경을 포함하고 원문은 로그에 남기지 않는다.
 */
async function stashListStamp(repoRoot: string): Promise<string | undefined> {
  try {
    if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_WORK_TREE || process.env.GIT_NAMESPACE) return undefined;
    const metadata = await readRepositoryMetadata(repoRoot, true);
    if (!metadata?.statusBoundary) return undefined;
    if (await fileStamp(path.join(metadata.commonDir, "reftable")) !== "missing") return undefined;
    const log = await fileStamp(path.join(metadata.commonDir, "logs/refs/stash"));
    if (log === "missing") return undefined;
    const [ref, packed] = await Promise.all([fileStamp(path.join(metadata.commonDir, "refs/stash")),
      fileStamp(path.join(metadata.commonDir, "packed-refs"))]);
    const environment = Object.entries(process.env).filter(([key]) => /^(?:GIT_|HOME$|XDG_CONFIG_HOME$|LANG$|LC_)/.test(key)).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([metadata.identity, metadata.statusBoundary, log, ref, packed, resolveGitExecutable(repoRoot), environment]);
  } catch { return undefined; }
}

/** 일반 파일만 지문으로 사용한다. 파일 부재는 정상 상태이며 symlink·권한 오류는 캐시 사용을 포기한다. */
async function fileStamp(file: string): Promise<string> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error("Unsupported stash metadata file.");
    return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
