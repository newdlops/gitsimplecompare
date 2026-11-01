// Node 18 HTTPS 읽기: pool·deadline·body 상한·안전 오류·취소 종료를 하나의 자원 수명으로 관리한다.
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage, IncomingHttpHeaders } from "node:http";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import type { Readable } from "node:stream";
import { GitHubHttpPool } from "./githubHttpPool";
import { GitHubHttpCache } from "./githubHttpCache";
import { GitHubApiError } from "./githubApiError";
import type { GitHubReadRequest } from "./githubReadRequest";
import type { GitHubCredentialLease } from "./githubCredential";
import { logInfo } from "../ui/outputLog";
import { encodeRestPage, restPageMetadata, revalidateRestPageMetadata } from "./githubRestPages";

type RequestFactory = (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;
interface Options {
  operation: string; deadline: number; signal?: AbortSignal; maxBufferBytes?: number;
  policyGeneration?: number; queueMs?: number;
}
interface Timings { connectMs?: number; tlsMs?: number; responseMs?: number; bodyMs?: number; totalMs?: number; reused: boolean; bytes: number; wireBytes: number; }
interface Response { status: number; headers: IncomingHttpHeaders; body: string; }
class StaleSocketError extends Error {}
const ORIGIN = "https://api.github.com";

/** Node HTTPS 자원만 소유하며 기존 read queue의 동시 실행 수를 우회하지 않는다. */
export class GitHubHttpTransport {
  private readonly pool = new GitHubHttpPool();
  private readonly cache = new GitHubHttpCache();
  private readonly revoked = new Set<string>();
  private readonly active = new Map<AbortController, Promise<string>>();
  private readonly request: RequestFactory;
  private disposed = false;
  constructor(dependencies: { request?: RequestFactory } = {}) { this.request = dependencies.request ?? httpsRequest; }

  /**
   * 인증·origin·설정 세대를 고정해 요청을 실행하고 소유 stream/request close 뒤 settle한다.
   * @param request 서비스의 typed read, credential 논리 조회 lease, options 개별 요청 마감과 취소
   * @returns 완전한 JSON body. 부분 GraphQL은 안전한 구조화 오류로만 전달한다.
   */
  async read(request: GitHubReadRequest, credential: GitHubCredentialLease, options: Options): Promise<string> {
    options.signal?.throwIfAborted();
    if (this.disposed) throw new DOMException("GitHub HTTP disposed.", "AbortError");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(0, options.deadline - Date.now()));
    const context = `${ORIGIN}\0${options.policyGeneration ?? 0}\0${credential.key}`;
    const execution = this.execute(request, credential, { ...options, signal: controller.signal }, context).catch(error => {
      if (options.signal?.aborted || this.disposed) throw new DOMException("GitHub HTTP cancelled.", "AbortError");
      if (controller.signal.aborted || Date.now() >= options.deadline) throw new GitHubApiError("timeout", options.operation);
      throw error instanceof GitHubApiError ? error : new GitHubApiError("network", options.operation);
    }).finally(() => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort); this.active.delete(controller);
    });
    this.active.set(controller, execution);
    if (options.signal?.aborted) abort();
    return execution;
  }

  /** 계정 전환/종료로 소유 요청을 취소하고 모든 close를 기다린 뒤 메모리 자원을 비운다. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active.keys()) controller.abort();
    this.pool.dispose();
    await Promise.allSettled([...this.active.values()]);
    this.cache.clear(); this.revoked.clear();
  }

  /** REST 재검증·redirect와 유일한 stale socket 재시도도 같은 deadline/credential 안에서 수행한다. */
  private async execute(request: GitHubReadRequest, credential: GitHubCredentialLease, options: Options, context: string): Promise<string> {
    let path = request.kind === "graphql" ? "/graphql" : request.path;
    const accept = request.kind === "rest" ? request.accept : "application/vnd.github+json";
    const payload = request.kind === "graphql" ? JSON.stringify({ query: request.query, variables: request.variables, operationName: request.operationName }) : undefined;
    let redirects = 0, retried = false, unconditional = false;
    for (;;) {
      options.signal?.throwIfAborted();
      if (Date.now() >= options.deadline) throw new GitHubApiError("timeout", options.operation);
      if (this.revoked.has(context)) throw new GitHubApiError("auth", options.operation, 401);
      const retryAt = this.cache.retryAt(ORIGIN, context);
      if (retryAt) throw new GitHubApiError("rate-limit", options.operation, undefined, retryAt);
      const key = `${context}\0${accept}\0${path}`;
      const cached = request.kind === "rest" && !unconditional ? this.cache.get(key) : undefined;
      const agent = await this.pool.acquire(context, options.signal);
      let response: Response;
      try {
        response = await this.once(path, payload, accept, cached?.etag, credential, options, agent.agent);
      } catch (error) {
        if (error instanceof StaleSocketError && !retried && Date.now() < options.deadline && !options.signal?.aborted) {
          retried = true; logInfo("GitHub HTTP stale connection retry", { operation: options.operation }); continue;
        }
        throw error;
      } finally { agent.release(); }
      if (this.revoked.has(context)) throw new GitHubApiError("auth", options.operation, 401);
      const { status, headers, body } = response;
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (request.kind !== "rest" || !headers.location || ++redirects > 3) throw new GitHubApiError("redirect", options.operation, status);
        let target: URL;
        try { target = new URL(headers.location, ORIGIN + path); } catch { throw new GitHubApiError("redirect", options.operation, status); }
        if (target.origin !== ORIGIN || target.username || target.password || target.hash) throw new GitHubApiError("redirect", options.operation, status);
        path = target.pathname + target.search; continue;
      }
      if (status === 304 && request.kind === "rest") {
        if (cached) {
          const metadata = revalidateRestPageMetadata(cached.metadata, headers);
          this.cache.put(key, cached.value, metadata.etag ?? cached.etag, metadata);
          return request.responseMode === "page" ? encodeRestPage(cached.value, metadata) : cached.value;
        }
        if (unconditional) throw new GitHubApiError("http", options.operation, status);
        unconditional = true; continue;
      }
      if (status === 401) {
        this.revoked.add(context); this.cache.invalidate(context); this.pool.invalidate(context);
        while (this.revoked.size > 128) this.revoked.delete(this.revoked.values().next().value!);
        throw new GitHubApiError("auth", options.operation, status);
      }
      if (status === 403 || status === 429) {
        const primary = headers["x-ratelimit-remaining"] === "0";
        let secondary = status === 429;
        if (status === 403 && !primary) {
          try { secondary = /secondary rate limit|abuse detection/i.test(JSON.parse(body)?.message ?? ""); } catch { /* 원문은 로그에 전달하지 않는다. */ }
        }
        const retry = headerTime(headers["retry-after"], Date.now())
          ?? (primary ? Number(headers["x-ratelimit-reset"]) * 1000 : secondary ? Date.now() + 60_000 : undefined);
        if (retry && Number.isFinite(retry)) {
          this.cache.cooldown(primary ? context : ORIGIN, retry);
          throw new GitHubApiError("rate-limit", options.operation, status, retry);
        }
        throw new GitHubApiError("permission", options.operation, status);
      }
      if (status < 200 || status >= 300) {
        let missingCommit = false;
        if (status === 422) {
          try { missingCommit = /^no commit found for sha\b/i.test(JSON.parse(body)?.message ?? ""); } catch { /* 원문은 오류에 보관하지 않는다. */ }
        }
        throw new GitHubApiError("http", options.operation, status, undefined, undefined, missingCommit ? "missing-commit" : undefined);
      }
      let parsed: { errors?: unknown[] };
      try { parsed = JSON.parse(body); } catch { throw new GitHubApiError("http", options.operation, status); }
      if (request.kind === "graphql" && Array.isArray(parsed?.errors) && parsed.errors.length) {
        throw new GitHubApiError("graphql", options.operation, status, undefined, parsed);
      }
      if (request.kind === "rest") {
        const metadata = restPageMetadata(status, headers);
        if (status === 200) this.cache.put(key, body, headers.etag, metadata);
        if (request.responseMode === "page") return encodeRestPage(body, metadata);
      }
      return body;
    }
  }

  /** 단일 HTTPS 요청의 body·압축·socket 단계와 close를 추적하며 원문 네트워크 오류를 외부로 전달하지 않는다. */
  private once(path: string, payload: string | undefined, accept: string, etag: string | undefined,
    credential: GitHubCredentialLease, options: Options, agent: import("node:https").Agent): Promise<Response> {
    return new Promise((resolve, reject) => {
      const started = Date.now(), maximum = options.maxBufferBytes ?? 32 * 1024 * 1024;
      const timings: Timings = { reused: false, bytes: 0, wireBytes: 0 };
      const chunks: Buffer[] = [];
      let response: IncomingMessage | undefined, decoded: Readable | undefined, request: ClientRequest;
      let requestClosed = false, streamClosed = true, responseClosed = true, ended = false, failure: Error | undefined;
      let status = 0, headers: IncomingHttpHeaders = {}, responseAt = started, settled = false;
      /** 실제 자원 종료 전에는 resolve/reject하지 않아 실행 슬롯이 먼저 반환되지 않게 한다. */
      const finish = () => {
        if (settled || !requestClosed || !streamClosed || !responseClosed || (!ended && !failure)) return;
        settled = true; options.signal?.removeEventListener("abort", abort);
        timings.totalMs = Date.now() - started;
        logInfo("GitHub HTTP request closed", { operation: options.operation, transport: "http", status,
          credentialMs: credential.elapsedMs, queueMs: options.queueMs ?? 0, httpCount: 1, cliCount: 0, ...timings });
        failure ? reject(failure) : resolve({ status, headers, body: Buffer.concat(chunks).toString("utf8") });
      };
      /** 해당 요청과 decoder만 닫으며 공유 Agent나 다른 요청은 유지한다. */
      const stop = (error: Error) => {
        failure ??= error; decoded?.destroy(); response?.destroy(); request?.destroy(); finish();
      };
      const abort = () => stop(new DOMException("GitHub HTTP cancelled.", "AbortError"));
      try {
        request = this.request({ protocol: "https:", hostname: "api.github.com", port: 443, path,
          method: payload === undefined ? "GET" : "POST", agent, rejectUnauthorized: true,
          headers: { Authorization: credential.authorization(), Accept: accept, "User-Agent": "GitSimpleCompare",
            "Accept-Encoding": "gzip, deflate, br", "X-GitHub-Api-Version": "2022-11-28",
            ...(etag ? { "If-None-Match": etag } : {}),
            ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }) } }, res => {
          response = res; streamClosed = false; responseClosed = false; status = res.statusCode ?? 0; headers = res.headers;
          res.once("close", () => { responseClosed = true; finish(); });
          responseAt = Date.now(); timings.responseMs = responseAt - started; timings.reused = request.reusedSocket;
          const encoding = res.headers["content-encoding"]?.toLowerCase();
          decoded = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
            : encoding === "br" ? createBrotliDecompress() : res;
          if (encoding && !["gzip", "deflate", "br", "identity"].includes(encoding)) {
            decoded = res; res.once("close", () => { streamClosed = true; finish(); });
            stop(new GitHubApiError("http", options.operation, status)); return;
          }
          res.on("data", (chunk: Buffer) => {
            timings.wireBytes += chunk.length;
            if (timings.wireBytes > maximum) stop(new GitHubApiError("limit", options.operation, status));
          });
          res.once("error", () => stop(new GitHubApiError("network", options.operation, status)));
          res.once("aborted", () => stop(new GitHubApiError("network", options.operation, status)));
          decoded.on("data", (chunk: Buffer) => {
            timings.bytes += chunk.length;
            if (timings.bytes > maximum) stop(new GitHubApiError("limit", options.operation, status));
            else chunks.push(chunk);
          });
          decoded.once("error", () => stop(new GitHubApiError("network", options.operation, status)));
          decoded.once("end", () => { ended = true; timings.bodyMs = Date.now() - responseAt; finish(); });
          decoded.once("close", () => { streamClosed = true; if (!ended && !failure) failure = new GitHubApiError("network", options.operation, status); finish(); });
          if (decoded !== res) res.pipe(decoded as import("node:stream").Duplex);
        });
        request.once("socket", socket => {
          if (!request.reusedSocket) {
            socket.once("connect", () => { timings.connectMs = Date.now() - started; });
            (socket as import("node:tls").TLSSocket).once("secureConnect", () => { timings.tlsMs = Date.now() - started; });
          }
        });
        request.once("error", (error: NodeJS.ErrnoException) => {
          const stale = request.reusedSocket && !response && error.code === "ECONNRESET";
          failure ??= stale ? new StaleSocketError() : new GitHubApiError("network", options.operation);
          if (response) { decoded?.destroy(); response.destroy(); }
        });
        request.once("close", () => { requestClosed = true; if (!response && !failure) failure = new GitHubApiError("network", options.operation); finish(); });
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort(); else request.end(payload);
      } catch { failure ??= new GitHubApiError("network", options.operation); requestClosed = true; finish(); }
    });
  }
}

/** Retry-After의 초/HTTP date를 안전한 epoch로 변환하며 잘못된 값을 재시도 근거로 쓰지 않는다. */
function headerTime(value: string | string[] | undefined, now: number): number | undefined {
  if (typeof value !== "string") return undefined;
  const at = /^\d+(?:\.\d+)?$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(at) && at > now ? at : undefined;
}
