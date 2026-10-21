import { GitError, runGit, withGitConfigOverrides, type RunGitOptions } from "./gitExec";
import { gitCommandPolicy, gitCommandIndex } from "./gitCommandPolicy";
import { gitProcesses, type GitProcessLogger } from "./gitProcessRegistry";
import { setGitProcessPreparation } from "./gitProcessRunner";
import { createHash } from "node:crypto";
import { isOwnedStatusIndex } from "./statusIndexOwnership";

interface MonitorPreparation { ready: boolean; foreground: boolean; expires: number }
interface MonitorPreparationTask { ready: Promise<boolean | undefined>; fallback: Promise<boolean | undefined> }
let logger: GitProcessLogger | undefined;
let generation = 0, active = false;
const preparing = new Map<string, MonitorPreparationTask>();
const prepared = new Map<string, MonitorPreparation>();
const controllers = new Set<AbortController>();
// 준비 과정의 IPC 확인도 공통 Git 실행기를 쓰되 같은 준비 Promise를 다시 기다리지 않는다.
const preparationSignals = new WeakSet<AbortSignal>();
const withoutIndex = new Set(["config", "fsmonitor--daemon", "version", "rev-parse", "rev-list", "log", "show", "cat-file", "ls-tree", "for-each-ref", "merge-base", "describe", "name-rev", "remote", "branch", "worktree", "symbolic-ref", "update-ref", "commit-tree", "mktree", "show-ref", "reflog", "ls-remote", "check-ref-format"]);

/** 공식 stop 뒤에는 다음 조회에서 소켓 준비와 소유권을 새로 확인한다. */
export function forgetPreparedFsmonitor(root: string): void {
  for (const key of prepared.keys()) if (key.startsWith(`${root}\0`)) prepared.delete(key);
}

/**
 * 유휴 정리 토글과 별개로 확장 세션의 신규 builtin 감시자 수명을 관리한다.
 * @param log 준비·실패·종료를 OUTPUT에 연결하는 관찰 함수
 * @returns 등록 해제. 진행 중 준비 작업은 세대 검사로 추가 spawn을 중단한다.
 */
export function setOwnedFsmonitorPolicy(log: GitProcessLogger): () => void {
  active = true; logger = log; const current = ++generation;
  const reset = setGitProcessPreparation(prepareGitOptions);
  const unsubscribe = gitProcesses.onDidFinishWrite(root => {
    for (const [key, item] of prepared) if (!item.foreground && key.startsWith(`${root}\0`)) prepared.delete(key);
  });
  return () => {
    reset(); unsubscribe();
    if (generation === current) {
      active = false; generation++;
      for (const controller of controllers) controller.abort();
      controllers.clear(); logger = undefined; prepared.clear(); preparing.clear();
    }
  };
}

/**
 * 동일 저장소/실행 파일의 준비를 합치고 ready 확인에 성공한 경우에만 builtin fsmonitor를 허용한다.
 * @param root 실제 Git 실행 cwd
 * @param options 선택 실행 파일 및 기존 명령 범위 환경
 * @param globals 파일명 해석과 Git 설정을 포함한 명령 앞의 전역 옵션
 * @param background private index 조회는 설정 확인 후 전체 스캔을 시작하고 실제 IPC 확인은 병렬로 계속한다.
 * @returns true=소켓 준비 확인, false=명령 범위 우회, undefined=사용자 hook 설정 유지
 */
export async function ensureOwnedFsmonitor(root: string, options: RunGitOptions = {}, globals: readonly string[] = [], background = false): Promise<boolean | undefined> {
  if (!active || process.platform !== "darwin") return undefined;
  const source = { ...process.env, ...options.env };
  const monitorGlobals = monitorPreparationGlobals(globals);
  const scope: string[] = [...monitorGlobals];
  for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_PARAMETERS"]) scope.push(source[name] ?? "");
  for (let index = 0; index < Math.min(Object.keys(source).length, Number(source.GIT_CONFIG_COUNT ?? 0)); index++) {
    const name = source[`GIT_CONFIG_KEY_${index}`] ?? "";
    if (/^(?:core\.fsmonitor|include)/i.test(name)) scope.push(name, source[`GIT_CONFIG_VALUE_${index}`] ?? "");
  }
  const key = `${root}\0${options.executable ?? "git"}\0${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`;
  const existing = preparing.get(key);
  if (existing) return background ? existing.fallback : existing.ready;
  const cached = prepared.get(key);
  if (cached && (cached.foreground || cached.expires > Date.now())) return cached.ready;
  const current = generation;
  let useFallback!: (ready: boolean | undefined) => void;
  const fallback = new Promise<boolean | undefined>(resolve => { useFallback = resolve; });
  const ready = prepare(root, key, options, current, monitorGlobals, useFallback).finally(() => {
    // 설정 실패·세션 종료도 첫 조회를 대기 상태로 남기지 않는다.
    useFallback(false);
    if (preparing.get(key) === task) preparing.delete(key);
  });
  const task = { ready, fallback }; preparing.set(key, task);
  if (background) logger?.("git monitor preparation running in background", { repoRoot: root, reason: "private-status-index" });
  return background ? fallback : ready;
}

