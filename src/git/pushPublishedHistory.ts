// 새 목적 브랜치가 없을 때도 같은 push 서버가 이미 가진 commit 이력을 Native 조회로 확인한다.
import type { RunGitOptions } from "./gitExec";
import type { PushGitRunner } from "./sequentialPush";

/** rev-list 인자와 후속 이력 계산에 넣는 검증된 제외 tip의 수를 제한한다. */
const MAX_PUBLISHED_TIPS = 64;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * 실제 push URL이 광고한 branch tip 중 로컬에서도 commit으로 검증한 OID만 반환한다.
 * - fetch URL·로컬 tracking ref·추측한 기본 브랜치를 증거로 쓰지 않고 객체를 fetch하지 않는다.
 * - 결과는 크기/새 commit 범위의 제외 집합이며 목적 브랜치의 lease에는 사용하지 않는다.
 * - 다른 서버/작업으로 재사용하는 캐시를 만들지 않는다. 알 수 없는 객체는 보수적으로 제외하지 않는다.
 * @param root source 저장소 @param url Git이 해석한 유일한 push URL
 * @param sourceHead 승인한 실제 source commit @param runner 공통 Git 경계 @param options 취소·원본 DAG 환경
 * @returns 현재 서버가 소유하고 로컬에서 읽을 수 있는 commit tip 최대 64개
 */
export async function readPublishedPushTips(
  root: string, url: string, sourceHead: string, runner: PushGitRunner, options: RunGitOptions
): Promise<string[]> {
  let output: string;
  try { output = await runner.run(["ls-remote", "--refs", "--heads", "--", url], root, options); }
  catch (error) {
    if (options.signal?.aborted) throw error;
    // URL에 자격 증명이 있을 수 있으므로 원본 transport 오류를 진행 이벤트/로그에 옮기지 않는다.
    throw new Error("Could not read the push destination. Check the remote connection and authentication.");
  }
  const tips = new Set<string>();
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const fields = line.split(/\s+/);
    if (fields.length !== 2 || !OID.test(fields[0]) || !fields[1].startsWith("refs/heads/")) {
      throw new Error("Could not read the remote branch commits.");
    }
    tips.add(fields[0]);
  }
  // 승인한 source 자체가 다른 원격 branch에 있으면 그 이력 전체를 이미 소유한다.
  if (tips.has(sourceHead)) return [sourceHead];
  if (!tips.size) return [];
  const requested = [...tips], selected: string[] = [];
  let position = 0, pending = "";
  /** batch-check의 입력과 같은 OID인지 확인하고 결측/비commit은 제외 증거로 채택하지 않는다. */
  const row = (line: string) => {
    const expected = requested[position++];
    if (!expected) throw new Error("Could not verify published Git objects.");
    if (line === `${expected} missing`) return;
    const [oid, type, extra] = line.split(" ");
    if (oid !== expected || extra !== undefined || !["commit", "tree", "blob", "tag"].includes(type)) {
      throw new Error("Could not verify published Git objects.");
    }
    if (type === "commit" && selected.length < MAX_PUBLISHED_TIPS) selected.push(oid);
  };
  /** 전체 객체 metadata 출력을 보관하지 않고 잘린 마지막 행만 다음 chunk와 합친다. */
  const consume = (chunk: Buffer) => {
    const text = pending + chunk.toString("utf8");
    let start = 0, end: number;
    while ((end = text.indexOf("\n", start)) >= 0) { row(text.slice(start, end).replace(/\r$/, "")); start = end + 1; }
    pending = text.slice(start);
    if (pending.length > 128) throw new Error("Could not verify published Git objects.");
  };
  const args = ["cat-file", "--batch-check=%(objectname) %(objecttype)"], input = requested.join("\n") + "\n";
  if (runner.inputStream) await runner.inputStream(args, root, input, consume, options);
  else consume(Buffer.from(await runner.input(args, root, input, options)));
  if (pending) row(pending.replace(/\r$/, ""));
  if (position !== requested.length) throw new Error("Could not verify published Git objects.");
  return selected;
}
