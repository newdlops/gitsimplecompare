/** 안전하게 식별한 Git 하위 명령과 조회 여부. 알 수 없는 명령은 쓰기처럼 보호한다. */
export interface GitCommandPolicy { command: string; readOnly: boolean; monitor?: boolean }

/**
 * 전역 옵션을 건너뛰고 조회만 허용 목록으로 분류한다.
 * @param args 셸 해석 없이 Git에 전달할 실제 인자
 * @returns 시간 제한·자동 종료를 적용해도 되는 조회인지와 민감하지 않은 명령 이름
 */
export function gitCommandPolicy(args: readonly string[]): GitCommandPolicy {
  const index = gitCommandIndex(args);
  if (args[index] === "--version" || args[index] === "--exec-path") return { command: "version", readOnly: true };
  const command = args[index] ?? "unknown", rest = args.slice(index + 1);
  const safeName = /^[a-z][a-z0-9-]*$/.test(command) ? command : "unknown";
  const reads = new Set(["status", "log", "show", "diff", "diff-files", "diff-index", "diff-tree", "rev-parse",
    "rev-list", "ls-files", "ls-tree", "cat-file", "check-ignore", "check-attr", "merge-base", "for-each-ref", "blame", "describe", "name-rev", "show-ref", "ls-remote", "check-ref-format"]);
  let readOnly = reads.has(command);
  if (command === "config") readOnly = rest.some(value => ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"].includes(value))
    && !rest.some(value => ["--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section", "--edit", "-e"].includes(value));
  if (command === "branch") readOnly = (rest.length === 0 || rest.some(value => ["--list", "--show-current", "-a", "--all", "-r", "--remotes"].includes(value)))
    && !rest.some(value => /^-(?!-)[^-]*[dDfmMcCu]/.test(value) || /^--(?:delete|move|copy|force|edit-description|set-upstream-to|unset-upstream)(?:=|$)/.test(value));
  if (command === "worktree") readOnly = rest[0] === "list";
  if (command === "remote") readOnly = rest[0] === "get-url";
  if (command === "stash") readOnly = ["list", "show"].includes(rest[0]);
  // reflog 기본 동작은 show지만 delete/expire/write/drop 등 변경 명령은 자동 종료에서 계속 보호한다.
  if (command === "reflog") readOnly = rest.length === 0 || ["show", "list", "exists"].includes(rest[0])
    || (rest[0].startsWith("-") && !rest.some(value => ["delete", "expire", "write", "drop"].includes(value)));
  if (command === "symbolic-ref") readOnly = rest.filter(value => !value.startsWith("-")).length === 1
    && !rest.some(value => ["--delete", "-d"].includes(value));
  if (command === "fsmonitor--daemon") readOnly = rest[0] === "status";
  return { command: safeName, readOnly, ...(command === "fsmonitor--daemon" && rest[0] === "run" && rest.includes("--no-detach") ? { monitor: true } : {}) };
}

/** 전역 옵션의 값과 하위 명령/파일명을 구분해 안전한 명령 범위 override 삽입 위치를 반환한다. */
export function gitCommandIndex(args: readonly string[]): number {
  const withValue = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  let index = 0;
  for (; index < args.length; index++) {
    if (withValue.has(args[index])) { index++; continue; }
    if (args[index] === "--version" || args[index] === "--exec-path") return index;
    if (args[index].startsWith("-")) continue;
    break;
  }
  return index;
}
