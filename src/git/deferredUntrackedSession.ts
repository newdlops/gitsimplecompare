// 표시용 미추적 분류만 한 snapshot 동안 재사용한다. 쓰기 직전 검증은 항상 별도의 fresh Git 조회다.
import { lstat } from "node:fs/promises";
import path from "node:path";
import { readRepositoryMetadata } from "./repositoryMetadata";
import { resolveGitExecutable, runGitLiteralPaths } from "./gitExec";
import type { DiffFile } from "./diffHunkService";
import { logInfo } from "../ui/outputLog";

interface ReadTicket { generation: number; stamp?: string }

/** 본문은 캐시하지 않고, 안정된 index에서 확인한 미추적 경로의 표시용 분류만 보관한다. */
export class DeferredUntrackedSession {
  private generation = 0;
  private stamp?: string;
  private paths = new Set<string>();
  /** @param root 전체 목록과 상세 읽기가 공유하는 저장소 루트 */
  constructor(private readonly root: string) {}

  /** 전체 조회 전에 기존 분류를 폐기하고 원본 index·저장소 연결의 증거를 고정한다. */
  async start(): Promise<ReadTicket> {
    const generation = ++this.generation; this.stamp = undefined; this.paths.clear();
    return { generation, stamp: await this.identity() };
  }

  /** 전체 조회 전후 증거가 같은 경우만 지연된 미추적 항목을 현재 표시 snapshot에 등록한다. */
  async remember(ticket: ReadTicket, files: readonly DiffFile[]): Promise<void> {
    if (!ticket.stamp || ticket.generation !== this.generation || !files.some(file => file.deferred)) return;
    const after = await this.identity();
    if (ticket.generation !== this.generation || ticket.stamp !== after) return;
    this.stamp = after;
    this.paths = new Set(files.filter(file => file.deferred && file.stage === "unstaged" && !file.binary).map(file => file.path));
  }

  /**
   * index와 저장소가 같으면 현재 미추적 여부를 한 번 확인하고 본문을 읽는다. 변경·불확실성은 전체 분류로 돌아간다.
   * @param relativePath 전체 목록에 있던 경로 @param signal 상세 소비자의 취소 신호
   * @param readBody 원본 파일에서 synthetic diff를 만드는 함수 @param fresh Git 분류를 포함한 기존 읽기
   * @returns 표시용 파일 상세. 쓰기 검증에서는 이 표시 snapshot을 재사용하지 않는다.
   */
  async read(relativePath: string, signal: AbortSignal | undefined,
    readBody: () => Promise<DiffFile[]>, fresh: () => Promise<DiffFile[]>): Promise<DiffFile[]> {
    signal?.throwIfAborted();
    const generation = this.generation, expected = this.stamp;
    if (!expected || !this.paths.has(relativePath)) return fresh();
    const before = await this.identity(); signal?.throwIfAborted();
    if (before !== expected) {
      this.paths.clear(); this.stamp = undefined;
      logInfo("deferred untracked classification invalidated", { repoRoot: this.root, path: relativePath });
      return fresh();
    }
    // index가 그대로여도 삭제·디렉터리 교체·ignore 설정 변경은 가능하다. 실제 Git 규칙으로 해당 경로만 확인한다.
    const untracked = await runGitLiteralPaths(["ls-files", "--others", "--exclude-standard", "-z", "--", relativePath],
      this.root, { signal });
    if (!untracked.split("\0").includes(relativePath)) return fresh();
    const files = await readBody(); signal?.throwIfAborted();
    const after = await this.identity(); signal?.throwIfAborted();
    if (generation !== this.generation || after !== expected) return fresh();
    logInfo("deferred untracked body read with scoped classification", { repoRoot: this.root, path: relativePath });
    return files;
  }

  /**
   * 기본·linked worktree의 실제 index와 metadata를 검증한다. 사용자 지정 index/경계를 추측하지 않는다.
   * @returns 정상 파일 또는 index 부재의 증거. Git 환경·설정·연결 변경, symlink, 접근 실패는 fast path를 포기한다.
   */
  private async identity(): Promise<string | undefined> {
    try {
      if (process.env.GIT_INDEX_FILE || process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return undefined;
      const metadata = await readRepositoryMetadata(this.root, true);
      if (!metadata?.statusBoundary) return undefined;
      const index = await lstat(path.join(metadata.gitDir, "index")).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
      });
      if (index && !index.isFile()) return undefined;
      const environment = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")).sort(([a], [b]) => a.localeCompare(b));
      return JSON.stringify([metadata.identity, metadata.statusBoundary,
        index && [index.dev, index.ino, index.size, index.mtimeMs, index.ctimeMs], resolveGitExecutable(this.root), environment]);
    } catch { return undefined; }
  }
}
