// Graph 무한 스크롤 한 페이지의 계획(건너뛸지·어디서부터 몇 개)과 Git 읽기를 담당하는 모듈.
// - GraphPanel 은 누적 상태와 게시만 소유하고, 페이지 범위 계산(순수)과 status·log 병렬 읽기는 여기서 한다.
import type { GitLogService } from "../git/gitLogService";
import type { Commit } from "../graph/graphTypes";
import { type GraphPerformanceTrace, logGraphPerformancePhase } from "./graphPerformance";
import type { GraphLoadDirection } from "./graphProtocol";

/** 페이지 요청을 실행하지 않고 현재 상태만 다시 알릴 이유. */
export type GraphPageSkipReason = "alreadyLoading" | "noNewerCommits" | "noMoreCommits";

/** 페이지 요청 판단에 필요한 패널 누적 상태. */
export interface GraphPageCursor {
  reset: boolean;
  direction: GraphLoadDirection;
  loading: boolean;
  exhausted: boolean;
  rangeStartIndex: number;
}

/**
 * 이번 페이지 요청을 실행하지 않아도 되는지 판단한다.
 * - 이미 읽는 중이거나, 더 새 커밋/더 오래된 커밋이 없으면 Git 을 실행하지 않는다.
 * @param cursor 패널의 현재 로딩 상태
 * @returns 건너뛸 이유. 실행해야 하면 undefined
 */
export function graphPageSkipReason(cursor: GraphPageCursor): GraphPageSkipReason | undefined {
  if (cursor.loading) return "alreadyLoading";
  if (!cursor.reset && cursor.direction === "newer" && cursor.rangeStartIndex <= 0) return "noNewerCommits";
  if (!cursor.reset && cursor.direction === "older" && cursor.exhausted) return "noMoreCommits";
  return undefined;
}

/**
 * 누적 범위를 기준으로 이번에 읽을 git log 구간을 계산한다.
 * - older 는 끝 다음부터 pageSize+1(끝 여부 확인용)개, newer 는 앞쪽의 남은 구간만큼 읽는다.
 * @param direction 확장 방향
 * @param rangeStartIndex 누적 목록의 첫 커밋이 전체 topo-order 에서 차지하는 위치
 * @param loadedCount 누적 커밋 수
 * @param pageSize 한 페이지 커밋 수
 * @returns git log `--skip` 값과 읽을 개수(0 이하이면 읽을 것이 없다)
 */
export function graphPageRange(
  direction: GraphLoadDirection,
  rangeStartIndex: number,
  loadedCount: number,
  pageSize: number
): { skip: number; readLimit: number } {
  if (direction === "newer") {
    const prependCount = Math.min(pageSize, rangeStartIndex);
    return { skip: rangeStartIndex - prependCount, readLimit: prependCount };
  }
  return { skip: rangeStartIndex + loadedCount, readLimit: pageSize + 1 };
}

/** 한 페이지 읽기 결과. */
export interface GraphPageData {
  /** 첫 페이지에서 함께 읽은 staged/working 가상 커밋. 읽지 않았으면 undefined */
  virtualCommits?: Commit[];
  page: Commit[];
  /** git log 에 걸린 시간(ms). commit-graph 제안 판단에 쓴다. */
  gitLogMs: number;
}

/**
 * 한 페이지의 git log 와 (첫 페이지면) 작업트리 status 를 동시에 읽는다.
 * - 큰 작업트리의 status 가 git log 를 막지 않게 병렬로 실행하고, 레이아웃 전에 둘 다 기다린다.
 * @param service 대상 저장소 로그 서비스
 * @param options 읽을 구간·ref 범위·가상 커밋 필요 여부·성능 trace
 * @returns 페이지 커밋, 가상 커밋, git log 소요 시간
 */
export async function readGraphPageData(
  service: GitLogService,
  options: {
    skip: number;
    readLimit: number;
    refs: string[];
    readVirtualCommits: boolean;
    trace?: GraphPerformanceTrace;
  }
): Promise<GraphPageData> {
  const statusStarted = Date.now();
  const virtualRead = options.readVirtualCommits
    ? service.getVirtualCommits().then((commits) => {
        logGraphPerformancePhase(options.trace, "status", Date.now() - statusStarted, {
          virtualCommits: commits.length,
        });
        return commits;
      })
    : Promise.resolve(undefined);
  const logStarted = Date.now();
  const pageRead = service.getCommitPage(options.readLimit, options.skip, options.refs, false).then((page) => {
    const gitLogMs = Date.now() - logStarted;
    logGraphPerformancePhase(options.trace, "gitLog", gitLogMs, {
      skip: options.skip,
      limit: options.readLimit,
      fetchedCount: page.length,
      refCount: options.refs.length,
    });
    return { page, gitLogMs };
  });
  const [virtualCommits, { page, gitLogMs }] = await Promise.all([virtualRead, pageRead]);
  return { virtualCommits, page, gitLogMs };
}
