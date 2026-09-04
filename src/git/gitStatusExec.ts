// 고빈도 git status 조회에서 고장 난 fsmonitor 설정을 안전하게 우회하는 실행 모듈.
// - 사용자/저장소 config를 수정하지 않고 command scope에서만 core.fsmonitor=false를 적용한다.
// - cooldown 뒤 원래 설정을 다시 시도해 daemon이 복구되면 자동으로 빠른 경로로 돌아간다.
import { GitError, GitCommandOutput, RunGitOptions, runGitDetailed } from "./gitExec";
import { logWarn } from "../ui/outputLog";

const FSMONITOR_RETRY_MS = 5 * 60 * 1_000;
const FSMONITOR_ERROR = /fsmonitor(?:_ipc__send_query|.*(?:ipc|daemon)).*(?:error|failed|unavailable)/i;

/** 성공 stderr까지 관찰할 수 있도록 주입하는 git 실행 함수다. */
export type GitStatusDetailedRunner = (
  args: string[],
  cwd: string,
  options?: RunGitOptions
) => Promise<GitCommandOutput>;

/** OUTPUT 결합 없이 단위 테스트할 수 있도록 경고 기록 경계를 나타낸다. */
export type GitStatusWarningLogger = (
  event: string,
  fields: Record<string, unknown>
) => void;

/** 저장소별 fsmonitor 실패 cooldown과 status 실행 정책을 소유한다. */
export class GitStatusFsMonitorGuard {
  private readonly disabledUntil = new Map<string, number>();

  /**
   * @param runner 성공 stderr를 포함해 반환하는 저수준 Git 실행 함수
   * @param warn fallback 활성화를 OUTPUT에 기록하는 함수
   * @param now 테스트에서 cooldown 만료를 제어할 현재 시각 함수
   * @param retryMs 원래 fsmonitor 설정을 다시 시험하기까지의 대기 시간
   */
  constructor(
    private readonly runner: GitStatusDetailedRunner = runGitDetailed,
    private readonly warn: GitStatusWarningLogger = (event, fields) => logWarn(event, fields),
    private readonly now: () => number = Date.now,
    private readonly retryMs = FSMONITOR_RETRY_MS
  ) {}

  /**
   * git status를 실행하고 fsmonitor IPC 오류가 관찰되면 이후 조회를 command-scope fallback으로 보낸다.
   * - 성공하면서 stderr 경고만 낸 경우 첫 stdout은 그대로 사용해 같은 전체 스캔을 즉시 반복하지 않는다.
   * - Git 자체가 실패한 경우에는 fallback으로 한 번 재시도해 Changes/Graph 로딩을 복구한다.
   * @param args status로 시작하는 Git 인자 배열
   * @param repoRoot status를 읽을 저장소 또는 linked worktree 루트
   * @param options 취소 신호 등 저수준 Git 실행 옵션
   * @returns porcelain status stdout
   */
  async run(
    args: string[],
    repoRoot: string,
    options?: RunGitOptions
  ): Promise<string> {
    const fallbackActive = (this.disabledUntil.get(repoRoot) ?? 0) > this.now();
    const command = fallbackActive ? withoutFsMonitor(args) : args;
    try {
      const result = await this.runner(command, repoRoot, options);
      if (!fallbackActive && hasFsMonitorFailure(result.stderr)) {
        this.activate(repoRoot, result.stderr);
      }
      return result.stdout;
    } catch (error) {
      if (fallbackActive || !hasFsMonitorFailure(gitErrorOutput(error))) throw error;
      this.activate(repoRoot, gitErrorOutput(error));
      return (await this.runner(withoutFsMonitor(args), repoRoot, options)).stdout;
    }
  }

  /** fsmonitor 우회 만료 시각을 저장하고 원인 한 줄을 관찰성 로그에 남긴다. */
  private activate(repoRoot: string, diagnostic: string): void {
    this.disabledUntil.set(repoRoot, this.now() + this.retryMs);
    this.warn("git fsmonitor fallback activated", {
      repoRoot,
      retryAfterMs: this.retryMs,
      diagnostic: firstLine(diagnostic),
    });
  }
}

const sharedGuard = new GitStatusFsMonitorGuard();

/** 확장 전체의 고빈도 status 호출이 공유하는 fsmonitor-aware 실행 진입점이다. */
export function runGitStatus(
  args: string[],
  repoRoot: string,
  options?: RunGitOptions
): Promise<string> {
  return sharedGuard.run(args, repoRoot, options);
}

/** 원래 인자 배열을 변경하지 않고 command scope fsmonitor 비활성화 옵션을 앞에 붙인다. */
function withoutFsMonitor(args: readonly string[]): string[] {
  return ["-c", "core.fsmonitor=false", ...args];
}

/** Git stderr가 알려진 fsmonitor IPC/daemon 실패 문구를 포함하는지 판정한다. */
export function hasFsMonitorFailure(stderr: string): boolean {
  return FSMONITOR_ERROR.test(stderr);
}

/** throw 값에서 GitError의 stderr와 message를 함께 꺼내 fallback 판정 누락을 막는다. */
function gitErrorOutput(error: unknown): string {
  return error instanceof GitError ? `${error.stderr}\n${error.message}` : String(error);
}

/** 여러 줄 진단을 OUTPUT 한 필드에 적합한 첫 비어 있지 않은 행으로 제한한다. */
function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "fsmonitor unavailable";
}
