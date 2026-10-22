// 실제 버튼의 지연 원인을 조사하는 선택적 계측. 기본 비교에서는 설치하지 않아 관찰 비용을 섞지 않는다.
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import type { TestContext } from "node:test";
import { gitCommandIndex } from "../../src/git/gitCommandPolicy";
import { gitProcesses } from "../../src/git/gitProcessRegistry";

interface Interval { start: number; end: number }
interface GitInterval extends Interval {
  command: string; shape: string; pid?: number; spawnMs: number;
  exitMs?: number; closeMs?: number; registryStartMs?: number; registryEndMs?: number;
}
interface FileInterval extends Interval { method: string; shape: string; outcome: "success" | "error" }

/** 고정된 Git 조회 형태만 구분하며 경로·branch·메시지 등 원래 인자 값은 내보내지 않는다. */
function gitShape(args: readonly string[]): string {
  const command = args[gitCommandIndex(args)];
  if (command === "rev-parse") {
    if (args.includes("--absolute-git-dir") && args.includes("--symbolic-full-name")) return "checkout-identity";
    if (args.includes("--git-path")) return "private-state-path";
    if (args.includes("--git-dir") || args.includes("--absolute-git-dir")) return "directory";
    if (args.includes("@{u}")) return "upstream";
  }
  return command;
}

/** private fixture의 파일명도 전체 경로 없이 고정 종류로만 분류한다. */
function fileShape(value: unknown): string {
  const name = String(value).replace(/\\/g, "/");
  if (name.endsWith("/.git")) return "metadata-locator";
  if (name.endsWith("/commondir")) return "common-directory-marker";
  if (/\/gitsimplecompare\/rebase-session\.json(?:\.|$)/.test(name)) return "rebase-session";
  if (/\/(?:HEAD|REBASE_HEAD)$/.test(name)) return "native-head";
  if (name.endsWith("/rebaseEditor.js")) return "bundled-editor";
  return "other";
}

