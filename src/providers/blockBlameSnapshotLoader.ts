// 심볼 조회와 Git 조회를 겹쳐 실행하고 표시 가능한 블록별 소유권 snapshot을 만든다.
import path from "node:path";
import type * as vscode from "vscode";
import type { BlockBlameSummary } from "../git/blockBlameModel";
import { summarizeFileBlame } from "../git/blockBlameBatch";
import { GitBlameService, type GitBlameLine } from "../git/blameService";
import type { GitServiceRegistry } from "../git/serviceRegistry";
import { logInfo } from "../ui/outputLog";
import type { BlockBlameSourceCache } from "./blockBlameSourceCache";

/** 같은 문서 버전에서 언어 심볼, 블록 요약과 토글에 쓸 전체 blame을 함께 보관한다. */
export interface BlockBlameSnapshot {
  documentVersion: number;
  summaries: BlockBlameSummary[];
  repoRoot?: string;
  cacheIdentity?: string;
  fileBlame?: readonly GitBlameLine[];
  skipReason?: "no-repository" | "no-supported-symbols";
}

/**
 * 저장소가 확인되면 느린 언어 서버를 기다리는 동안 blame을 미리 읽는다.
 * @param document 저장된 문서, registry 공유 저장소 탐색기, sources 문서별 심볼 캐시
 * @param signal snapshot의 마지막 소비자가 떠났을 때 전체 대기를 중단하는 신호
 * @returns 실제 Git 정보만으로 만든 요약. 빠른 빈 심볼 응답에는 Git을 실행하지 않는다.
 */
export async function loadBlockBlameSnapshot(
  document: vscode.TextDocument, registry: GitServiceRegistry, sources: BlockBlameSourceCache, signal: AbortSignal
): Promise<BlockBlameSnapshot> {
  signal.throwIfAborted();
  const startedAt = Date.now(), version = document.version;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let symbolsMs = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const blocksTask = sources.read(document, controller.signal).then(blocks => { symbolsMs = Date.now() - startedAt; return blocks; });
  void blocksTask.catch(() => undefined);
  try {
    const service = await registry.resolve(path.dirname(document.uri.fsPath));
    const repositoryMs = Date.now() - startedAt;
    controller.signal.throwIfAborted();
    if (!service) return { documentVersion: version, summaries: [], skipReason: "no-repository" };
    // 즉시 응답하는 일반 텍스트는 Git을 생략하고, 느린 언어 서버에만 최대 16ms 뒤 선행 조회한다.
    const quick = await Promise.race([
      blocksTask,
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 16); }),
    ]);
    if (timer) clearTimeout(timer);
    controller.signal.throwIfAborted();
    if (quick?.length === 0) return { documentVersion: version, summaries: [], skipReason: "no-supported-symbols" };
    let cacheIdentity: string | undefined;
    const blameStartedAt = Date.now();
    let blameMs = 0;
    const blameTask = new GitBlameService(service.repoRoot).getFileBlame(document.uri.fsPath, undefined, {
      signal: controller.signal, onCacheIdentity: value => { cacheIdentity = value; },
    }).then(blame => { blameMs = Date.now() - blameStartedAt; return blame; });
    void blameTask.catch(() => undefined);
    const blocks = quick ?? await blocksTask;
    controller.signal.throwIfAborted();
    if (!blocks.length) return { documentVersion: version, summaries: [], skipReason: "no-supported-symbols" };
    const blame = await blameTask;
    controller.signal.throwIfAborted();
    const summaryStartedAt = Date.now(), selected = blocks.slice(0, 400);
    const summaries = summarizeFileBlame(selected, blame).filter(summary => summary.primaryContributor !== undefined);
    logInfo("block blame code vision loaded", {
      path: service.toRepoRelative(document.uri.fsPath), symbols: blocks.length, displayed: summaries.length,
      truncated: blocks.length > selected.length, blameLines: blame.length,
      repositoryMs, symbolsMs, lookupMs: Math.max(repositoryMs, symbolsMs), blameMs,
      summaryMs: Date.now() - summaryStartedAt, durationMs: Date.now() - startedAt,
    });
    return { documentVersion: version, summaries, repoRoot: service.repoRoot, cacheIdentity, fileBlame: blame };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
