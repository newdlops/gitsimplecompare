import { execFile } from "node:child_process";

/** PID 재사용을 검출하기 위한 OS 프로세스 식별자. argv나 환경은 수집하지 않는다. */
export interface ProcessIdentity { pid: number; ppid: number; pgid: number; uid: number; started: string; executable: string }

/**
 * POSIX 프로세스의 사용자·시작 시각·그룹을 한 번에 읽는다. 지원하지 않는 플랫폼은 실패해 보호한다.
 * @returns PID별 검증 가능한 프로세스 식별자 목록
 */
export function readProcessIdentities(): Promise<ProcessIdentity[]> {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") { reject(new Error("Process ownership inspection is unavailable on this platform.")); return; }
    execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,uid=,lstart=,comm="],
      { encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, output) => {
        if (error) { reject(error); return; }
        resolve(parseProcessIdentities(output));
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
