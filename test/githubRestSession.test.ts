import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubReadSession } from "../src/git/githubReadSession";
import { readSessionRestApiBase } from "../src/git/githubRestSession";

for (const [host, expected] of [["github.com", "https://api.github.com"], ["tenant.ghe.com", "https://api.tenant.ghe.com"], ["ghe.example", "https://ghe.example/api/v3"]]) {
  test(`REST Link base freezes ${host} without another request`, t => {
    const previous = process.env.GH_HOST; process.env.GH_HOST = host;
    t.after(() => { if (previous === undefined) delete process.env.GH_HOST; else process.env.GH_HOST = previous; });
    const session = createGitHubReadSession("/unused-rest-host-fixture", async () => { assert.fail("base lookup must not issue a request"); });
    process.env.GH_HOST = "replacement.example";
    assert.equal(readSessionRestApiBase(session), expected);
  });
}
