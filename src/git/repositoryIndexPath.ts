// Git이 해석한 index 위치만 재사용한다. index 내용·HEAD·작업트리 결과는 저장하지 않는다.
import path from "node:path";
import { resolveGitExecutable, runGit } from "./gitExec";
import { readRepositoryMetadata } from "./repositoryMetadata";

/** 한 번의 상태 읽기에 고정한 원본 index 위치와 metadata/실행 환경 증거다. */
export interface RepositoryIndexPath { file: string; identity?: string; }
type Runner = typeof runGit;

/** 저장소 하나의 마지막 검증 경로 한 개만 보관하고 metadata·환경 변경 때 native Git으로 돌아간다. */
export class RepositoryIndexPathReader {
  private cached?: RepositoryIndexPath;
  private reportedReuse = false;

  /** @param root 현재 상태를 읽을 작업트리 @param runner 테스트에서 경로 해석 경계를 제어할 실행기 */
  constructor(private readonly root: string, private readonly runner: Runner = runGit,
    private readonly log: (event: string, fields: Record<string, unknown>) => void = () => undefined) {}

  /**
   * 같은 metadata·Git 실행 환경에서만 Git이 이전에 해석한 index 경로를 재사용한다.
   * @param signal 소비자가 해제되면 조회를 취소하는 신호
   * @returns 원본 index 경로와 증거. 해석 중 metadata가 바뀌거나 증거가 없으면 캐시하지 않는다.
   * @throws 해석 도중 metadata가 교체되면 private index 사용 전에 중단한다.
   */
  async read(signal: AbortSignal): Promise<RepositoryIndexPath> {
    signal.throwIfAborted();
    const before = await this.identity(); signal.throwIfAborted();
    if (before && this.cached?.identity === before) {
      if (!this.reportedReuse) {
        this.reportedReuse = true; this.log("private status index path reused", { repoRoot: this.root });
      }
      return { ...this.cached };
    }
    if (this.cached) this.log("private status index path invalidated", { repoRoot: this.root, reason: "metadataOrEnvironmentChanged" });
    this.cached = undefined;
    const file = await this.fresh(signal), after = await this.identity(); signal.throwIfAborted();
    if (before && after && before !== after) {
      this.log("private status index path discarded", { repoRoot: this.root, reason: "metadataChangedDuringResolution" });
      throw new Error("Repository metadata changed while resolving the index path.");
    }
    const result = { file, ...(before && before === after ? { identity: after } : {}) };
    if (result.identity) this.cached = result;
    return { ...result };
  }

  /**
   * 상태를 계산한 뒤 .git/commondir 교체를 확인해 이전 경로로 읽은 결과가 게시되지 않게 한다.
   * @param value 읽기 시작 때 고정한 index 위치 @param signal 상태 조회의 취소 신호
   * @returns 동일 증거이면 true. 증거 부재·변경은 false이며 호출부가 native 전체 status로 복구한다.
   */
  async unchanged(value: RepositoryIndexPath, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const same = value.identity !== undefined && value.identity === await this.identity();
    signal.throwIfAborted(); return same;
  }

  /** 상태 캐시가 처분되면 경로도 즉시 해제한다. 새 세션은 native Git부터 검증한다. */
  clear(): void { this.cached = undefined; this.reportedReuse = false; }

  /** index 결과에 영향을 줄 Git 환경·실행 경로와 실제 metadata inode/locator 내용을 비교한다. */
  private async identity(): Promise<string | undefined> {
    const metadata = await readRepositoryMetadata(this.root);
    if (!metadata) return undefined;
    const environment = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_") || key === "PATH")
      .sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify([resolveGitExecutable(this.root), environment, metadata.identity]);
  }

  /** 경로를 추측하지 않고 Git의 --git-path 해석을 사용하며 마지막 CLI 개행만 제거한다. */
  private async fresh(signal: AbortSignal): Promise<string> {
    const output = await this.runner(["rev-parse", "--git-path", "index"], this.root, { signal });
    const ending = output.endsWith("\r\n") ? 2 : output.endsWith("\n") ? 1 : 0;
    if (!output.slice(0, output.length - ending)) throw new Error("Cannot verify the repository index path.");
    return path.resolve(this.root, output.slice(0, output.length - ending));
  }
}
