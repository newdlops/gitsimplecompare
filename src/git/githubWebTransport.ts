// GitHub 웹 HTML의 HTTPS·압축·body 한도와 실제 close를 관리한다. API 인증 transport와 공유하지 않는다.
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import type { Readable } from "node:stream";
import type { GitHubWebHtmlRead } from "./githubWebHtml";

type RequestFactory = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
interface Response { status: number; location?: string; html: string; }
interface Dependencies { request?: RequestFactory; ownedAgent?: boolean; maxBytes?: number; }

/** HTML 읽기 한 context만 소유한다. Host 정책 미확인 때 Agent를 지정하지 않아 기존 HTTPS 관리를 보존한다. */
export class GitHubWebTransport {
  private readonly agent?: Agent;
  private readonly request: RequestFactory;
  private readonly maximum: number;
  private readonly active = new Map<AbortController, Promise<GitHubWebHtmlRead>>();
  private disposed = false;
  private readonly counts = { requests: 0, wireBytes: 0, decodedBytes: 0, reused: 0 };

  /** @param dependencies 검증된 Agent 허용 여부와 테스트용 HTTPS 경계/byte 한도 */
  constructor(dependencies: Dependencies = {}) {
    this.request = dependencies.request ?? httpsRequest;
    this.maximum = dependencies.maxBytes ?? 64 * 1024 * 1024;
    if (dependencies.ownedAgent) this.agent = new Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2, maxTotalSockets: 2 });
  }

  /**
   * 같은 origin의 redirect만 최대 5회 따르고 압축 해제한 HTML을 반환한다.
   * @param source GitHub HTTPS URL, headers 호출 당시 인증/Accept, signal context의 전체 마감/취소
   * @returns 민감한 원문을 포함하지 않는 성공/실패. 실제 request/response/decoder close 뒤 settle한다.
   */
  read(source: string, headers: Record<string, string>, signal: AbortSignal): Promise<GitHubWebHtmlRead> {
    if (this.disposed || signal.aborted) return Promise.resolve({ ok: false, reason: "request cancelled" });
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const execution = this.follow(source, { ...headers }, controller.signal).catch(() => ({ ok: false as const, reason: "web html connection failed" }))
      .finally(() => { signal.removeEventListener("abort", abort); this.active.delete(controller); });
    this.active.set(controller, execution);
    if (signal.aborted) abort();
    return execution;
  }

  /** 비민감 요청/byte/reuse 집계만 복사한다. URL·header·body는 포함하지 않는다. */
  metrics() { return { ...this.counts }; }

  /** 소유 요청을 취소하고 세 종류 close를 기다린 뒤 Agent의 idle socket을 닫는다. 여러 번 호출해도 안전하다. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled([...this.active.values()]);
    this.agent?.destroy();
  }

  /** URL과 redirect의 origin을 매번 확인해 인증 header의 외부 전송을 막는다. */
  private async follow(source: string, headers: Record<string, string>, signal: AbortSignal): Promise<GitHubWebHtmlRead> {
    let url: URL;
    try { url = safeWebUrl(source); } catch { return { ok: false, reason: "unsafe web URL" }; }
    for (let redirects = 0; ; redirects++) {
      if (signal.aborted) return { ok: false, reason: "request cancelled" };
      const response = await this.once(url, headers, signal);
      if ("ok" in response) return response;
      if (response.status >= 300 && response.status < 400 && response.location) {
        if (redirects >= 5) return { ok: false, reason: "too many web redirects" };
        try {
          const next = safeWebUrl(new URL(response.location, url).toString());
          if (next.origin !== url.origin) throw new Error();
          url = next;
        } catch { return { ok: false, reason: "unsafe web redirect" }; }
        continue;
      }
      return response.status === 200 ? { ok: true, html: response.html, finalUrl: url.toString() }
        : { ok: false, reason: `status ${response.status}` };
    }
  }

  /** wire/decoded 상한과 idle timeout을 독립 적용하고 자원 close 전에는 실행 슬롯을 반환하지 않는다. */
  private once(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<Response | { ok: false; reason: string }> {
    return new Promise(resolve => {
      const chunks: Buffer[] = [];
      let request: ClientRequest | undefined, response: IncomingMessage | undefined, decoded: Readable | undefined;
      let requestClosed = false, responseClosed = true, decodedClosed = true, ended = false, settled = false;
      let failure: string | undefined, wire = 0, bytes = 0, status = 0, location: string | undefined;
      /** 소유 자원이 전부 닫힌 뒤에만 성공/실패를 반환한다. */
      const finish = () => {
        if (settled || !requestClosed || !responseClosed || !decodedClosed || (!ended && !failure)) return;
        settled = true; signal.removeEventListener("abort", abort);
        if (failure) resolve({ ok: false, reason: failure });
        else resolve({ status, location, html: Buffer.concat(chunks).toString("utf8") });
      };
      /** request·response·decoder를 함께 닫고 원문 오류 대신 고정 이유만 보존한다. */
      const stop = (reason: string) => { failure ??= reason; decoded?.destroy(); response?.destroy(); request?.destroy(); finish(); };
      const abort = () => stop("request cancelled");
      try {
        const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
        request = this.request({ protocol: "https:", hostname: url.hostname, port: 443, path: url.pathname + url.search,
          method: "GET", ...(this.agent ? { agent: this.agent } : {}),
          headers: { "accept-encoding": "gzip, deflate, br", ...normalized } }, res => {
          response = res; responseClosed = false; decodedClosed = false; status = res.statusCode ?? 0; location = res.headers.location;
          this.counts.reused += request?.reusedSocket ? 1 : 0;
          res.once("close", () => { responseClosed = true; finish(); });
          const encoding = res.headers["content-encoding"]?.toLowerCase();
          decoded = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
            : encoding === "br" ? createBrotliDecompress() : res;
          decoded.once("close", () => { decodedClosed = true; if (!ended && !failure) failure = "web html response interrupted"; finish(); });
          if (encoding && !["gzip", "deflate", "br", "identity"].includes(encoding)) { stop("unsupported web encoding"); return; }
          res.on("data", (chunk: Buffer) => {
            wire += chunk.length; this.counts.wireBytes += chunk.length;
            if (wire > this.maximum) stop("web html response is too large");
          });
          res.once("error", () => stop("web html connection failed"));
          res.once("aborted", () => stop("web html response interrupted"));
          decoded.on("data", (chunk: Buffer) => {
            bytes += chunk.length; this.counts.decodedBytes += chunk.length;
            if (bytes > this.maximum) stop("web html response is too large"); else chunks.push(chunk);
          });
          decoded.once("error", () => stop("web html decoding failed"));
          decoded.once("end", () => { ended = true; finish(); });
          if (decoded !== res) res.pipe(decoded as import("node:stream").Duplex);
        });
        this.counts.requests++;
        request.once("error", () => { failure ??= "web html connection failed"; decoded?.destroy(); response?.destroy(); });
        request.once("close", () => { requestClosed = true; if (!response && !failure) failure = "web html connection failed"; finish(); });
        request.setTimeout(10_000, () => stop("web html request timed out"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort(); else request.end();
      } catch { requestClosed = true; stop("web html connection failed"); }
    });
  }
}

/** GitHub 웹의 HTTPS·표준 port·인증 없는 URL만 허용하고 hash는 전송/공유 key에서 제거한다. */
export function safeWebUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) throw new Error("unsafe web URL");
  url.hash = ""; return url;
}
