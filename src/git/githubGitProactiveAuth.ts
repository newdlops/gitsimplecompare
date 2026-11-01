// native Git의 기존 credential helper를 사용하며 증명된 GitHub HTTPS에만 명령 단위 사전 인증을 허용한다.
import type { RunGitOptions } from "./gitExec";
import { logInfo } from "../ui/outputLog";
type Resolver = (root: string) => boolean;
type Probe = (args: string[]) => Promise<string>;
let resolver: Resolver = () => false;
const COMMANDS = new Set(["push", "pull", "fetch", "ls-remote"]);
const FLAGS = new Set(["--", "--all", "--prune", "--tags", "--heads", "--refs", "--exit-code", "--dry-run", "--no-rebase",
  "--no-edit", "--ff-only", "--porcelain", "--progress", "--no-progress", "--quiet", "-q", "--verbose", "-v", "--force", "-f",
  "--force-with-lease", "--atomic", "--thin", "--no-thin", "--set-upstream", "-u"]);

/** UI 설정을 주입하며 이전 활성화의 disposer는 새 resolver를 제거하지 않는다. */
export function setGitHubProactiveAuthResolver(next: Resolver): () => void {
  const previous = resolver; resolver = next;
  return () => { if (resolver === next) resolver = previous; };
}

/** 논리 작업 시작 시 boolean만 고정한다. 이후 설정 전환이 승인된 전송의 정책을 바꾸지 않는다. */
export function captureGitHubProactiveAuth(root: string): boolean { return resolver(root) === true; }

/** 전역 옵션·임의 shell·로컬 조회에는 사전 인증 probe를 추가하지 않는다. */
export function isGitHubProactiveAuthCommand(args: readonly string[]): boolean { return COMMANDS.has(args[0]); }

/**
 * Git이 해석한 단일 HTTPS 대상·지원 버전·기존 인증 정책을 확인한다. 원격 통신이나 설정 쓰기는 하지 않는다.
 * @param args native 명령, root 관찰 로그용 실행 루트, options 작업 시작에 고정한 opt-in, read 같은 실행 환경의 로컬 probe
 * @returns 검증 가능한 호환 대상만 true. SSH·여러 URL·rewrite·명시 정책·관찰 실패는 기존 Git 실행을 유지한다.
 */
export async function canUseGitHubProactiveAuth(args: readonly string[], root: string, options: RunGitOptions, read: Probe): Promise<boolean> {
  if (!options.githubProactiveAuth || !isGitHubProactiveAuthCommand(args)) return false;
  let reason = "unsupported-target";
  try {
    const operands: string[] = [];
    let literal = false;
    for (const arg of args.slice(1)) {
      if (!literal && arg === "--") { literal = true; continue; }
      if (!literal && arg.startsWith("-")) {
        if (!FLAGS.has(arg) && !/^--force-with-lease=[^\r\n]+$/.test(arg)) return false;
      } else operands.push(arg);
    }
    const [version, raw] = await Promise.all([read(["--version"]), read(["config", "--null", "--list"])]);
    const match = /^git version (\d+)\.(\d+)(?:\.|\s|$)/.exec(version);
    if (!match || Number(match[1]) < 2 || Number(match[1]) === 2 && Number(match[2]) < 46) { reason = "unsupported-version"; return false; }
    const config = parseConfig(raw);
    const helperKeys = [...config.keys()].filter(key => /^credential\.(?:.*\.)?helper$/i.test(key));
    if (!helperKeys.length || helperKeys.some(key => !config.get(key)?.at(-1))) { reason = "credential-helper-policy"; return false; }
    if ([...config.keys()].some(key => /^http\.(?:.*\.)?(?:proactiveauth|emptyauth|extraheader)$/i.test(key)
      || /^credential\.(?:.*\.)?(?!helper$)[^.]+$/i.test(key) || /^url\..*\.(?:insteadof|pushinsteadof)$/i.test(key))) {
      reason = "explicit-auth-policy"; return false;
    }
    let target = operands[0];
    if (args[0] === "fetch" && args.includes("--all")) {
      const remotes = [...config.keys()].flatMap(key => /^remote\.(.+)\.url$/.exec(key)?.slice(1) ?? []);
      if (target || new Set(remotes).size !== 1) return false;
      target = remotes[0];
    }
    if (!target) {
      const branch = (await read(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      target = (args[0] === "push" ? config.get(`branch.${branch}.pushremote`)?.at(-1) ?? config.get("remote.pushdefault")?.at(-1) : undefined)
        ?? config.get(`branch.${branch}.remote`)?.at(-1) ?? (config.has("remote.origin.url") ? "origin" : undefined)!;
    }
    if (!target || target === ".") return false;
    const urls = /^https:\/\//i.test(target) ? [target]
      : (await read(["remote", "get-url", ...(args[0] === "push" ? ["--push"] : []), "--all", "--", target])).trim().split(/\r?\n/);
    if (urls.length !== 1 || !isGitHubHttps(urls[0])) return false;
    reason = "supported"; return true;
  } catch {
    options.signal?.throwIfAborted(); reason = "policy-unavailable"; return false;
  } finally { logInfo("GitHub native proactive authentication checked", { repoRoot: root, operation: args[0], enabled: reason === "supported", reason }); }
}

/** NUL 구분 config를 함수 내부에만 보관하며 값·URL·helper 원문은 로그에 전달하지 않는다. */
function parseConfig(raw: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const item of raw.split("\0")) {
    if (!item) continue;
    const at = item.indexOf("\n"), sourceKey = at < 0 ? item : item.slice(0, at);
    const first = sourceKey.indexOf("."), last = sourceKey.lastIndexOf(".");
    const key = first < 0 ? sourceKey.toLowerCase() : sourceKey.slice(0, first).toLowerCase() + sourceKey.slice(first, last) + sourceKey.slice(last).toLowerCase();
    const list = values.get(key) ?? []; list.push(at < 0 ? "" : item.slice(at + 1)); values.set(key, list);
  }
  return values;
}

/** 자격 증명이 URL에 없고 정확한 GitHub.com HTTPS 저장소 경로임을 확인한다. */
function isGitHubHttps(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password
      && !url.search && !url.hash && /^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname);
  } catch { return false; }
}
