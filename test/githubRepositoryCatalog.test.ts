import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRepositoryCatalog, RepositoryCatalogError, type RepositoryCatalogFetch } from "../src/git/githubRepositoryCatalog";

/** GitHub의 실제 fetch 계약에 맞는 응답을 만들어 네트워크·계정 데이터 없이 경계를 검증한다. */
function response(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return { ok: status === 200, status, headers: new Headers(headers), json: async () => payload };
}

test("authenticated catalog includes private and organization repositories without using remote clone_url", async () => {
  const requests: Array<{ url: string; options: RequestInit }> = [];
  const catalog = new GitHubRepositoryCatalog(async (url, options) => {
    requests.push({ url, options });
    return response([
      { full_name: "user/public", private: false, description: "Public" },
      { full_name: "organization/private", private: true, archived: true, clone_url: "https://credential:secret@untrusted.test/repo" },
    ], 200, { link: '<https://untrusted.test/?token=secret>; rel="next"' });
  });
  const first = await catalog.listPage("session-token");
  assert.deepEqual(first.repositories.map(repo => [repo.cloneUrl, repo.isPrivate]), [
    ["https://github.com/user/public.git", false], ["https://github.com/organization/private.git", true],
  ]);
  assert.equal(first.nextPage, 2);
  await catalog.listPage("session-token", first.nextPage);
  for (const { url, options } of requests) {
    const address = new URL(url);
    assert.equal(address.origin, "https://api.github.com");
    assert.equal(address.pathname, "/user/repos");
    assert.equal(address.searchParams.get("affiliation"), "owner,collaborator,organization_member");
    assert.equal(address.searchParams.get("per_page"), "100");
    assert.equal(url.includes("session-token"), false);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer session-token");
  }
  assert.equal(new URL(requests[1].url).searchParams.get("page"), "2");
  assert.equal(JSON.stringify(first).includes("secret"), false);
});

for (const [status, headers, kind] of [
  [401, {}, "authentication"], [403, {}, "authentication"],
  [403, { "x-ratelimit-remaining": "0" }, "rate-limit"], [429, {}, "rate-limit"], [503, {}, "http"],
] as const) {
  test(`HTTP ${status} reports ${kind} without exposing the response or credentials`, async () => {
    const catalog = new GitHubRepositoryCatalog(async () => response({ message: "secret-token" }, status, headers));
    await assert.rejects(catalog.listPage("secret-token"), error => {
      assert.ok(error instanceof RepositoryCatalogError);
      assert.equal(error.kind, kind);
      assert.equal(error.status, status);
      assert.equal(error.message.includes("secret-token"), false);
      return true;
    });
  });
}

test("network failures and redirects are sanitized instead of leaking the token-bearing error", async () => {
  const catalog = new GitHubRepositoryCatalog(async () => { throw new Error("Network failure: secret-token"); });
  await assert.rejects(catalog.listPage("secret-token"), error => {
    assert.ok(error instanceof RepositoryCatalogError && error.kind === "network");
    assert.equal(error.message.includes("secret-token"), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("invalid inputs and malformed repositories never become an apparently empty successful catalog", async () => {
  let calls = 0;
  const catalog = new GitHubRepositoryCatalog(async () => { calls++; return response([]); });
  for (const [token, page] of [["", 1], ["token\r\n", 1], ["token", 0], ["token", 1.5]] as const) {
    await assert.rejects(catalog.listPage(token, page), RepositoryCatalogError);
  }
  assert.equal(calls, 0);
  for (const payload of [{}, [{ full_name: "../private" }], [{ full_name: "user/repo" }, { full_name: "bad/path/repo" }]]) {
    await assert.rejects(new GitHubRepositoryCatalog(async () => response(payload)).listPage("token"),
      error => error instanceof RepositoryCatalogError && error.kind === "invalid-data");
  }
  assert.deepEqual((await catalog.listPage("token")).repositories, []);
});

test("cancellation before fetch, during fetch and during JSON reading never returns repositories", async () => {
  for (const stage of ["before", "fetch", "json"] as const) {
    const controller = new AbortController();
    if (stage === "before") controller.abort();
    const request: RepositoryCatalogFetch = async (_url, options) => {
      assert.equal(options.signal, controller.signal);
      if (stage === "fetch") { controller.abort(); throw new Error("cancelled token"); }
      return { ...response([]), json: async () => { controller.abort(); return [{ full_name: "user/repo" }]; } };
    };
    await assert.rejects(new GitHubRepositoryCatalog(request).listPage("token", 1, controller.signal),
      error => error instanceof RepositoryCatalogError && error.kind === "cancelled");
  }
});
