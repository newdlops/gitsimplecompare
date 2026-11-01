// 직접 HTTPS가 기존 gh의 네트워크 정책을 보존할 수 있는 경우만 허용한다.
export interface GitHubNetworkPolicy {
  transport: "auto" | "cli";
  systemProxy: "none" | "present" | "unknown";
  proxy?: string;
  proxyStrictSSL?: boolean;
  proxyAuthorization?: boolean;
  customCertificates?: boolean;
  generation?: number;
}

/** host·환경·VS Code 정책을 입력받아 인증 lookup/네트워크 이전에 지원 여부와 안전한 사유를 반환한다. */
export function gitHubHttpCapability(host: string, env: NodeJS.ProcessEnv, policy: GitHubNetworkPolicy): { supported: boolean; reason: string } {
  if (policy.transport === "cli") return { supported: false, reason: "cli-setting" };
  if (host !== "github.com" || (env.GH_HOST && env.GH_HOST.toLowerCase() !== host)) return { supported: false, reason: "unsupported-host" };
  const unsupported = /^(?:https?_proxy|all_proxy|no_proxy|gh_http_unix_socket|node_extra_ca_certs|node_tls_reject_unauthorized|ssl_cert_file|ssl_cert_dir|curl_ca_bundle|requests_ca_bundle|git_ssl_cainfo|git_ssl_capath|git_ssl_no_verify)$/i;
  if (Object.entries(env).some(([key, value]) => unsupported.test(key) && value !== undefined && value !== "")) {
    return { supported: false, reason: "environment-network-policy" };
  }
  if (policy.systemProxy !== "none" || policy.proxy || policy.proxyStrictSSL === false
    || policy.proxyAuthorization || policy.customCertificates) return { supported: false, reason: "host-network-policy" };
  return { supported: true, reason: "supported" };
}
