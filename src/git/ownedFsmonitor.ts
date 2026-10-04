import { GitError, runGit } from "./gitExec";
import type { GitProcessLogger } from "./gitProcessRegistry";

let enabled: ((root: string) => boolean) | undefined;
let logger: GitProcessLogger | undefined;
const preparing = new Map<string, Promise<void>>();
const prepared = new Set<string>();

/** 공식 stop으로 관찰한 감시자 종료 뒤에는 다음 사용 때 소유권을 새로 확인한다. */
export function forgetPreparedFsmonitor(root: string): void { prepared.delete(root); }

/** 자동 정리를 사용자가 켠 경우에만 새로 필요한 감시자를 직접 소유하도록 정책을 주입한다. */
export function setOwnedFsmonitorPolicy(policy: (root: string) => boolean, log: GitProcessLogger): () => void {
  enabled = policy; logger = log;
  return () => { if (enabled === policy) { enabled = undefined; logger = undefined; prepared.clear(); } };
}

/**
 * 이미 실행 중인 감시자를 재시작하지 않고, Git이 새로 시작할 감시자만 foreground child로 생성한다.
 * @param root 실제 상태 조회를 요청한 저장소
 * @returns 확인/시작 준비가 끝나는 Promise. 준비 실패가 authoritative status를 막지 않는다.
 */
export async function ensureOwnedFsmonitor(root: string): Promise<void> {
  if (process.platform !== "darwin" || !enabled?.(root) || prepared.has(root)) return;
  const existing = preparing.get(root);
  if (existing) return existing;
  const pending = prepare(root).finally(() => preparing.delete(root));
  preparing.set(root, pending);
  await pending;
}

/** Git의 기존 fsmonitor=true 설정을 그대로 따르며 이미 떠 있는 외부 감시자는 보호한다. */
async function prepare(root: string): Promise<void> {
  try {
    if ((await runGit(["config", "--bool", "--get", "core.fsmonitor"], root)).trim() !== "true" || !enabled?.(root)) return;
    try {
      await runGit(["fsmonitor--daemon", "status"], root, { readTimeoutMs: 2000, retryOnLock: false });
      return;
    } catch (error) {
      if (!(error instanceof GitError) || error.code !== 1 || !enabled?.(root)) return;
    }
    prepared.add(root);
    void runGit(["fsmonitor--daemon", "run", "--no-detach"], root, { retryOnLock: false })
      .catch(() => { logger?.("owned git monitor exited", { repoRoot: root }); })
      .finally(() => prepared.delete(root));
    // 상태 조회가 별도 감시자를 경쟁 생성하지 않도록 소켓 준비를 짧게 확인한다.
    for (let attempt = 0; attempt < 10 && enabled?.(root); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      try { await runGit(["fsmonitor--daemon", "status"], root, { readTimeoutMs: 2000, retryOnLock: false }); return; }
      catch { if (!prepared.has(root)) return; }
    }
  } catch { logger?.("owned git monitor preparation skipped", { repoRoot: root, reason: "unavailable-or-not-configured" }); }
}
