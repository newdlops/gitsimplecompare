// 여러 Pull Request의 management mutation을 preview·제한 동시성 실행하는 서비스.
// - bulk review/merge는 다루지 않고 reviewer·assignee·label·milestone 같은 metadata 변경만 위임한다.
import {
  managementMutationToApply,
  previewPullRequestManagementMutation,
  PullRequestManagementService,
  type PullRequestManagementMutation,
  type PullRequestManagementPreview,
  type PullRequestManagementResult,
  type PullRequestManagementTarget,
} from "./pullRequestManagementService";

const MAX_BULK_CONCURRENCY = 3;

/** bulk preview/실행에 넣는 하나의 PR metadata 대상. */
export interface PullRequestManagementBulkTarget extends PullRequestManagementTarget {
  /** UI progress와 retry에서 쓸 안정된 repository#number key */
  key: string;
}

/** 한 PR의 read/preview 결과 또는 preview 단계 오류. */
export interface PullRequestManagementBulkPreviewItem {
  /** 원래 선택 대상 */
  target: PullRequestManagementBulkTarget;
  /** metadata를 읽고 계산한 preview */
  preview?: PullRequestManagementPreview;
  /** 권한·host 오류처럼 write 전에 확인한 skip 사유 */
  error?: string;
}

/** bulk write 한 항목의 완료 상태. */
export interface PullRequestManagementBulkResultItem {
  /** 실행 대상 */
  target: PullRequestManagementBulkTarget;
  /** 실제 mutation 후 authoritative verification 결과 */
  result?: PullRequestManagementResult;
  /** preview no-op 또는 execution 오류 */
  status: "applied" | "skipped" | "failed" | "cancelled";
  /** skipped/failed의 사용자 표시용 단일 문구 */
  message?: string;
}

/** bulk 작업 전체의 preview 결과. */
export interface PullRequestManagementBulkPreview {
  /** 모든 unique target의 preview 결과 */
  items: PullRequestManagementBulkPreviewItem[];
  /** 사용자가 확인하면 write할 실제 item 수 */
  eligibleCount: number;
  /** no-op/preview 오류로 write하지 않을 item 수 */
  skippedCount: number;
}

/** bulk 실행의 terminal 요약. */
export interface PullRequestManagementBulkSummary {
  /** 입력 순서를 보존한 항목 결과 */
  items: PullRequestManagementBulkResultItem[];
  /** GitHub write가 verified 또는 partial result로 끝난 수 */
  appliedCount: number;
  /** no-op 또는 preview failure로 건너뛴 수 */
  skippedCount: number;
  /** write/re-read가 실패한 수 */
  failedCount: number;
  /** 사용자가 취소해 GitHub write를 시작하지 않은 수 */
  cancelledCount: number;
  /** write는 완료됐지만 authoritative post-read가 모든 요청 값을 확인하지 못한 수 */
  partiallyVerifiedCount: number;
}

/** management service를 재사용해 multi-PR mutation의 preview와 bounded scheduler를 제공한다. */
export class PullRequestManagementBulkService {
  /** service를 주입해 scheduler를 실제 GitHub 호출 없이도 단위 검증한다. */
  public constructor(private readonly management: Pick<PullRequestManagementService, "readMetadata" | "apply">) {}

  /** 모든 선택 항목의 authoritative metadata를 읽고 실제 write 가능 항목만 구분한다. */
  public async preview(
    targets: readonly PullRequestManagementBulkTarget[],
    mutation: PullRequestManagementMutation,
    signal?: AbortSignal
  ): Promise<PullRequestManagementBulkPreview> {
    const targetsToPreview = uniqueTargets(targets);
    const items = await this.readPreviewItems(targetsToPreview, mutation, signal);
    const eligibleCount = items.filter((item) => item.preview?.canApply).length;
    return { items, eligibleCount, skippedCount: items.length - eligibleCount };
  }

  /** 대형 조직 queue도 GitHub API를 과도하게 병렬 호출하지 않도록 metadata read를 제한한다. */
  private async readPreviewItems(
    targets: readonly PullRequestManagementBulkTarget[],
    mutation: PullRequestManagementMutation,
    signal?: AbortSignal
  ): Promise<PullRequestManagementBulkPreviewItem[]> {
    const items: PullRequestManagementBulkPreviewItem[] = Array.from({ length: targets.length });
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_BULK_CONCURRENCY, targets.length) }, async () => {
      while (next < targets.length) {
        const index = next++;
        const target = targets[index];
        if (!target) continue;
        try {
          const metadata = await this.management.readMetadata(target, signal);
          items[index] = { target, preview: previewPullRequestManagementMutation(metadata, mutation) };
        } catch (error) {
          items[index] = { target, error: errorMessage(error) };
        }
      }
    });
    await Promise.all(workers);
    return items;
  }

  /** preview 당시의 실제 적용값만 최대 세 항목씩 병렬 실행하고 실패를 다른 PR에 전파하지 않는다.
   * 취소되면 새 write 예약을 멈추고, 아직 시작하지 않은 target을 cancelled 결과로 남긴다. */
  public async execute(preview: PullRequestManagementBulkPreview, signal?: AbortSignal): Promise<PullRequestManagementBulkSummary> {
    const results: PullRequestManagementBulkResultItem[] = preview.items.map((item) => {
      if (!item.preview?.canApply) {
        return { target: item.target, status: "skipped", message: item.error || "No metadata changes are needed." };
      }
      return { target: item.target, status: "skipped", message: "Pending execution." };
    });
    const eligible = preview.items.map((item, index) => ({ item, index })).filter(({ item }) => Boolean(item.preview?.canApply));
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_BULK_CONCURRENCY, eligible.length) }, async () => {
      while (next < eligible.length) {
        if (signal?.aborted) break;
        const current = eligible[next++];
        if (!current?.item.preview) continue;
        try {
          const result = await this.management.apply(current.item.target, managementMutationToApply(current.item.preview), signal);
          results[current.index] = { target: current.item.target, result, status: "applied" };
        } catch (error) {
          results[current.index] = signal?.aborted
            ? { target: current.item.target, status: "cancelled", message: "Cancelled before GitHub confirmed the update." }
            : { target: current.item.target, status: "failed", message: errorMessage(error) };
          if (signal?.aborted) break;
        }
      }
    });
    await Promise.all(workers);
    if (signal?.aborted) {
      results.forEach((item) => {
        if (item.message === "Pending execution.") {
          item.status = "cancelled";
          item.message = "Cancelled before starting the update.";
        }
      });
    }
    return {
      items: results,
      appliedCount: results.filter((item) => item.status === "applied").length,
      skippedCount: results.filter((item) => item.status === "skipped").length,
      failedCount: results.filter((item) => item.status === "failed").length,
      cancelledCount: results.filter((item) => item.status === "cancelled").length,
      partiallyVerifiedCount: results.filter((item) => item.status === "applied" && item.result?.verified === false).length,
    };
  }
}

/** 같은 PR을 두 번 선택해도 GitHub write는 한 번만 예약한다. */
function uniqueTargets(targets: readonly PullRequestManagementBulkTarget[]): PullRequestManagementBulkTarget[] {
  const unique = new Map<string, PullRequestManagementBulkTarget>();
  for (const target of targets) {
    const key = target.key.trim();
    if (key && !unique.has(key)) unique.set(key, target);
  }
  return [...unique.values()];
}

/** unknown gh error를 list UI가 표시할 수 있는 짧은 문구로 변환한다. */
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.replace(/\s+/g, " ").slice(0, 320) : "Unable to update pull request metadata.";
}
