// AI Commit Plan의 마지막 실행 실패 원문을 패널 메모리에 보관하고 로그 미리보기·복사를 담당한다.
// - 웹뷰는 실패 ID만 돌려보내며, 클립보드에는 host가 보관한 해당 실패 원문만 쓴다.
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import * as vscode from "vscode";
import { logInfo, logWarn } from "../ui/outputLog";

/** 실패 한 건의 제한된 화면 표시 데이터. 전체 원문은 host에만 보관한다. */
export interface CommitPlanFailureLogPreview {
  id: string;
  text: string;
  truncated: boolean;
  canCopy: boolean;
}

/** 복사 완료 알림은 실행 실패 상태와 별도로 전달해 기존 진단을 보존한다. */
export interface CommitPlanFailureLogCopyResult {
  success: boolean;
  message: string;
}

const MAX_PREVIEW_CHARS = 128_000;

/** 패널 한 세션에서 마지막 실행 실패만 보관하는 로그 수명주기다. */
export class CommitPlanFailureLog {
  private current?: { id: string; output: string };

  /**
   * 실패 원문을 교체하고 터미널 제어 문자를 제거한 표시용 사본을 만든다.
   * @param output 실패한 Git/hook의 stdout·stderr 또는 출력 없는 오류의 메시지
   * @returns 전체 복사용 ID와 크기가 제한된 로그 미리보기
   */
  capture(output: string): CommitPlanFailureLogPreview {
    const id = randomUUID();
    this.current = { id, output };
    const display = stripVTControlCharacters(output).replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    const truncated = display.length > MAX_PREVIEW_CHARS;
    return {
      id, text: truncated ? previewEnds(display) : display, truncated,
      canCopy: output.trim().length > 0,
    };
  }

  /** 새 실행·컨텍스트·패널 종료 때 원문을 해제해 과거 실패 ID를 무효화한다. */
  clear(): void { this.current = undefined; }

  /**
   * 현재 실패 ID가 일치할 때만 host 원문을 복사하고 실제 성공 여부를 반환한다.
   * @param id 웹뷰의 복사 버튼이 표시한 실패 식별자
   * @returns 성공 안내 또는 로그 만료·클립보드 실패 안내. 원문은 로그에 재출력하지 않는다.
   */
  async copy(id: string): Promise<CommitPlanFailureLogCopyResult> {
    const current = this.current;
    if (!current || current.id !== id || !current.output.trim()) {
      logInfo("AI commit plan log copy skipped", { reason: "unavailable" });
      return { success: false, message: vscode.l10n.t("This commit log is no longer available.") };
    }
    try {
      await vscode.env.clipboard.writeText(current.output);
      logInfo("AI commit plan log copied", { characters: current.output.length });
      return { success: true, message: vscode.l10n.t("Commit log copied to clipboard.") };
    } catch {
      logWarn("AI commit plan log copy failed", { reason: "clipboard-write-failed" });
      return { success: false, message: vscode.l10n.t("Could not copy the commit log. Try again or select and copy the log text.") };
    }
  }
}

/**
 * 큰 로그의 시작과 마지막 오류를 함께 보여 주며 UTF-16 문자 중간에서 자르지 않는다.
 * @param output 제어 문자를 정리한 전체 로그
 * @returns 상한 이내의 앞·뒤 미리보기. 생략 여부 안내는 별도 지역화 UI에서 제공한다.
 */
function previewEnds(output: string): string {
  const half = (MAX_PREVIEW_CHARS - 5) >> 1;
  const start = output.slice(0, half).replace(/[\ud800-\udbff]$/, "");
  const end = output.slice(-half).replace(/^[\udc00-\udfff]/, "");
  return `${start}\n\n…\n\n${end}`;
}
