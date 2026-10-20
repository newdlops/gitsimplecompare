// 선택한 benchmark 구간의 Node CPU만 기록한다. 기본 실행에는 inspector 연결이나 파일 출력을 추가하지 않는다.
import { Session, type Profiler } from "node:inspector";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** 시작한 profiler를 한 번만 종료하고 원본 profile을 저장하는 수명 경계다. */
export interface NodeCpuProfile { stop(): Promise<void>; }

/**
 * 환경 변수로 요청한 경우에만 현재 Node process의 샘플링을 시작한다. 외부 디버그 포트는 열지 않는다.
 * @param name 파일에 사용할 작업 이름 @returns 종료 함수. 계측을 요청하지 않았으면 undefined
 */
export async function startNodeCpuProfile(name: string): Promise<NodeCpuProfile | undefined> {
  const directory = process.env.GSC_BENCH_CPU_PROFILE_DIR;
  if (!directory) return undefined;
  const session = new Session(); session.connect();
  /** @param method inspector 메서드 @param params 선택 설정 @returns 해당 로컬 inspector 응답 */
  const post = <T = unknown>(method: string, params = {}): Promise<T> => new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result as T));
  });
  try {
    await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: 1000 });
    await post("Profiler.start");
  } catch (error) { session.disconnect(); throw error; }
  let stopping: Promise<void> | undefined;
  /** 샘플링을 끝내고 fixture 전용 작업 이름으로 저장한다. 중복 finally도 같은 완료를 기다린다. */
  const stop = async (): Promise<void> => {
    try {
      const { profile } = await post<Profiler.StopReturnType>("Profiler.stop");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${name.replace(/[^a-z0-9-]/gi, "-")}.cpuprofile`), JSON.stringify(profile));
    } finally { session.disconnect(); }
  };
  return { stop: () => stopping ??= stop() };
}
