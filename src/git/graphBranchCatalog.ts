// Graph 원격 추적 브랜치 카탈로그를 읽고 common Git dir 단위 요청을 합치는 모듈.
// - 네트워크 fetch 없이 로컬 refs/remotes만 읽으며, worktree별 UI 상태는 공유하지 않는다.
import { runGit } from "./gitExec";
import { logInfo } from "../ui/outputLog";
import type { GraphBranchRef } from "../webview/graphBranchFilter";

const FS = "\x1f";

/** 원격 ref의 UI 이름과 containment seed를 함께 보존하는 읽기 전용 레코드다. */
export interface GraphRemoteBranchTip extends GraphBranchRef { hash: string; fullRef: string; }
/** 원격 read를 테스트와 production에서 같은 계약으로 주입하기 위한 함수 타입이다. */
export type GraphBranchCatalogRunner = (args: string[], repoRoot: string, options?: { signal?: AbortSignal }) => Promise<string>;

/** 공통 Git dir의 실행 1회와 각 소비자의 독립 취소 상태를 묶는다. */
interface SharedRead {
  controller: AbortController;
  subscribers: Set<symbol>;
  promise: Promise<GraphRemoteBranchTip[]>;
}
interface CompletedRead { epoch: number; tips: GraphRemoteBranchTip[]; }
const completed = new Map<string, CompletedRead>();
const pending = new Map<string, SharedRead>();
const epochs = new Map<string, number>();
let resolvingCommonDirs = 0;
const runnerIds = new WeakMap<object, number>();
let nextRunnerId = 1;

/** common Git dir 단위 remote-tip singleflight를 제공하는 카탈로그다. */
export class GraphBranchCatalog {
  private readonly roots = new Map<string, string>();
  /** @param runner gitExec 경계를 기본값으로 쓰되 테스트에서 제어 가능한 loader를 허용한다. */
  constructor(private readonly runner: GraphBranchCatalogRunner = runGit) {}

  /**
   * 원격 추적 ref와 object ID를 읽는다. linked worktree는 common-dir identity를 공유한다.
   * @param repoRoot Git 저장소 또는 worktree 루트
   * @param signal 이 consumer만 취소하는 신호. 마지막 consumer가 취소될 때만 Git read를 중단한다.
   * @returns remote/HEAD를 제외한 원격 tip 레코드
   */
  async getRemoteTips(repoRoot: string, signal?: AbortSignal): Promise<GraphRemoteBranchTip[]> {
    let identity: string;
    resolvingCommonDirs++;
    try {
      identity = await this.commonDir(repoRoot, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      identity = `repo:${repoRoot}`;
    } finally {
      resolvingCommonDirs--;
      scheduleOrphanAbort();
    }
    this.roots.set(repoRoot, identity);
    const baseKey = `${runnerId(this.runner)}:${identity}`;
    const epoch = epochs.get(baseKey) ?? 0;
    const key = `${baseKey}:${epoch}`;
    const cached = completed.get(key);
    if (cached?.epoch === epoch) return cloneTips(cached.tips);
    let shared = pending.get(key);
    if (!shared) {
      const controller = new AbortController();
      shared = { controller, subscribers: new Set(), promise: this.readRemoteTips(repoRoot, controller.signal).then((tips) => {
        if ((epochs.get(baseKey) ?? 0) === epoch) completed.set(key, { epoch, tips });
        logInfo("graph remote catalog complete", { repoRoot, commonDir: identity, epoch, count: tips.length });
        return tips;
      }).finally(() => pending.delete(key)) };
      pending.set(key, shared);
      logInfo("graph remote catalog start", { repoRoot, commonDir: identity, epoch });
    } else {
      logInfo("graph remote catalog coalesce", { repoRoot, commonDir: identity, epoch, subscribers: shared.subscribers.size });
    }
    return this.subscribe(shared, signal);
  }

  /** UI branch filter가 필요한 이름/kind만 반환한다. */
  async getRemoteBranches(repoRoot: string, signal?: AbortSignal): Promise<GraphBranchRef[]> {
    return (await this.getRemoteTips(repoRoot, signal)).map(({ name, kind }) => ({ name, kind }));
  }

  /** ref epoch가 바뀐 저장소의 성공 캐시만 버린다. 실행 중인 consumer는 자신의 결과를 유지한다. */
  invalidate(repoRoot: string): void {
    const baseKey = `${runnerId(this.runner)}:${this.roots.get(repoRoot) ?? `repo:${repoRoot}`}`;
    const epoch = (epochs.get(baseKey) ?? 0) + 1;
    epochs.set(baseKey, epoch);
    completed.delete(`${baseKey}:${epoch - 1}`);
  }

  /** worktree가 공유하는 절대 common Git dir을 얻고 실패 시 호출부가 root 격리로 축소할 수 있게 한다. */
  private async commonDir(repoRoot: string, signal?: AbortSignal): Promise<string> {
    const value = (await this.runner(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot, { signal })).trim();
    if (!value) throw new Error("Git common dir is unavailable.");
    return value;
  }

  /** remote ref를 한 번만 읽어 UI ref와 containment tip에 필요한 모든 필드를 만든다. */
  private async readRemoteTips(repoRoot: string, signal: AbortSignal): Promise<GraphRemoteBranchTip[]> {
    const output = await this.runner(["for-each-ref", `--format=%(objectname)${FS}%(refname:short)${FS}%(refname)`, "refs/remotes"], repoRoot, { signal });
    return parseRemoteBranchTips(output);
  }

  /** 한 consumer의 취소가 다른 active consumer를 중단하지 않도록 shared promise를 구독한다. */
  private subscribe(shared: SharedRead, signal?: AbortSignal): Promise<GraphRemoteBranchTip[]> {
    if (signal?.aborted) { abortIfOrphan(shared); return Promise.reject(new DOMException("cancelled", "AbortError")); }
    const subscriber = Symbol("graph-remote-subscriber");
    shared.subscribers.add(subscriber);
    return new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener("abort", cancel); shared.subscribers.delete(subscriber); };
      const cancel = () => { finish(); abortIfOrphan(shared); reject(new DOMException("cancelled", "AbortError")); };
      signal?.addEventListener("abort", cancel, { once: true });
      void shared.promise.then((tips) => { finish(); resolve(cloneTips(tips)); }, (error) => { finish(); reject(error); });
    });
  }
}

