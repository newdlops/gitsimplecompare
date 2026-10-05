import { execFile } from "node:child_process";

/** PID 재사용을 검출하기 위한 OS 프로세스 식별자. argv나 환경은 수집하지 않는다. */
export interface ProcessIdentity { pid: number; ppid: number; pgid: number; uid: number; started: string; executable: string }

/** 종료 검사에서 필요한 기존 PID와 소유 그룹만 선택한다. 생략하면 기존 전체 조회를 유지한다. */
export interface ProcessIdentitySelection { pids?: readonly number[]; processGroup?: number }

/**
 * POSIX 프로세스의 사용자·시작 시각·그룹을 한 번에 읽는다. 지원하지 않는 플랫폼은 실패해 보호한다.
 * @param selection 필요한 PID와 그룹의 합집합. macOS는 OS 조회부터 범위를 제한한다.
 * @returns PID별 검증 가능한 프로세스 식별자 목록. 관찰 실패는 빈 목록으로 숨기지 않는다.
 */
export function readProcessIdentities(selection?: ProcessIdentitySelection): Promise<ProcessIdentity[]> {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") { reject(new Error("Process ownership inspection is unavailable on this platform.")); return; }
    const pids = [...new Set(selection?.pids ?? [])], group = selection?.processGroup;
    if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)
      || (group !== undefined && (!Number.isSafeInteger(group) || group <= 0))) {
      reject(new Error("Invalid process ownership selection.")); return;
    }
    if (selection && !pids.length && group === undefined) { resolve([]); return; }
    const fields = "pid=,ppid=,pgid=,uid=,lstart=,comm=";
    // 다른 POSIX 구현의 -g 의미는 다를 수 있으므로 macOS 외의 그룹 조회는 기존 명령을 보존한다.
    const scoped = !!selection && (group === undefined || process.platform === "darwin");
    const args = scoped
      ? [...(pids.length ? ["-p", pids.join(",")] : []), ...(group !== undefined ? ["-g", String(group)] : []), "-o", fields]
      : ["-axo", fields];
    execFile("/bin/ps", args,
      { encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, output, stderr) => {
        // 선택한 프로세스가 전부 종료된 경우 ps는 헤더 없는 빈 stdout과 종료 코드 1을 반환한다.
        if (error && !(scoped && error.code === 1 && !output.trim() && !stderr.trim())) { reject(error); return; }
        const rows = parseProcessIdentities(output);
        resolve(selection ? rows.filter(row => pids.includes(row.pid) || row.pgid === group) : rows);
      });
  });
}

/** ps의 고정 lstart 필드를 해석하며 불완전한 행은 소유권 증거로 사용하지 않는다. */
export function parseProcessIdentities(output: string): ProcessIdentity[] {
  return output.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: +match[1], ppid: +match[2], pgid: +match[3], uid: +match[4], started: match[5].replace(/\s+/g, " "), executable: match[6] }] : [];
  });
}

/** 재조회된 PID가 같은 프로세스인지 UID·시작 시각·실행 파일·그룹까지 비교한다. */
export function sameProcess(before: ProcessIdentity, after: ProcessIdentity | undefined): boolean {
  return !!after && before.pid === after.pid && before.uid === after.uid && before.started === after.started
    && before.pgid === after.pgid && before.executable === after.executable;
}
