// VS Code OUTPUT 채널 로깅 유틸.
// - 확장의 활성화/refresh/event 흐름을 사용자가 직접 관찰할 수 있도록 한곳에서 채널을 관리한다.
import * as vscode from "vscode";

type LogLevel = "info" | "warn" | "error";

let channel: vscode.OutputChannel | undefined;
let muteDepth = 0;
let mutedLines = 0;
let mutedReason = "";
const mutedSamples: string[] = [];
const MAX_MUTED_SAMPLES = 20;

/** OUTPUT 채널을 지연 생성해 확장 활성화 이후 필요한 시점부터 사용한다. */
function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Git Simple Compare");
  }
  return channel;
}

/** 로그 행 앞에 붙일 로컬 시각 문자열을 만든다. */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * 로그에 붙일 부가 정보를 짧은 JSON 문자열로 만든다.
 * @param detail 직렬화 가능한 부가 상태
 * @returns 빈 문자열 또는 ` {...}` 형태의 상세 문자열
 */
function formatDetail(detail?: Record<string, unknown>): string {
  if (!detail || Object.keys(detail).length === 0) {
    return "";
  }
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return " {detail:unserializable}";
  }
}

/**
 * OUTPUT 채널에 한 줄 로그를 남긴다.
 * @param level 로그 수준
 * @param message 사람이 읽을 상태 메시지
 * @param detail 재현에 필요한 부가 상태
 */
function write(
  level: LogLevel,
  message: string,
  detail?: Record<string, unknown>
): void {
  const line = `[${timestamp()}] [${level.toUpperCase()}] ${message}${formatDetail(
    detail
  )}`;
  if (muteDepth > 0) {
    mutedLines++;
    if (mutedSamples.length < MAX_MUTED_SAMPLES) {
      mutedSamples.push(line);
    }
    return;
  }
  getChannel().appendLine(line);
}

/**
 * 짧은 고부하 구간 동안 OUTPUT 쓰기를 멈추고 마지막에 요약 한 줄만 남긴다.
 * @param reason 로그를 묶는 이유
 * @returns 구간 종료 시 호출할 함수
 */
export function pauseOutputLog(reason: string): () => void {
  muteDepth++;
  mutedReason = mutedReason || reason;
  let finished = false;
  return () => {
    if (finished) {
      return;
    }
    finished = true;
    muteDepth = Math.max(0, muteDepth - 1);
    if (muteDepth === 0 && mutedLines > 0) {
      const lines = mutedLines;
      const lastReason = mutedReason;
      const samples = mutedSamples.splice(0);
      mutedLines = 0;
      mutedReason = "";
      getChannel().appendLine(
        `[${timestamp()}] [INFO] output log muted${formatDetail({
          reason: lastReason,
          lines,
          samples: samples.length,
        })}`
      );
      for (const sample of samples) {
        getChannel().appendLine(`${sample} [muted]`);
      }
    }
  };
}

/** 일반 상태 전환 로그를 남긴다. */
export function logInfo(
  message: string,
  detail?: Record<string, unknown>
): void {
  write("info", message, detail);
}

/** 사용자는 계속 진행할 수 있지만 원인 추적에 필요한 경고를 남긴다. */
export function logWarn(
  message: string,
  detail?: Record<string, unknown>
): void {
  write("warn", message, detail);
}

/**
 * 오류 로그를 남긴다.
 * @param message 오류가 발생한 작업
 * @param error Error 또는 알 수 없는 throw 값
 * @param detail 추가 상태
 */
export function logError(
  message: string,
  error: unknown,
  detail?: Record<string, unknown>
): void {
  const err = errorDetail(error);
  write("error", message, { ...detail, error: err });
}

/** Error 객체에 붙은 stderr/stdout 같은 진단 필드까지 로그용 객체로 변환한다. */
function errorDetail(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const extra = error as Error & {
    code?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    code: extra.code,
    stderr: clippedText(extra.stderr),
    stdout: clippedText(extra.stdout),
    stack: error.stack,
  };
}

/** 긴 git 출력이 OUTPUT 한 줄을 과도하게 키우지 않도록 적당히 자른다. */
function clippedText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value.length > 4000 ? `${value.slice(0, 4000)}...[truncated]` : value;
}

/**
 * OUTPUT 채널을 사용자에게 표시한다.
 * - 알림 토스트로는 잘려 보이는 긴 git/훅 출력(예: pre-commit lint 실패)을 전체로 확인하게 한다.
 * @param preserveFocus true 면 포커스를 편집기에 유지한 채 채널만 드러낸다.
 */
export function showOutputLog(preserveFocus = true): void {
  getChannel().show(preserveFocus);
}

/**
 * hook/외부 프로세스의 여러 줄 원문을 자르지 않고 OUTPUT 채널에 별도 블록으로 남긴다.
 * - 일반 logError 는 재현 메타데이터 한 줄을 위해 stderr/stdout 을 줄이지만,
 *   이 함수는 사용자가 "전체 출력"에서 실제 lint 결과를 모두 확인하도록 원문을 보존한다.
 * @param label 블록 시작/끝에 표시할 작업 이름
 * @param output stdout/stderr 에서 수집한 전체 텍스트
 * @param detail 저장소/명령/단계처럼 블록을 구분할 메타데이터
 */
export function logOutputBlock(
  label: string,
  output: string,
  detail?: Record<string, unknown>
): void {
  if (!output.trim()) {
    return;
  }
  const outputChannel = getChannel();
  outputChannel.appendLine(
    `[${timestamp()}] [ERROR] ${label} begin${formatDetail(detail)}`
  );
  outputChannel.append(output.endsWith("\n") ? output : `${output}\n`);
  outputChannel.appendLine(
    `[${timestamp()}] [ERROR] ${label} end`
  );
}

/**
 * git 작업 실패를 OUTPUT 채널에 자세히(stderr/stdout 포함) 기록하고, 사용자에게는
 * 요약 알림과 함께 "출력 보기" 액션을 보여준다.
 * - 알림 토스트는 길이가 잘리므로, pre-commit 훅/원격 거절 등 긴 출력의 전체는 OUTPUT 채널에서 확인하게 한다.
 * @param logLabel OUTPUT 로그에 남길 작업 이름(예: "push failed")
 * @param error    발생한 오류(GitError 면 stderr/stdout 이 함께 기록된다)
 * @param message  사용자에게 보여줄 요약 알림 문구(이미 l10n 이 적용된 최종 문자열)
 * @param detail   OUTPUT 로그에 함께 남길 부가 상태
 */
export function showErrorWithOutput(
  logLabel: string,
  error: unknown,
  message: string,
  detail?: Record<string, unknown>
): void {
  logError(logLabel, error, detail);
  const showOutput = vscode.l10n.t("Show Output");
  void vscode.window.showErrorMessage(message, showOutput).then((choice) => {
    if (choice === showOutput) {
      showOutputLog(false);
    }
  });
}

/** 확장 비활성화 시 OUTPUT 채널 리소스를 해제한다. */
export function disposeOutputLog(): void {
  channel?.dispose();
  channel = undefined;
}
