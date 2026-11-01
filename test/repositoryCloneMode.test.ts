import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositorySetupService, RepositorySetupError, type SetupGitRunner } from "../src/git/repositorySetupService";

/** 실제 destination 소유권/실패 cleanup은 유지하고 Git 프로세스 경계만 대체한다. */
async function fixture(t: test.TestContext, options: { version?: string; denied?: boolean; timeout?: boolean; cancel?: AbortController; failClone?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gsc-clone-policy-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const calls: Array<{ args: string[]; options: any }> = [];
  const runner: SetupGitRunner = async (args, _cwd, execution) => {
    calls.push({ args: [...args], options: execution });
    if (args[0] === "version" || args[0] === "--version") return options.version ?? "git version 2.50.1 (Apple Git-155)";
    if (args[0] === "ls-remote") {
      options.cancel?.abort();
      if (options.timeout) await new Promise<void>(resolve => execution!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      execution?.signal?.throwIfAborted();
      if (options.denied) throw new Error("fixture native access denied");
      return "a".repeat(40) + "\trefs/heads/main\n";
    }
    if (args[0] === "clone" && options.failClone) {
      await writeFile(join(args.at(-1)!, "keep-partial.txt"), "partial"); throw new Error("fixture-oauth-token failed");
    }
    return args[0] === "symbolic-ref" ? "main\n" : "";
  };
  return { root, calls, service: new RepositorySetupService(runner) };
}

for (const mode of [undefined, "full"] as const) {
  test(`clone ${mode ?? "default"} retains the exact full-clone Git command count and args`, async t => {
    const f = await fixture(t);
    await f.service.clone("https://example.invalid/o/r.git", f.root, "clone", { cloneMode: mode } as any);
    assert.deepEqual(f.calls.map(call => call.args[0]), ["clone", "symbolic-ref"]);
    assert.deepEqual(f.calls[0].args, ["clone", "--progress", "--", "https://example.invalid/o/r.git", join(f.root, "clone")]);
  });
}

test("blobless requires a modern Git and a native access probe without app OAuth or interactive askpass", async t => {
  const f = await fixture(t), token = "fixture-oauth-token";
  await f.service.clone("https://github.com/o/r.git", f.root, "clone", { cloneMode: "blobless", githubToken: token } as any);
  assert.deepEqual(f.calls.map(call => call.args[0]), ["version", "ls-remote", "clone", "symbolic-ref"]);
  const probe = f.calls[1], clone = f.calls[2];
  assert.equal(probe.options.githubProactiveAuth, false); assert.equal(probe.options.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(probe.options.env.GIT_ASKPASS, ""); assert.equal(probe.options.env.SSH_ASKPASS, ""); assert.equal(probe.options.env.GCM_INTERACTIVE, "Never");
  assert(!JSON.stringify(probe).includes(token)); assert(!JSON.stringify(probe).includes(Buffer.from("x-access-token:" + token).toString("base64")));
  assert(clone.args.includes("--filter=blob:none")); assert(!clone.args.some(value => /--(?:depth|single-branch|no-tags|sparse)/.test(value)));
});

for (const version of ["git version 2.45.9", "unknown version"]) {
  test(`${version} falls back to full before a remote access probe`, async t => {
    const f = await fixture(t, { version }); await f.service.clone("https://example.invalid/o/r.git", f.root, "clone", { cloneMode: "blobless" } as any);
    assert.deepEqual(f.calls.map(call => call.args[0]), ["version", "clone", "symbolic-ref"]);
    assert(!f.calls.find(call => call.args[0] === "clone")!.args.includes("--filter=blob:none"));
  });
}

for (const source of ["/tmp/source", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "file:///tmp/source"]) {
  test(`blobless keeps full cloning for ${source.split(":")[0]}`, async t => {
    const f = await fixture(t); await f.service.clone(source, f.root, "clone", { cloneMode: "blobless" } as any);
    assert.deepEqual(f.calls.map(call => call.args[0]), ["clone", "symbolic-ref"]); assert(!f.calls[0].args.includes("--filter=blob:none"));
  });
}

test("OAuth-only native access failure selects full once and preserves the clone-scoped token", async t => {
  const f = await fixture(t, { denied: true });
  await f.service.clone("https://github.com/o/r.git", f.root, "clone", { cloneMode: "blobless", githubToken: "fixture-oauth-token" } as any);
  assert.equal(f.calls.filter(call => call.args[0] === "ls-remote").length, 1);
  const clones = f.calls.filter(call => call.args[0] === "clone"); assert.equal(clones.length, 1); assert(!clones[0].args.includes("--filter=blob:none"));
  assert(JSON.stringify(clones[0].options.env).includes(Buffer.from("x-access-token:fixture-oauth-token").toString("base64")));
});

test("clone mode is frozen before asynchronous destination validation", async t => {
  const f = await fixture(t), options: any = { cloneMode: "blobless" };
  const cloning = f.service.clone("https://example.invalid/o/r.git", f.root, "clone", options); options.cloneMode = "full";
  await cloning; assert(f.calls.find(call => call.args[0] === "clone")!.args.includes("--filter=blob:none"));
});

test("probe cancellation never starts clone or preserves an empty owned destination", async t => {
  const cancel = new AbortController(), f = await fixture(t, { cancel });
  await assert.rejects(f.service.clone("https://example.invalid/o/r.git", f.root, "clone", { cloneMode: "blobless", signal: cancel.signal } as any),
    error => error instanceof RepositorySetupError && error.code === "cancelled");
  assert(!f.calls.some(call => call.args[0] === "clone")); await assert.rejects(access(join(f.root, "clone")));
});

test("a five-second native access deadline chooses full and makes no filtered-clone retry", { timeout: 9000 }, async t => {
  const f = await fixture(t, { timeout: true }), start = Date.now();
  await f.service.clone("https://example.invalid/o/r.git", f.root, "clone", { cloneMode: "blobless" } as any);
  assert(Date.now() - start >= 4900 && Date.now() - start < 8000);
  const clones = f.calls.filter(call => call.args[0] === "clone"); assert.equal(clones.length, 1); assert(!clones[0].args.includes("--filter=blob:none"));
});

test("a failed filtered clone preserves partial data, performs no retry and redacts its transient OAuth", async t => {
  const f = await fixture(t, { failClone: true });
  await assert.rejects(f.service.clone("https://github.com/o/r.git", f.root, "clone", { cloneMode: "blobless", githubToken: "fixture-oauth-token" } as any),
    error => error instanceof RepositorySetupError && !error.message.includes("fixture-oauth-token"));
  assert.equal(f.calls.filter(call => call.args[0] === "clone").length, 1); await access(join(f.root, "clone", "keep-partial.txt"));
});

test("clone Settings default to full and explain preserved history, later downloads and fallback in English and Korean", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const setting = manifest.contributes.configuration.properties["gitSimpleCompare.cloneMode"];
  assert.equal(setting.default, "full"); assert.deepEqual(setting.enum, ["full", "blobless"]); assert.equal(setting.scope, "machine-overridable");
  for (const language of ["package.nls.json", "package.nls.ko.json"]) {
    const strings = JSON.parse(await readFile(join(process.cwd(), language), "utf8"));
    for (const key of [setting.description, ...setting.enumDescriptions]) assert(strings[key.slice(1, -1)]?.length > 20);
  }
});
