// GitHub review 서비스가 gh 프로세스 구현 대신 안정된 요청 계약에 의존하게 하는 어댑터.
// - 각 서비스는 operation 이름, 취소, JSON parsing을 명시하고 fake runner로 단위 테스트할 수 있다.
import { runGh, type RunGhOptions } from "./ghCli";

/** review 서비스가 gh 실행에 전달할 관찰 가능한 옵션. */
export interface GhRunnerOptions extends RunGhOptions {
  /** 오류·로그에서 raw args를 대체할 안정된 작업 이름 */
  operation: string;
}

/** 실제 gh 실행을 대체할 수 있는 작은 함수 타입. */
export type GhExecute = (
  args: readonly string[],
  cwd: string,
  options: GhRunnerOptions
) => Promise<string>;

/** review 도메인이 사용하는 gh 실행/JSON 계약. */
export interface GhRunner {
  run(args: readonly string[], cwd: string, options: GhRunnerOptions): Promise<string>;
  runJson<T>(args: readonly string[], cwd: string, options: GhRunnerOptions): Promise<T>;
}

/** gh 출력이 JSON contract를 만족하지 않을 때 API 오류와 구분할 전용 오류. */
export class GhJsonError extends Error {
  constructor(public readonly operation: string) {
    super(`GitHub CLI operation ${operation} returned invalid JSON.`);
    this.name = "GhJsonError";
  }
}

/**
 * production gh 실행을 review 서비스 계약으로 감싸는 기본 runner.
 * @param execute 테스트에서 fake runner를 주입할 수 있는 실제 실행 함수
 */
export class DefaultGhRunner implements GhRunner {
  constructor(private readonly execute: GhExecute = runGh) {}

  /**
   * gh stdout을 원문 그대로 실행한다.
   * @param args    service가 조립한 안전한 gh 인자
   * @param cwd     repository 또는 workspace 실행 경로
   * @param options 취소·버퍼·operation 정보
   * @returns gh stdout 전체
   */
  public run(
    args: readonly string[],
    cwd: string,
    options: GhRunnerOptions
  ): Promise<string> {
    return this.execute(args, cwd, options);
  }

  /**
   * gh stdout을 JSON으로 파싱한다.
   * @param args    service가 조립한 안전한 gh 인자
   * @param cwd     repository 또는 workspace 실행 경로
   * @param options 취소·버퍼·operation 정보
   * @returns T로 해석한 gh JSON 응답
   */
  public async runJson<T>(
    args: readonly string[],
    cwd: string,
    options: GhRunnerOptions
  ): Promise<T> {
    const stdout = await this.run(args, cwd, options);
    return parseGhJson<T>(stdout, options.operation);
  }
}

/**
 * gh JSON stdout을 안전하게 파싱한다.
 * @param stdout    gh가 반환한 JSON 문자열
 * @param operation 오류에 표시할 안전한 작업 이름
 * @returns T로 해석한 JSON value
 */
export function parseGhJson<T>(stdout: string, operation: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new GhJsonError(operation);
  }
}
