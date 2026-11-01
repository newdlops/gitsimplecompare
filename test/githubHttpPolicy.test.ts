import assert from "node:assert/strict";
import test from "node:test";
import { gitHubHttpCapability } from "../src/git/githubHttpPolicy";

test("direct HTTP requires proven github.com network policy before credentials or network", () => {
  const policy = { transport: "auto" as const, systemProxy: "none" as const };
  assert.equal(gitHubHttpCapability("github.com", {}, policy).supported, true);
  for (const env of [{ HTTP_PROXY: "http://proxy" }, { https_proxy: "http://proxy" }, { ALL_PROXY: "socks://proxy" },
    { NO_PROXY: "github.com" }, { NODE_EXTRA_CA_CERTS: "/custom" }, { SSL_CERT_FILE: "/custom" },
    { GH_HTTP_UNIX_SOCKET: "/socket" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }]) {
    assert.equal(gitHubHttpCapability("github.com", env, policy).supported, false);
  }
  for (const host of ["enterprise.example", "company.ghe.com", "api.github.com.evil.example"]) {
    assert.equal(gitHubHttpCapability(host, {}, policy).supported, false);
  }
  assert.equal(gitHubHttpCapability("github.com", {}, { ...policy, transport: "cli" }).supported, false);
  assert.equal(gitHubHttpCapability("github.com", {}, { ...policy, systemProxy: "unknown" }).supported, false);
  assert.equal(gitHubHttpCapability("github.com", {}, { ...policy, proxy: "http://proxy" }).supported, false);
  assert.equal(gitHubHttpCapability("github.com", {}, { ...policy, proxyStrictSSL: false }).supported, false);
});
