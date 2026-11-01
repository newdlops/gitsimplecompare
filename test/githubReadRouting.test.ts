import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReadRuntime } from "../src/git/githubReadRuntime";
import { GitHubCredentialProvider } from "../src/git/githubCredential";
import { graphqlRead } from "../src/git/githubReadRequest";
import type { GitHubReadSessionState } from "../src/git/githubReadSession";

/** 외부 네트워크 없이 전송 선택·인증 수명만 관찰할 완전한 canonical 문맥을 만든다. */
function state(scope = true): GitHubReadSessionState {
  return { root: "/repo", env: { GH_TOKEN: "fixture-token" }, context: "fixture",
    scope: scope ? { host: "github.com", name: "owner/repo", owner: "owner", repository: "repo" } : undefined };
}

test("unknown scope fixes the whole logical query on CLI; next verified query uses HTTP", async () => {
  let cli = 0, http = 0;
  const runtime = new GitHubReadRuntime({
    policy: async () => ({ transport: "auto", systemProxy: "none" }),
    cli: async () => { cli++; return "{}"; },
    http: { read: async () => { http++; return "{}"; }, dispose: async () => {} },
  });
  const read = graphqlRead("query($owner:String!){repository(owner:$owner,name:\"repo\"){url}}", { owner: "{owner}" });
  const first = state(false);
  await runtime.execute(read.args, "/repo", { operation: "fixture", request: read.request, readSession: first });
  first.scope = state().scope;
  await runtime.execute(read.args, "/repo", { operation: "fixture", request: read.request, readSession: first });
  await runtime.execute(read.args, "/repo", { operation: "fixture", request: read.request, readSession: state() });
  assert.deepEqual({ cli, http }, { cli: 2, http: 1 });
  await runtime.dispose();
});

test("HTTP pages share one credential lease and canonical placeholder values", async () => {
  let calls = 0;
  const credentials = new GitHubCredentialProvider(async () => { calls++; return "saved-token"; });
  const seen: unknown[] = [];
  const runtime = new GitHubReadRuntime({ credentials, policy: async () => ({ transport: "auto", systemProxy: "none" }),
    http: { read: async (request, lease) => { seen.push([request.kind === "graphql" ? request.variables : undefined, lease.key]); return "{}"; }, dispose: async () => {} } });
  const session = state(); session.env = {};
  const read = graphqlRead("query($owner:String!,$name:String!){repository(owner:$owner,name:$name){url}}", { owner: "{owner}", name: "{repo}" });
  for (let i = 0; i < 2; i++) await runtime.execute(read.args, "/repo", { operation: "fixture", request: read.request, readSession: session });
  assert.equal(calls, 1); assert.deepEqual(seen[0], [{ owner: "owner", name: "repo" }, session.credentialKey]);
  assert.deepEqual(seen[0], seen[1]); await runtime.dispose();
});

test("forced CLI and unsupported network policy never attempt HTTP; HTTP auth failures never fallback", async () => {
  let cli = 0, http = 0;
  const read = graphqlRead("query{viewer{login}}");
  for (const transport of ["cli", "auto"] as const) {
    const runtime = new GitHubReadRuntime({ policy: async () => ({ transport, systemProxy: "present" }),
      cli: async () => { cli++; return "{}"; }, http: { read: async () => { http++; return "{}"; }, dispose: async () => {} } });
    await runtime.execute(read.args, "/repo", { operation: "fixture", request: read.request, readSession: state() }); await runtime.dispose();
  }
  assert.deepEqual({ cli, http }, { cli: 2, http: 0 });
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    cli: async () => { cli++; return "{}"; }, http: { read: async () => { throw new Error("auth failure"); }, dispose: async () => {} } });
  await assert.rejects(runtime.execute(read.args, "/repo", { operation: "fixture", request: read.request, readSession: state() }));
  assert.equal(cli, 2); await runtime.dispose();
});

test("a new runtime rejects pages from an old setting generation", async () => {
  const read = graphqlRead("query{viewer{login}}"), session = state();
  const deps = { policy: async () => ({ transport: "cli" as const, systemProxy: "none" as const }), cli: async () => "{}" };
  const first = new GitHubReadRuntime(deps), second = new GitHubReadRuntime(deps);
  await first.execute(read.args, "/repo", { operation: "fixture", request: read.request, readSession: session });
  await assert.rejects(second.execute(read.args, "/repo", { operation: "fixture", request: read.request, readSession: session }), { name: "GitHubReadContextChangedError" });
  await first.dispose(); await second.dispose();
});
