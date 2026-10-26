// Git이 해석한 index 위치만 재사용한다. index 내용·HEAD·작업트리 결과는 저장하지 않는다.
import path from "node:path";
import { resolveGitExecutable, runGit } from "./gitExec";
import { readRepositoryMetadata } from "./repositoryMetadata";

/** 한 번의 상태 읽기에 고정한 원본 index 위치와 metadata/실행 환경 증거다. */
export interface RepositoryIndexPath { file: string; identity?: string; boundary?: string; statusBoundary?: string; }
interface MetadataProof { identity: string; boundary: string; statusBoundary: string; }
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
    const before = await this.proof(); signal.throwIfAborted();
    if (before && this.cached?.identity === before.identity) {
      if (!this.reportedReuse) {
        this.reportedReuse = true; this.log("private status index path reused", { repoRoot: this.root });
      }
      return { ...this.cached, boundary: before.boundary, statusBoundary: before.statusBoundary };
    }
    if (this.cached) this.log("private status index path invalidated", { repoRoot: this.root, reason: "metadataOrEnvironmentChanged" });
    this.cached = undefined;
    const file = await this.fresh(signal), after = await this.proof(); signal.throwIfAborted();
    if (before && after && (before.identity !== after.identity || before.boundary !== after.boundary)) {
      this.log("private status index path discarded", { repoRoot: this.root, reason: "metadataChangedDuringResolution" });
      throw new Error("Repository metadata changed while resolving the index path.");
    }
    const result = { file, ...(before && after && before.boundary === after.boundary ? after : {}) };
    if (result.identity) this.cached = result;
    return { ...result };
  }

  /**
   * 상태를 계산한 뒤 .git/commondir 교체·원복과 디렉터리의 도중 변경을 확인한다.
   * @param value 읽기 시작 때 고정한 index 위치 @param signal 상태 조회의 취소 신호
   * @returns 동일 증거이면 true. 증거 부재·변경은 false이며 호출부가 native 전체 status로 복구한다.
   */
  async unchanged(value: RepositoryIndexPath, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const current = await this.proof();
    const same = value.identity !== undefined && value.boundary !== undefined
      && value.identity === current?.identity && value.boundary === current?.boundary;
    signal.throwIfAborted(); return same;
  }

  /**
   * private status에 기존 연결·디렉터리 검사와 HEAD·설정 파일 검사를 함께 적용한다.
   * - 전후 같은 경로로 돌아온 저장소와 HEAD/설정의 제자리 재쓰기도 무효화한다.
   * - 실제 index byte·시각 검증은 호출부가 별도로 수행한다.
   * @param value 조회 시작 때 고정한 index 위치와 status 경계
   * @param signal 소비자 취소 신호 @returns 증거가 없거나 달라지면 false
   */
  async unchangedForStatus(value: RepositoryIndexPath, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const current = await this.proof();
    const same = value.identity !== undefined && value.statusBoundary !== undefined
      && value.identity === current?.identity && value.statusBoundary === current?.statusBoundary;
    signal.throwIfAborted(); return same;
  }

  /** 상태 캐시가 처분되면 경로도 즉시 해제한다. 새 세션은 native Git부터 검증한다. */
  clear(): void { this.cached = undefined; this.reportedReuse = false; }

  /**
   * 재사용할 경로의 연결 증거와 이번 조회에만 적용할 변경 시각을 같은 metadata 읽기에서 구한다.
   * @returns Git 실행 환경까지 고정한 경로·조회 경계 증거. 해석이 불확실하면 undefined
   */
  private async proof(): Promise<MetadataProof | undefined> {
    const metadata = await readRepositoryMetadata(this.root, true);
    if (!metadata?.statusBoundary) return undefined;
    const environment = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_") || key === "PATH")
      .sort(([left], [right]) => left.localeCompare(right));
    const identity = JSON.stringify([resolveGitExecutable(this.root), environment, metadata.identity]);
    return { identity, boundary: JSON.stringify([identity, metadata.boundary]),
      statusBoundary: JSON.stringify([identity, metadata.boundary, metadata.statusBoundary]) };
  }

  /** 경로를 추측하지 않고 Git의 --git-path 해석을 사용하며 마지막 CLI 개행만 제거한다. */
  private async fresh(signal: AbortSignal): Promise<string> {
    const output = await this.runner(["rev-parse", "--git-path", "index"], this.root, { signal });
    const ending = output.endsWith("\r\n") ? 2 : output.endsWith("\n") ? 1 : 0;
    if (!output.slice(0, output.length - ending)) throw new Error("Cannot verify the repository index path.");
    return path.resolve(this.root, output.slice(0, output.length - ending));
  }
}
