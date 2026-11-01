// OS proxy를 Node HTTPS가 자동 상속한다고 가정하지 않고 관찰 가능한 환경만 직접 연결에 허용한다.
import { execFile } from "node:child_process";

/** macOS의 system proxy/PAC 활성 상태를 읽는다. 다른 플랫폼/관찰 실패는 unknown으로 CLI를 유지한다. */
export async function detectGitHubSystemProxy(): Promise<"none" | "present" | "unknown"> {
  if (process.platform !== "darwin") return "unknown";
  return new Promise(resolve => {
    execFile("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 3000 }, (error, output) => {
      if (error || !/^<dictionary>\s*\{/m.test(output)) { resolve("unknown"); return; }
      resolve(/^\s*(?:HTTP|HTTPS|SOCKS|ProxyAutoConfig|ProxyAutoDiscovery)Enable\s*:\s*1\s*$/im.test(output) ? "present" : "none");
    });
  });
}
