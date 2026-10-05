// Git 실행 시간 계측을 OUTPUT/VS Code 구현과 분리하는 모듈.
// - 동기 spawn 호출 시간과 완료까지의 시간을 구분하고, 인자·stdin·출력 내용은 기록하지 않는다.
import { gitCommandIndex } from "./gitCommandPolicy";
import { isOwnedStatusIndex } from "./statusIndexOwnership";

/** 프로세스 실행 비용을 조사할 때 필요한 최소 계측 결과다. */
export interface GitExecutionTiming {
  repoRoot: string;
  executable: string;
  command: string;
  syncSpawnMs: number;
  elapsedMs: number;
  outcome: "success" | "error";
  code?: number | string;
  statusIndex?: "repository" | "private" | "caller";
  statusUntracked?: "all" | "normal" | "none" | "configured";
  optionalLocks?: "0" | "1" | "unset";
}

/** UI 어댑터가 OUTPUT 로그 등 실제 관찰 경계를 주입하는 함수다. */
export type GitExecutionObserver = (timing: GitExecutionTiming) => void;
let observer: GitExecutionObserver | undefined;

/**
 * 계측 소비자를 등록하고 자신의 등록만 해제할 수 있게 한다.
 * @param next Git 프로세스 종료 시 민감한 인자 없이 호출할 소비자
 * @returns 더 최근 등록을 침범하지 않는 해제 함수
 */
export function setGitExecutionObserver(next: GitExecutionObserver): () => void {
  observer = next;
  return () => { if (observer === next) observer = undefined; };
}

/** Git 실행 호출이 반환된 시점과 최종 완료 시점을 기록하는 경계다. */
export interface GitExecutionProbe {
  spawnReturned(): void;
  finish(outcome: GitExecutionTiming["outcome"], code?: number | string): void;
}

/**
 * 한 프로세스의 시작·동기 실행 호출·완료를 계측하되 관찰 오류는 Git 결과에 영향을 주지 않는다.
 * @param args 하위 명령 이름만 추출할 Git 인자. 값·경로·메시지는 결과에 포함하지 않는다.
 * @param repoRoot 실행할 저장소 루트
 * @param executable 실제 실행할 파일
 * @param now 테스트에서 실행 구간을 제어하는 밀리초 시계
 * @param environment 실제 자식 환경. status의 소유 index 종류와 잠금 정책만 분류하며 값·경로는 내보내지 않는다.
 * @returns 등록된 소비자가 있을 때만 생성하는 probe. 미등록 시 계측 비용 없이 undefined
 */
export function beginGitExecution(
  args: readonly string[], repoRoot: string, executable: string, now: () => number = Date.now, environment?: NodeJS.ProcessEnv
): GitExecutionProbe | undefined {
  const sink = observer;
  if (!sink) return undefined;
  const started = now();
  const command = commandForLog(args);
  const status = command === "status" && environment ? statusReadShape(args, environment) : {};
  let syncSpawnMs = 0;
  let finished = false;
  return {
    spawnReturned: () => { syncSpawnMs = Math.max(0, now() - started); },
    finish: (outcome, code) => {
      if (finished) return;
      finished = true;
      if (observer !== sink) return;
      // OUTPUT 폐기나 소비자 오류 때문에 성공한 stage/commit을 실패로 바꾸지 않는다.
      try { sink({ repoRoot, executable, command, syncSpawnMs, elapsedMs: Math.max(0, now() - started), outcome, ...status, ...(code == null ? {} : { code }) }); }
      catch { /* 관찰은 Git 실행 결과를 변경할 권한이 없다. */ }
    },
  };
}

/**
 * status가 실제 index를 읽는지와 미추적 탐색 범위를 고정된 값으로만 분류한다.
 * @param args 전역 옵션을 포함한 실행 인자. 파일 경계 뒤의 이름은 옵션으로 해석하지 않는다.
 * @param environment 최종 환경. index 경로와 임의 환경 값은 결과에 포함하지 않는다.
 * @returns 초기 전체 스캔과 캐시 조회를 구별할 안전한 계측 필드
 */
function statusReadShape(args: readonly string[], environment: NodeJS.ProcessEnv): Pick<GitExecutionTiming, "statusIndex" | "statusUntracked" | "optionalLocks"> {
  let statusUntracked: GitExecutionTiming["statusUntracked"] = "configured";
  for (const argument of args.slice(gitCommandIndex(args) + 1)) {
    if (argument === "--") break;
    if (["-u", "-uall", "--untracked-files", "--untracked-files=all"].includes(argument)) statusUntracked = "all";
    else if (["-uno", "--untracked-files=no"].includes(argument)) statusUntracked = "none";
    else if (["-unormal", "--untracked-files=normal"].includes(argument)) statusUntracked = "normal";
  }
  const index = environment.GIT_INDEX_FILE;
  return { statusIndex: index === undefined ? "repository" : isOwnedStatusIndex(index) ? "private" : "caller", statusUntracked,
    optionalLocks: environment.GIT_OPTIONAL_LOCKS === "0" ? "0" : environment.GIT_OPTIONAL_LOCKS === "1" ? "1" : "unset" };
}

/** 전역 옵션 값을 건너뛰고 안전한 하위 명령 이름만 꺼내 인자·설정 값의 로그 노출을 막는다. */
function commandForLog(args: readonly string[]): string {
  const optionsWithValue = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (optionsWithValue.has(value)) { index++; continue; }
    if (value.startsWith("-")) continue;
    return /^[a-z][a-z0-9-]*$/.test(value) ? value : "unknown";
  }
  return "unknown";
}
