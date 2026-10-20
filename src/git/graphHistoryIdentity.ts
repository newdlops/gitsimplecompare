// ref가 같아도 shallow/graft 경계가 바뀌면 이전 DAG를 재사용하지 않도록 하는 작은 증거 조회.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { readRepositoryMetadata } from "./repositoryMetadata";

/**
 * Git 프로세스 없이 현재 object graph 해석 경계를 읽는다. 실패/큰 marker는 재사용 포기로 처리한다.
 * @param repoRoot 실제 작업트리 루트 @returns metadata 위치·shallow/graft·Git 환경의 SHA-256, 불확실하면 undefined
 */
export async function readGraphHistoryIdentity(repoRoot: string): Promise<string | undefined> {
  try {
    const metadata = await readRepositoryMetadata(repoRoot);
    if (!metadata) return undefined;
    const [shallow, grafts] = await Promise.all([
      marker(process.env.GIT_SHALLOW_FILE ? path.resolve(repoRoot, process.env.GIT_SHALLOW_FILE) : path.join(metadata.commonDir, "shallow")),
      marker(process.env.GIT_GRAFT_FILE ? path.resolve(repoRoot, process.env.GIT_GRAFT_FILE) : path.join(metadata.commonDir, "info", "grafts")),
    ]);
    const environment = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")).sort(([left], [right]) => left.localeCompare(right));
    return createHash("sha256").update(JSON.stringify([metadata.identity, shallow, grafts, environment])).digest("hex");
  } catch { return undefined; }
}

/** 부재는 정상 빈 값이며, 비정상·대형 marker는 읽기 비용을 늘리지 않고 전체 Git log에 맡긴다. */
async function marker(file: string): Promise<string> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Graph history marker is not a small regular file.");
    return await readFile(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
