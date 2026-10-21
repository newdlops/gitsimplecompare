// outgoing 객체 크기 조회와 partial clone의 결측 metadata 복구를 전송/lease 로직에서 분리한다.
import { GitError, type RunGitOptions } from "./gitExec";
import type { PushGitRunner } from "./sequentialPush";
import { readNegotiatedPushBase } from "./pushNegotiatedHistory";
import { logInfo } from "../ui/outputLog";

/** 조회 중 결측 객체만 별도로 식별하며 잘못된 숫자·timeout은 협상 fallback으로 숨기지 않는다. */
class MissingOutgoingObjects extends Error {
  /** 기존 크기 추정 실패 메시지를 유지하되 내부에서만 결측을 구분한다. */
  constructor() { super("Could not estimate the outgoing Git objects."); }
}

/**
 * 먼저 객체 다운로드 없는 크기 추정을 하고, promisor 결측일 때만 공유 이력을 협상한다.
 * @param root 저장소 @param head 승인한 source @param excluded 서버가 소유한 기존 tip
 * @param url 실제 push URL @param runner Git 경계 @param options 원본 DAG·취소·deadline
 * @returns 정확한 합계와 추가 검증한 base. 확인 불가 시 기존 Native 크기 조회를 한 번 실행한다.
 */
export async function estimateOutgoingObjectBytes(root: string, head: string, excluded: readonly string[], url: string,
  runner: PushGitRunner, options: RunGitOptions): Promise<{ bytes: number; negotiatedBase?: string }> {
  const localOptions = { ...options, env: { ...options.env, GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" } };
  let missing: unknown;
  try { return { bytes: await estimate(root, head, excluded, runner, localOptions) }; }
  catch (error) { if (!isMissing(error)) throw error; missing = error; }
  const proof = await readNegotiatedPushBase(root, url, head, excluded, runner, options);
  if (!proof.promisor) throw missing;
  const next = proof.base ? [...excluded, proof.base] : excluded;
  if (proof.base) {
    try { return { bytes: await estimate(root, head, next, runner, localOptions), negotiatedBase: proof.base }; }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  logInfo("push object size fallback", { repoRoot: root, reason: proof.base ? "missingObjectsAfterNegotiation" : "sharedBaseUnavailable" });
  return { bytes: await estimate(root, head, next, runner, options), negotiatedBase: proof.base };
}

/** 결측의 기계 출력/고정 C locale 오류만 구분한다. 권한·구문·취소·제한 시간은 원래대로 전파한다. */
function isMissing(error: unknown): boolean {
  return error instanceof MissingOutgoingObjects || error instanceof GitError && error.code === 128 &&
    /^fatal: (?:bad (?:tree )?object |missing (?:blob|tree|commit) object ['"]?)(?:[a-f0-9]{40}|[a-f0-9]{64})(?:['"]|\s|$)/im.test(error.stderr);
}

/**
 * 원본 DAG의 신규 commit/tree/blob 크기를 bounded pipe로 합산한다. 실제 pack/네트워크 크기는 아니다.
 * @param root 저장소 @param head source OID @param excluded 검증한 제외 OID @param runner transport @param options 조회 환경
 * @returns safe integer인 압축 전 객체 크기 합계. 모든 자식 close 뒤에만 성공한다.
 */
async function estimate(root: string, head: string, excluded: readonly string[], runner: PushGitRunner, options: RunGitOptions): Promise<number> {
  const objectArgs = ["rev-list", "--objects", "--no-object-names", head, ...excluded.map(tip => `^${tip}`), "--"];
  let bytes = 0, pending = "";
  /** 숫자와 결측 응답을 구별하며 부분 결과나 safe integer overflow를 성공으로 반환하지 않는다. */
  const addSize = (raw: string) => {
    const line = raw.trim(); if (!line) return;
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64}) missing$/.test(line)) throw new MissingOutgoingObjects();
    const value = Number(line);
    if (!/^\d+$/.test(line) || !Number.isSafeInteger(value) || !Number.isSafeInteger(bytes + value)) throw new Error("Could not estimate the outgoing Git objects.");
    bytes += value;
  };
  /** 숫자/결측 행의 chunk 경계만 보존하며 전체 객체 목록·숫자 배열은 만들지 않는다. */
  const consume = (chunk: Buffer) => {
    const text = pending + chunk.toString("utf8"); let start = 0, end: number;
    while ((end = text.indexOf("\n", start)) >= 0) { addSize(text.slice(start, end)); start = end + 1; }
    pending = text.slice(start); if (pending.length > 80) throw new Error("Could not estimate the outgoing Git objects.");
  };
  const args = ["cat-file", "--batch-check=%(objectsize)", "--buffer"];
  if (runner.pipe) await runner.pipe(objectArgs, args, root, consume, options);
  else {
    const objects = await runner.run(objectArgs, root, options);
    if (runner.inputStream) await runner.inputStream(args, root, objects, consume, options);
    else consume(Buffer.from(await runner.input(args, root, objects, options)));
  }
  addSize(pending); return bytes;
}
