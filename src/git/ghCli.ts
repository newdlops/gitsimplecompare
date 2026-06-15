// GitHub CLI 실행을 담당하는 저수준 래퍼.
// - PR 목록/상세 서비스가 gh 실행 방식을 공유하고, 각 서비스는 데이터 해석에만 집중하게 한다.
import { execFile } from "node:child_process";

/**
 * gh CLI 를 실행하고 stdout 문자열을 반환한다.
 * @param args gh 에 전달할 인자 목록
 * @param cwd  gh 를 실행할 저장소 루트
 * @returns gh stdout 전체
 */
export function runGh(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`gh ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}