/** 겹친 대기를 중복 합산하지 않고 실제 관측한 구간의 합집합 길이를 구한다. */
function unionMs(intervals: readonly Interval[]): number {
  const sorted = intervals.slice().sort((a,b) => a.start - b.start);
  let total = 0, end = 0;
  for (const interval of sorted) {
    total += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return Math.round(total * 10) / 10;
}

/**
 * 테스트가 소유한 Native/파일 IO를 그대로 실행하며 버튼 구간의 대기만 선택적으로 관찰한다.
 * @param t mock을 원래 메서드로 복원할 테스트 수명
 * @param options filesystem=false이면 파일 IO wrapper를 설치하지 않아 프로세스 관찰만 수행한다.
 * @returns 활성화/종료 함수와 민감한 값 없는 진단 결과. 종료 시각은 Node가 관측한 경계다.
 */
export function createGraphButtonDiagnostics(t: Pick<TestContext, "mock">, options: { filesystem?: boolean } = {}) {
  let active = false, started = 0;
  const git: GitInterval[] = [], files: FileInterval[] = [];
  const children = new WeakMap<childProcess.ChildProcess, GitInterval>(), registered = new Map<number, GitInterval>();
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const observed = active && (args[0] === "git" || /[/\\]git(?:\.exe)?$/.test(String(args[0])));
    const began = performance.now();
    const child = (spawn as Function)(...args);
    if (observed) {
      const interval: GitInterval = { command: args[1][gitCommandIndex(args[1])], shape: gitShape(args[1]), pid: child.pid,
        spawnMs: performance.now() - began, start: began - started, end: began - started };
      git.push(interval);
      children.set(child, interval);
      child.once("exit", () => { interval.exitMs = performance.now() - began; });
      child.once("close", () => { interval.closeMs = performance.now() - began; interval.end = performance.now() - started; });
    }
    return child;
  });
  const register = gitProcesses.register.bind(gitProcesses), closed = gitProcesses.closed.bind(gitProcesses);
  t.mock.method(gitProcesses, "register", (...args: Parameters<typeof register>) => {
    const id = register(...args), interval = children.get(args[0]);
    if (interval) registered.set(id, interval);
    return id;
  });
  t.mock.method(gitProcesses, "closed", async (id: number) => {
    const interval = registered.get(id);
    if (interval) interval.registryStartMs = performance.now() - started;
    try { await closed(id); }
    finally { if (interval) { interval.registryEndMs = performance.now() - started; registered.delete(id); } }
  });
  for (const method of options.filesystem === false ? [] : ["stat", "lstat", "realpath", "readFile", "readdir", "access", "mkdir", "open", "rename", "unlink", "writeFile", "rm"] as const) {
    const original = fs[method];
    t.mock.method(fs, method, async (...args: any[]) => {
      const observed = active, began = performance.now();
      let outcome: FileInterval["outcome"] = "success";
      try { return await (original as Function)(...args); }
      catch (error) { outcome = "error"; throw error; }
      finally { if (observed) files.push({ method, shape: fileShape(args[0]), start: began - started, end: performance.now() - started, outcome }); }
    });
  }
  return {
    /** fixture·초기 Graph 준비가 끝난 실제 클릭 직전에만 계측을 시작한다. */
    start() { git.length = 0; files.length = 0; started = performance.now(); active = true; },
    /**
     * Native 검증용 사후 조회를 제외하고 클릭부터 settle까지의 모든 원래 관측치를 반환한다.
     * @returns 동시에 진행한 Git/FS 대기의 합집합과 개별 구간. CPU attribution은 시도하지 않는다.
     */
    finish() {
      active = false;
      const elapsedMs = performance.now() - started, all = [...git, ...files];
      return { scope: "instrumented diagnostic only; Node-observed spawn/exit/stdio-close/registry completion, not pure OS execution. Wrappers add overhead; not comparative latency evidence",
        filesystemObserved: options.filesystem !== false,
        elapsedMs: Math.round(elapsedMs), nativeUnionMs: unionMs(git), fsUnionMs: unionMs(files),
        observedUnionMs: unionMs(all), otherMs: Math.round(elapsedMs - unionMs(all)),
        git: git.map(item => ({ ...item, elapsedMs: Math.round((item.end - item.start) * 10) / 10 })),
        filesystem: [...new Set(files.map(item => item.method + ":" + item.shape))].map(key => {
          const rows = files.filter(item => item.method + ":" + item.shape === key);
          return { kind: key, calls: rows.length, sumElapsedMs: Math.round(rows.reduce((sum,item) => sum + item.end - item.start, 0) * 10) / 10,
            errors: rows.filter(item => item.outcome === "error").length };
        }) };
    },
  };
}

/**
 * 재검증 후보의 수명만 기록한다. getter를 따로 호출하거나 Git/캐시 값을 예열하지 않는다.
 * @param t 복원할 시험 문맥 @param cache 이 fixture가 소유한 cache
 * @returns 인자·ref·환경 원문 없는 관찰 결과. wrapper 비용이 있어 비교용 시간에는 사용하지 않는다.
 */
export function traceLocalOnlySnapshot(t: Pick<TestContext, "mock">, cache: any) {
  const rows: unknown[] = [];
  /** 내부 자료를 읽기만 하고 후보 승인·완료 cache 채택은 제품의 호출에 맡긴다. */
  const state = () => ({ ready: cache.remoteReady, completed: !!cache.completed, pending: !!cache.pending,
    proof: !!cache.reuse?.history, localFresh: cache.reuse?.localReady, remoteFresh: cache.reuse?.remoteReady,
    verified: !!cache.reuse?.completed, candidate: !!cache.reuse?.candidate,
    sameHistory: cache.reuse?.candidate?.history === cache.reuse?.history,
    sameKey: cache.reuse?.candidate?.key === cache.snapshotKey });
  for (const name of ["beginSnapshot","setLocalBranches","setRemoteTips","setRemoteUnavailable","invalidate","cancel","getMap","getReadOnlyMap","peek"]) {
    if (typeof cache[name] !== "function") continue;
    const original = cache[name].bind(cache);
    t.mock.method(cache,name,(...args:any[]) => {
      const before=state(), result=original(...args);
      rows.push({name,...(["invalidate","cancel"].includes(name)?{reason:args[0]}:{}),before,after:state()});
      if(result instanceof Promise) return result.finally(()=>{rows.push({name:name+":settled",after:state()});});
      return result;
    });
  }
  return () => ({ scope:"instrumented diagnostic only; no comparative timing claim", rows });
}
