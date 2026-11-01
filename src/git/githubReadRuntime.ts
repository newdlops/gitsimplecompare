// typed 조회만 직접 HTTP로 보내며 논리 조회의 전송·인증·설정 세대를 고정한다.
import { runGh } from "./ghCli";
import type { GhExecute, GhRunnerOptions } from "./ghRunner";
import { GitHubCredentialProvider } from "./githubCredential";
import { GitHubHttpTransport } from "./githubHttpTransport";
import { gitHubHttpCapability, type GitHubNetworkPolicy } from "./githubHttpPolicy";
import { GitHubReadContextChangedError } from "./githubReadSession";
import { logInfo } from "../ui/outputLog";
import { GitHubPullRequestSnapshots } from "./githubPullRequestSnapshots";
import { GitHubApiError } from "./githubApiError";
import { normalizeRestPageCli, restPageCliArgs } from "./githubRestPages";

type PolicyResolver = (root: string) => Promise<GitHubNetworkPolicy>;
let policyResolver: PolicyResolver = async () => ({ transport: "auto", systemProxy: "unknown" });
let generation = 0;
interface Dependencies {
  policy?: PolicyResolver; credentials?: GitHubCredentialProvider; cli?: GhExecute;
  http?: Pick<GitHubHttpTransport, "read" | "dispose">;
}

/** UI가 읽은 정책을 값으로 주입한다. 이전 disposer는 새 활성화의 resolver를 덮어쓰지 않는다. */
export function setGitHubReadPolicyResolver(resolve: PolicyResolver): () => void {
  const previous = policyResolver; policyResolver = resolve;
  return () => { if (policyResolver === resolve) policyResolver = previous; };
}

/** 하나의 활성화/설정 세대가 credentials·HTTP 자원의 소유권을 가진다. */
export class GitHubReadRuntime {
  private readonly generation = ++generation;
  private readonly policy: PolicyResolver;
  private readonly credentials: GitHubCredentialProvider;
  private readonly http: Pick<GitHubHttpTransport, "read" | "dispose">;
  private readonly cli: GhExecute;
  private disposed = false;
  private readonly snapshots = new GitHubPullRequestSnapshots();
  constructor(dependencies: Dependencies = {}) {
    this.policy = dependencies.policy ?? policyResolver;
    this.credentials = dependencies.credentials ?? new GitHubCredentialProvider();
    this.http = dependencies.http ?? new GitHubHttpTransport(); this.cli = dependencies.cli ?? runGh;
  }

  /**
   * cache key 계산 전에 실제 인증을 해석한다. 첫 요청의 deadline에는 이 준비 시간이 포함된다.
   * @param root 실행 루트, options 고정 세션·typed 요청·개별 요청 마감
   * @returns CLI bootstrap은 자격 증명을 추측하지 않으며 같은 조회의 후속 페이지도 CLI를 유지한다.
   */
  async prepare(root: string, options: GhRunnerOptions): Promise<void> {
    const state = options.readSession;
    if (!state) return;
    if (this.disposed || state.generation !== undefined && state.generation !== this.generation) throw new GitHubReadContextChangedError();
    state.generation = this.generation;
    state.snapshots = this.snapshots;
    state.preparation ??= (async () => {
      const policy = await this.policy(root);
      const capability = state.scope ? gitHubHttpCapability(state.scope.host, state.env, policy)
        : { supported: false, reason: "scope-bootstrap" };
      state.transport = options.request && capability.supported ? "http" : "cli";
      logInfo("GitHub read transport selected", { operation: options.operation, transport: state.transport,
        reason: options.request ? capability.reason : "unconverted-command" });
      if (options.request && state.scope?.host === "github.com" && (!state.env.GH_HOST || state.env.GH_HOST.toLowerCase() === "github.com")) {
        state.credential = this.credentials.acquire(root, state.env, options.signal,
          (options.deadline ?? Date.now() + 30_000) - Date.now());
        state.credentialKey = (await state.credential).key;
      }
    })();
    await state.preparation;
    options.signal?.throwIfAborted();
    if (this.disposed) throw new GitHubReadContextChangedError();
  }

  /** 호환 CLI 인자는 해석하지 않으며 HTTP 실패 후 다른 계정/CLI로 자동 재실행하지 않는다. */
  readonly execute: GhExecute = async (args, root, options) => {
    await this.prepare(root, options);
    const state = options.readSession;
    if (state?.transport === "http") {
      if (!options.request || !state.scope || !state.credential) throw new GitHubReadContextChangedError();
      const request = options.request.kind === "graphql" ? { ...options.request,
        variables: Object.fromEntries(Object.entries(options.request.variables).map(([key, value]) =>
          [key, value === "{owner}" ? state.scope!.owner : value === "{repo}" ? state.scope!.repository : value])) }
        : { ...options.request, path: options.request.path.replaceAll("{owner}", encodeURIComponent(state.scope.owner))
          .replaceAll("{repo}", encodeURIComponent(state.scope.repository)) };
      try {
        return await this.http.read(request, await state.credential, { ...options, deadline: options.deadline ?? Date.now() + 30_000,
          policyGeneration: this.generation });
      } catch (error) {
        if (error instanceof GitHubApiError && error.kind === "auth" && state.credentialKey) this.snapshots.invalidateCredential(state.credentialKey);
        throw error;
      }
    }
    const started = Date.now();
    const cliOptions = state?.credential ? { ...options, env: (await state.credential).cliEnvironment(options.env ?? state.env) } : options;
    try {
      const page = options.request?.kind === "rest" && options.request.responseMode === "page";
      const output = await this.cli(page ? restPageCliArgs(args) : args, root, cliOptions);
      return page ? normalizeRestPageCli(output) : output;
    }
    finally { logInfo("GitHub CLI read closed", { operation: options.operation, transport: "cli", cliCount: 1, httpCount: 0, totalMs: Date.now() - started }); }
  };

  /** 실제 lookup/request 종료를 기다리고 새 runtime의 자원은 건드리지 않는다. */
  async dispose(): Promise<void> {
    this.disposed = true; this.snapshots.clear(); await Promise.all([this.credentials.dispose(), this.http.dispose()]);
  }
}
