// Git 실행 파일 탐색·시작 시간 진단 서비스.
// - 저장소나 Git 설정을 변경하지 않고 --version의 실행 결과와 중앙값만 비교한다.
// - 모든 프로세스 실행은 공통 gitExec을 사용하며 VS Code UI에는 의존하지 않는다.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./gitExec";

/** 한 실행 파일의 버전 검사와 반복 시작 시간 측정 결과다. */
export interface GitExecutableProbe {
  executable: string;
  version?: string;
  samplesMs: number[];
  medianMs?: number;
  error?: string;
  timedOut?: boolean;
}

/**
 * 현재 경로·PATH와 운영체제의 대표 설치 위치에서 실행 가능한 후보를 찾는다.
 * - 사용자가 지정한 경로는 없어도 포함해 설정 오류를 진단할 수 있게 한다.
 * @param current 현재 확장에서 사용하는 실행 파일
 * @param additional 내장 Git 등에서 이미 설정한 추가 후보 경로
 * @returns 중복 없는 실행 파일 후보 목록
 */
export async function findGitExecutables(current: string, additional: string[] = []): Promise<string[]> {
  const candidates = new Set([current, "git", ...additional].filter(Boolean));
  const locations = process.platform === "darwin"
    ? ["/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
      "/opt/homebrew/bin/git", "/usr/local/bin/git", "/opt/local/bin/git"]
    : process.platform === "win32"
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
        .filter((base): base is string => Boolean(base)).map(base => path.join(base, "Git", "cmd", "git.exe"))
      : ["/usr/bin/git", "/usr/local/bin/git"];
  const found = await Promise.all(locations.map(async executable => {
    try { await access(executable, constants.X_OK); return executable; }
    catch { return undefined; }
  }));
  for (const executable of found) if (executable) candidates.add(executable);
  return [...candidates];
}

/**
 * Git 버전을 세 번 조회해 시작 시간 중앙값을 얻고 실패한 실행 파일은 선택에서 제외한다.
 * - 호출 취소는 결과가 아니라 예외로 전달하며 각 샘플의 제한 시간은 별도로 적용한다.
 * @param executable 셸을 거치지 않고 시험할 실행 파일 이름 또는 경로
 * @param cwd 실행할 작업 디렉터리. --version은 저장소를 읽거나 변경하지 않는다.
 * @param signal 전체 진단을 취소할 신호
 * @param sampleCount 중앙값 계산에 사용할 반복 횟수
 * @param timeoutMs 한 샘플의 최대 대기 시간
 * @returns 버전·시간 또는 오류 원인을 담은 진단 결과
 */
export async function probeGitExecutable(
  executable: string, cwd: string, signal?: AbortSignal, sampleCount = 3, timeoutMs = 5_000
): Promise<GitExecutableProbe> {
  const result: GitExecutableProbe = { executable, samplesMs: [] };
  for (let sample = 0; sample < sampleCount; sample++) {
    if (signal?.aborted) throw signal.reason;
    const controller = new AbortController();
    /** 상위 진단 취소를 현재 샘플의 Git 프로세스 종료에 연결한다. */
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const start = performance.now();
    try {
      const output = (await runGit(["--version"], cwd, {
        executable, signal: controller.signal, retryOnLock: false, maxBuffer: 64 * 1024,
      })).trim();
      if (!/^git version \S+/.test(output)) throw new Error("The executable did not report a Git version.");
      result.version = output.split(/\r?\n/, 1)[0];
      result.samplesMs.push(performance.now() - start);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      result.error = error instanceof Error ? error.message : String(error);
      result.timedOut = timedOut;
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
  const sorted = [...result.samplesMs].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  result.medianMs = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return result;
}