/**
 * 감시자와 무관한 파일명 해석 옵션만 준비 문맥에서 제외해 status와 미추적 파일 열거가 같은 확인을 공유한다.
 * - 실제 호출의 인자는 그대로 두고 config·include·namespace 등 나머지 전역 옵션은 유지한다.
 * @param globals Git 하위 명령 앞의 전역 옵션. 값을 받는 옵션의 다음 인자는 제거하지 않는다.
 * @returns 감시자 식별 및 제외 경로 응답 확인에 사용할 별도 인자 배열
 */
function monitorPreparationGlobals(globals: readonly string[]): string[] {
  const pathspecOptions = new Set(["--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"]);
  const withValue = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  const result: string[] = [];
  for (let index = 0; index < globals.length; index++) {
    const option = globals[index];
    if (pathspecOptions.has(option)) continue;
    result.push(option);
    if (withValue.has(option) && index + 1 < globals.length) result.push(globals[++index]);
  }
  return result;
}

/** 명시적 false는 유지하며 불명확한 별도 Git directory에는 감시자를 새로 생성하지 않는다. */
async function prepareGitOptions(args: readonly string[], root: string, options: RunGitOptions): Promise<{ options: RunGitOptions; args?: string[] }> {
  if (options.signal && preparationSignals.has(options.signal)) return { options };
  const command = gitCommandPolicy(args);
  const crossWorktree = ["clone", "submodule"].includes(command.command) || (command.command === "worktree" && !command.readOnly);
  if (!active || process.platform !== "darwin" || (withoutIndex.has(command.command) && !crossWorktree)
      || (command.command === "fetch" && command.readOnly)) return { options };
  const explicit = explicitSetting(args, options.env);
  // 명시적 false/사용자 hook은 그대로 유지한다. bare -c와 --config-env의 true도 마지막 값으로 판정한다.
  if (explicit !== undefined && !/^(?:true|1|yes|on)$/i.test(explicit)) return { options };
  const current = generation;
  const opaque = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"].some(key => options.env?.[key] || process.env[key])
    || args.slice(0, gitCommandIndex(args)).some(value => value.startsWith("-C") || value === "--git-dir" || value.startsWith("--git-dir=") || value === "--work-tree" || value.startsWith("--work-tree="));
  const background = command.readOnly && isOwnedStatusIndex(options.env?.GIT_INDEX_FILE);
  const ready = opaque || crossWorktree ? false : await ensureOwnedFsmonitor(root, options, args.slice(0, gitCommandIndex(args)), background);
  if (!active || generation !== current) throw new GitError("Git session closed before command startup.", "", "", Object.assign(new Error("Session closed."), { code: "ABORT_ERR", killed: true }));
  if (ready !== false) return { options };
  const position = gitCommandIndex(args);
  return { args: [...args.slice(0, position), "-c", "core.fsmonitor=false", ...args.slice(position)],
    options: { ...options, env: withGitConfigOverrides(options.env ?? {}, { "core.fsmonitor": "false" }) } };
}