/** common-dir 해석 중인 linked worktree가 있으면 기다렸다가 실제 무구독 read만 취소한다. */
function scheduleOrphanAbort(): void {
  setTimeout(() => {
    if (resolvingCommonDirs > 0) return;
    for (const shared of pending.values()) if (shared.subscribers.size === 0) shared.controller.abort();
  }, 0);
}

/** 마지막 subscriber가 빠진 read는 common-dir 해석자가 없을 때 즉시, 아니면 안전하게 지연 취소한다. */
function abortIfOrphan(shared: SharedRead): void {
  if (shared.subscribers.size > 0) return;
  if (resolvingCommonDirs === 0) { shared.controller.abort(); return; }
  scheduleOrphanAbort();
}

/** for-each-ref 출력을 remote/HEAD를 제외한 object-ID 포함 tip 목록으로 변환한다. */
export function parseRemoteBranchTips(output: string): GraphRemoteBranchTip[] {
  return output.split("\n").flatMap((line) => {
    const [hash, name, fullRef] = line.split(FS);
    return hash && name && fullRef?.startsWith("refs/remotes/") && !name.endsWith("/HEAD")
      ? [{ hash, name, fullRef, kind: "remote" as const }] : [];
  });
}

/** 기존 테스트/호출자가 name/kind parser를 쓸 수 있도록 얇은 호환 wrapper를 둔다. */
export function parseRemoteBranches(output: string): GraphBranchRef[] {
  return parseRemoteBranchTips(output).map(({ name, kind }) => ({ name, kind }));
}

/** module cache와 호출자 사이에서 mutable 배열/객체가 공유되지 않게 복사한다. */
function cloneTips(tips: readonly GraphRemoteBranchTip[]): GraphRemoteBranchTip[] { return tips.map((tip) => ({ ...tip })); }

/** runner identity도 key에 넣어 test double과 production process cache가 섞이지 않게 한다. */
function runnerId(runner: GraphBranchCatalogRunner): number {
  const object = runner as unknown as object;
  let id = runnerIds.get(object);
  if (!id) { id = nextRunnerId++; runnerIds.set(object, id); }
  return id;
}
