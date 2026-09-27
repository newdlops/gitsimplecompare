// 저장소의 commit-graph 상태를 확인하고, 사용자가 요청하면 생성하는 git 모듈.
// - commit-graph 가 없으면 `git log --topo-order` 가 첫 줄을 내기 전에 전체 이력을 훑어야 해서 큰 저장소의
//   Git Graph 첫 표시가 수 배 느려진다. 생성은 `git gc` 가 하는 것과 같은 읽기 가속 파일 쓰기다.
// - vscode API 에 의존하지 않는다. 제안 여부 판단과 알림은 ui/commitGraphOffer 가 맡는다.
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";

/** 사용자가 "다시 묻지 않기"를 고르면 저장소 로컬 config 에 남기는 키. */
export const COMMIT_GRAPH_OFFER_CONFIG_KEY = "gitsimplecompare.offerCommitGraph";

/**
 * 저장소에 commit-graph 파일(단일 또는 split chain)이 있는지 확인한다.
 * - linked worktree 에서도 공용 objects 경로를 가리키도록 `rev-parse --git-path` 로 위치를 얻는다.
 * @param repoRoot 저장소 또는 worktree 루트
 * @returns commit-graph 가 하나라도 있으면 true
 */
export async function hasCommitGraph(repoRoot: string): Promise<boolean> {
  const out = await runGit(
    ["rev-parse", "--git-path", "objects/info/commit-graph", "--git-path", "objects/info/commit-graphs"],
    repoRoot
  );
  const candidates = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((value) => path.resolve(repoRoot, value));
  for (const candidate of candidates) {
    if (await stat(candidate).then(() => true, () => false)) {
      return true;
    }
  }
  return false;
}

/**
 * commit-graph 제안을 하지 말아야 하는 저장소인지 확인한다.
 * - 사용자가 `core.commitGraph=false` 로 끈 경우와, 이 저장소에서 "다시 묻지 않기"를 고른 경우다.
 * @param repoRoot 저장소 루트
 * @returns 제안을 건너뛰어야 하면 true
 */
export async function isCommitGraphOfferSuppressed(repoRoot: string): Promise<boolean> {
  const [coreSetting, offerSetting] = await Promise.all([
    runGit(["config", "--get", "core.commitGraph"], repoRoot).catch(() => ""),
    runGit(["config", "--get", COMMIT_GRAPH_OFFER_CONFIG_KEY], repoRoot).catch(() => ""),
  ]);
  return coreSetting.trim().toLowerCase() === "false" || offerSetting.trim().toLowerCase() === "false";
}

/**
 * 이 저장소에서 commit-graph 제안을 다시 하지 않도록 로컬 config 에 기록한다.
 * @param repoRoot 저장소 루트
 */
export async function suppressCommitGraphOffer(repoRoot: string): Promise<void> {
  await runGit(["config", "--local", COMMIT_GRAPH_OFFER_CONFIG_KEY, "false"], repoRoot);
}

/**
 * 도달 가능한 모든 커밋으로 commit-graph 를 쓴다(`git commit-graph write --reachable`).
 * - changed-path bloom filter 는 쓰지 않는다. 모든 커밋의 diff 를 계산해야 해 오래 걸리고,
 *   partial clone 에서는 tree 를 원격에서 받아오게 될 수 있기 때문이다.
 * @param repoRoot 저장소 루트
 */
export async function writeCommitGraph(repoRoot: string): Promise<void> {
  await runGit(["commit-graph", "write", "--reachable"], repoRoot);
}
