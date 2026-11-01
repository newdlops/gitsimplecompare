import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RepositorySetupService } from "../src/git/repositorySetupService";
import { smartHttpCloneFixture } from "./helpers/smartHttpCloneFixture";

test("smart HTTP blobless clone keeps every ref/parent/current file and hydrates old content through native credentials", async t => {
  const f = await smartHttpCloneFixture(t, { auth: "native" }), service = new RepositorySetupService(f.execute);
  f.reset(); const full = await service.clone(f.url, f.root, "full"), fullBytes = f.stats().bytes;
  f.reset(); const filtered = await service.clone(f.url, f.root, "filtered", { cloneMode: "blobless" } as any), filteredBytes = f.stats().bytes;
  assert.deepEqual(await readFile(join(filtered.root, "asset.txt")), await f.content());
  assert.equal(await f.git(filtered.root, "rev-list", "--all", "--parents"), await f.git(full.root, "rev-list", "--all", "--parents"));
  assert.equal(await f.git(filtered.root, "for-each-ref", "--format=%(refname) %(objectname)"), await f.git(full.root, "for-each-ref", "--format=%(refname) %(objectname)"));
  assert.equal(await f.git(filtered.root, "rev-parse", "--is-shallow-repository"), "false");
  assert.equal(await f.hasObject(filtered.root, f.oldBlob), false); assert.equal(await f.hasObject(full.root, f.oldBlob), true);
  assert(filteredBytes < fullBytes * 0.5, `expected historical blob savings, full=${fullBytes}, filtered=${filteredBytes}`);
  const before = f.stats().requests;
  assert.equal(await f.git(filtered.root, "show", `${f.commits[0]}:asset.txt`), await f.git(f.seed, "show", `${f.commits[0]}:asset.txt`));
  assert(f.stats().requests > before); assert.equal(await f.hasObject(filtered.root, f.oldBlob), true);
  const config = await readFile(join(filtered.root, ".git/config"), "utf8"); assert(!config.includes("extraheader")); assert(!config.includes(f.oauth));
});

test("a server without filter support uses Git's full transfer fallback without clone retry", async t => {
  const f = await smartHttpCloneFixture(t, { filter: false }), service = new RepositorySetupService(f.execute);
  const result = await service.clone(f.url, f.root, "unsupported", { cloneMode: "blobless" } as any);
  assert.equal(await f.hasObject(result.root, f.oldBlob), true);
  assert.equal(await f.git(result.root, "rev-list", "--count", "--all"), String(f.commits.length));
  assert.equal(f.calls.filter(args => args[0] === "clone").length, 1);
});

test("OAuth-only private access fails the real native probe and completes one full clone with transient auth", async t => {
  const f = await smartHttpCloneFixture(t, { auth: "oauth" }), service = new RepositorySetupService(f.execute);
  const result = await service.clone("https://github.com/fixture/repository.git", f.root, "oauth-full", { cloneMode: "blobless", githubToken: f.oauth } as any);
  const probes = f.calls.filter(args => args[0] === "ls-remote"); assert.equal(probes.length, 1);
  const clones = f.calls.filter(args => args[0] === "clone"); assert.equal(clones.length, 1); assert(!clones[0].includes("--filter=blob:none"));
  assert.equal(await f.hasObject(result.root, f.oldBlob), true);
  assert(f.stats().authKinds.includes("anonymous")); assert(f.stats().authKinds.includes("oauth"));
  const config = await readFile(join(result.root, ".git/config"), "utf8"); assert(!config.includes("extraheader")); assert(!config.includes(f.oauth));
});

test("native preflight ignores parent-repository-only credentials that later hydration would not inherit", async t => {
  const f = await smartHttpCloneFixture(t, { auth: "oauth" }), helper = join(f.root, "parent-credential.js");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(helper, 'if(process.argv[2]==="get")process.stdout.write("username=x-access-token\\npassword=fixture-oauth-token\\n");\n');
  const quoted = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  await f.git(f.seed, "config", "credential.helper", "!" + [process.execPath, helper].map(quoted).join(" "));
  const service = new RepositorySetupService(f.execute);
  const result = await service.clone("https://github.com/fixture/repository.git", f.seed, "nested", { cloneMode: "blobless", githubToken: f.oauth } as any);
  const clone = f.calls.find(args => args[0] === "clone")!;
  assert(!clone.includes("--filter=blob:none")); assert.equal(await f.hasObject(result.root, f.oldBlob), true);
});