/** 시작 경쟁·실패 시 암묵적 detached 시작을 허용하지 않고 다음 명령을 전체 스캔으로 복구한다. */
async function prepare(root: string, key: string, options: RunGitOptions, current: number, globals: readonly string[],
  useFallback: (ready: boolean | undefined) => void): Promise<boolean | undefined> {
  const check = () => active && generation === current;
  const controller = new AbortController(); controllers.add(controller);
  preparationSignals.add(controller.signal);
  const readOptions: RunGitOptions = { executable: options.executable, env: options.env, readTimeoutMs: 2000, retryOnLock: false, signal: controller.signal };
  let entry: MonitorPreparation | undefined;
  let monitor: Promise<void> | undefined;
  let queryFailed = false;
  /** 모든 경로를 제외한 조회로 실제 IPC 응답만 확인한다. 파일 스캔·index 쓰기는 수행하지 않는다. */
  const confirmQuery = async () => {
    try {
      await runGit([...globals, "status", "--porcelain=v2", "--untracked-files=no", "--ignore-submodules=all", "--", ":(top,exclude)**"], root,
        { ...readOptions, readTimeoutMs: 1000 });
    } catch (error) { queryFailed = true; throw error; }
  };
  try {
    let configured: string;
    try { configured = (await runGit([...globals, "config", "--bool", "--get", "core.fsmonitor"], root, readOptions)).trim(); }
    catch (error) {
      // 사용자 hook 경로는 Git boolean이 아니므로 수명을 추측해 변경하지 않는다.
      if (error instanceof GitError && /bad boolean config value|bad config value/i.test(error.stderr)) { useFallback(undefined); return undefined; }
      throw error;
    }
    if (!check()) return false;
    if (configured !== "true") { prepared.set(key, { ready: false, foreground: false, expires: Date.now() + 5000 }); return false; }
    // 첫 private index는 전체 스캔으로 정확히 읽는다. 느린 FSEvents/IPC 확인은 이 결과의 선행 조건이 아니다.
    useFallback(false);
    let listening = false;
    try { await runGit(["fsmonitor--daemon", "status"], root, readOptions); listening = true; }
    catch (error) { if (!(error instanceof GitError) || error.code !== 1 || !check()) throw error; }
    if (listening) {
      if (!check()) return false;
      // status는 socket 연결만 확인하므로 FSEvents 응답이 막힌 daemon도 성공할 수 있다.
      await confirmQuery();
      if (!check()) return false;
      // 같은 새로고침의 status/diff/ls-files마다 추가 Git 두 개를 실행하지 않는다.
      prepared.set(key, { ready: true, foreground: false, expires: Date.now() + 5000 }); return true;
    }
    entry = { ready: false, foreground: true, expires: 0 }; prepared.set(key, entry);
    const own = entry;
    monitor = runGit(["fsmonitor--daemon", "run", "--no-detach"], root, { executable: options.executable, env: options.env, retryOnLock: false, signal: controller.signal })
      .then(() => undefined)
      .catch(() => { logger?.("owned git monitor exited", { repoRoot: root }); })
      .finally(() => { controllers.delete(controller); if (prepared.get(key) === own) prepared.delete(key); });
    for (let attempt = 0; attempt < 10 && check() && prepared.get(key) === entry; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      try {
        await runGit(["fsmonitor--daemon", "status"], root, readOptions);
      } catch (error) {
        // 아직 없는 소켓(exit=1)만 재확인한다. 시간 초과/IPC 오류를 반복하면 새 Git 실행 지연이 누적된다.
        if (!(error instanceof GitError) || error.code !== 1) break;
        continue;
      }
      if (!check() || prepared.get(key) !== entry) return false;
      try { await confirmQuery(); } catch { break; }
      if (!check() || prepared.get(key) !== entry) return false;
      entry.ready = true;
      logger?.("owned git monitor ready", { repoRoot: root }); return true;
    }
    // 시작만 하고 ready가 되지 않는 child를 남기지 않고 실제 close 후 fallback을 반환한다.
    controller.abort(); await monitor;
  } catch { /* 설정/미지원 Git/보안 계층 지연은 command-scope false로 복구한다. */ }
  finally { preparationSignals.delete(controller.signal); if (!entry || prepared.get(key) !== entry) controllers.delete(controller); }
  if (check() && (!entry || prepared.get(key) !== entry)) prepared.set(key, { ready: false, foreground: false, expires: Date.now() + (queryFailed ? 60_000 : 5000) });
  logger?.("git monitor startup bypassed", { repoRoot: root, reason: queryFailed ? "unresponsive-query" : "not-ready-or-unavailable" });
  return false;
}

/** command-scope의 마지막 fsmonitor 값을 argv>env 순서로 읽고 파일 인자·커밋 본문은 검사하지 않는다. */
function explicitSetting(args: readonly string[], env?: Record<string, string>): string | undefined {
  const source = { ...process.env, ...env }; let value: string | undefined;
  for (let index = 0; index < Math.min(Object.keys(source).length, Number(source.GIT_CONFIG_COUNT ?? 0)); index++) {
    if (source[`GIT_CONFIG_KEY_${index}`]?.toLowerCase() === "core.fsmonitor") value = source[`GIT_CONFIG_VALUE_${index}`];
  }
  const position = gitCommandIndex(args);
  for (let index = 0; index < position; index++) {
    const argument = args[index];
    const config = argument === "-c" ? args[++index] : argument.startsWith("-c") ? argument.slice(2) : undefined;
    const match = config && /^core\.fsmonitor(?:=(.*))?$/i.exec(config);
    if (match) value = match[1] ?? "true";
    const configEnv = argument === "--config-env" ? args[++index] : argument.startsWith("--config-env=") ? argument.slice("--config-env=".length) : undefined;
    const mapped = configEnv && /^core\.fsmonitor=(.+)$/i.exec(configEnv);
    if (mapped) value = source[mapped[1]];
  }
  return value;
}
