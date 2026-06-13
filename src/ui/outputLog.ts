// VS Code OUTPUT 채널 로깅 유틸.
// - 확장의 활성화/refresh/event 흐름을 사용자가 직접 관찰할 수 있도록 한곳에서 채널을 관리한다.
import * as vscode from "vscode";

type LogLevel = "info" | "warn" | "error";

let channel: vscode.OutputChannel | undefined;
let muteDepth = 0;
let mutedLines = 0;
let mutedReason = "";

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
  if (muteDepth > 0) {
    mutedLines++;
    return;
  }
  getChannel().appendLine(
    `[${timestamp()}] [${level.toUpperCase()}] ${message}${formatDetail(
      detail
    )}`
  );
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
      mutedLines = 0;
      mutedReason = "";
      logInfo("output log muted", { reason: lastReason, lines });
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
  const err =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
  write("error", message, { ...detail, error: err });
}

/** 확장 비활성화 시 OUTPUT 채널 리소스를 해제한다. */
export function disposeOutputLog(): void {
  channel?.dispose();
  channel = undefined;
}
