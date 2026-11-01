import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { runGit, withGitConfigOverrides, type RunGitOptions } from "../../src/git/gitExec";
import type { SetupGitRunner } from "../../src/git/repositorySetupService";

const OAUTH = "fixture-oauth-token";
const basic = (user: string, password: string) => "Basic " + Buffer.from(user + ":" + password).toString("base64");

/** HTTP body 전송량을 실제 Git http-backend로 측정하며 사용자 계정·네트워크는 사용하지 않는다. */
export async function smartHttpCloneFixture(t: TestContext, options: { filter?: boolean; auth?: "native" | "oauth"; commits?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gsc-smart-clone-")), seed = join(root, "seed"), serverRoot = join(root, "repository.git"), globalConfig = join(root, "gitconfig");
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(?:GIT_|GCM_|GH_|GITHUB_)/.test(key))) as Record<string, string>;
  const env = { ...cleanEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "Never" };
  await mkdir(seed); await writeFile(globalConfig, "");
  const git = async (cwd: string, ...args: string[]) => (await runGit(args, cwd, { env, inheritEnv: false, githubProactiveAuth: false })).trim();
  await git(seed, "-c", "init.templateDir=", "init", "-q", "-b", "main");
  for (const [key, value] of Object.entries({ "user.name": "Clone Fixture", "user.email": "clone@example.invalid", "commit.gpgSign": "false", "core.hooksPath": "/dev/null", "gc.auto": "0" })) await git(seed, "config", key, value);
  const commits: string[] = [];
  for (let index = 0; index < (options.commits ?? 8); index++) {
    await writeFile(join(seed, "asset.txt"), randomBytes(128 * 1024).toString("base64") + "\n");
    await git(seed, "add", "asset.txt"); await git(seed, "commit", "-qm", `asset ${index}`); commits.push(await git(seed, "rev-parse", "HEAD"));
  }
  await git(seed, "branch", "topic", commits[2]); await git(seed, "branch", "other", commits[4]); await git(seed, "tag", "v1", commits[1]);
  await git(root, "clone", "-q", "--bare", seed, serverRoot);
  await git(serverRoot, "config", "uploadpack.allowFilter", options.filter === false ? "false" : "true");
  await git(serverRoot, "config", "uploadpack.allowAnySHA1InWant", "true");
  if (options.auth === "native") {
    const helper = join(root, "credential.js");
    await writeFile(helper, 'if(process.argv[2]==="get")process.stdout.write("username=fixture-native\\npassword=fixture-native-password\\n");\n');
    const quoted = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    await git(seed, "config", "--file", globalConfig, "credential.helper", "!" + quoted(process.execPath) + " " + quoted(helper));
  }
  let requests = 0, bytes = 0;
  const authKinds: string[] = [], backends = new Set<ReturnType<typeof spawn>>();
  const server = http.createServer((req, res) => {
    requests++;
    const authorization = req.headers.authorization;
    const kind = authorization === basic("fixture-native", "fixture-native-password") ? "native"
      : authorization === basic("x-access-token", OAUTH) ? "oauth" : authorization ? "other" : "anonymous";
    authKinds.push(kind);
    if (options.auth && kind !== options.auth) { res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' }); res.end(); return; }
    const url = new URL(req.url!, "http://localhost");
    const child = spawn("git", ["http-backend"], { env: { ...cleanEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? "GET", CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: req.headers["content-length"] ?? "",
      HTTP_GIT_PROTOCOL: req.headers["git-protocol"] ?? "", GIT_PROTOCOL: req.headers["git-protocol"] ?? "", REMOTE_USER: "fixture" }, stdio: ["pipe", "pipe", "pipe"] });
    backends.add(child); let prefix = Buffer.alloc(0), sent = false;
    child.stderr.on("data", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      if (sent) { bytes += chunk.length; res.write(chunk); return; }
      prefix = Buffer.concat([prefix, chunk]);
      const boundary = /\r?\n\r?\n/.exec(prefix.toString("latin1")); if (!boundary) return;
      const headers: Record<string, string> = {}; let status = 200;
      for (const line of prefix.subarray(0, boundary.index).toString("latin1").split(/\r?\n/)) {
        const at = line.indexOf(":"); if (at < 0) continue;
        const key = line.slice(0, at).toLowerCase(), value = line.slice(at + 1).trim();
        if (key === "status") status = Number(value.split(" ")[0]); else headers[key] = value;
      }
      res.writeHead(status, headers); sent = true;
      const body = prefix.subarray(boundary.index + boundary[0].length); bytes += body.length; res.write(body); prefix = Buffer.alloc(0);
    });
    child.once("error", () => res.destroy());
    child.once("close", code => { backends.delete(child); if (code && !res.writableEnded) res.destroy(); else res.end(); });
    req.once("aborted", () => child.kill()); res.once("close", () => { if (!res.writableEnded) child.kill(); });
    req.pipe(child.stdin);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/repository.git`;
  const calls: string[][] = [];
  const execute: SetupGitRunner = async (args, cwd, execution: RunGitOptions = {}) => {
    calls.push([...args]);
    let scoped: Record<string, string> = { ...env };
    if (execution.env?.GIT_CEILING_DIRECTORIES !== undefined) scoped.GIT_CEILING_DIRECTORIES = execution.env.GIT_CEILING_DIRECTORIES;
    // production이 만든 일시적 GitHub header만 localhost fixture origin에 대응시킨다.
    const count = Number(execution.env?.GIT_CONFIG_COUNT ?? 0);
    for (let index = 0; index < count; index++) {
      const key = execution.env?.[`GIT_CONFIG_KEY_${index}`], value = execution.env?.[`GIT_CONFIG_VALUE_${index}`];
      if (key === "http.https://github.com/.extraheader" && value?.includes(Buffer.from("x-access-token:" + OAUTH).toString("base64"))) {
        scoped = withGitConfigOverrides(scoped, { [`http.${new URL(url).origin}/.extraheader`]: value }) as typeof scoped;
      }
    }
    const mapped = args.map(value => value === "https://github.com/fixture/repository.git" ? url : value);
    return runGit(mapped, cwd, { ...execution, env: scoped, inheritEnv: false, githubProactiveAuth: false });
  };
  const hasObject = (cwd: string, oid: string) => runGit(["cat-file", "-e", oid], cwd, { env: { ...env, GIT_NO_LAZY_FETCH: "1" }, inheritEnv: false, githubProactiveAuth: false }).then(() => true, () => false);
  t.after(async () => {
    for (const child of backends) child.kill();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, seed, serverRoot, commits, url, execute, git, hasObject, calls, oauth: OAUTH,
    content: () => readFile(join(seed, "asset.txt")), stats: () => ({ requests, bytes, authKinds: [...authKinds] }),
    reset: () => { requests = 0; bytes = 0; authKinds.length = 0; },
    oldBlob: await git(seed, "rev-parse", `${commits[0]}:asset.txt`) };
}
