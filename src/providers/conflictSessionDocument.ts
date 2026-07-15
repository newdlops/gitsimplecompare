// native conflict session URI와 readonly 특수 Result의 판단용 plaintext를 만든다.
// - 원래 확장자를 보존해 writable native editor의 언어 감지를 유지한다.
import * as path from "node:path";
import * as vscode from "vscode";
import type { ConflictDocument } from "../git/conflictService";
import { buildConflictOverlayPresentation } from "../ui/conflictOverlayPresentation";

/**
 * 실제 file URI를 노출하지 않는 고유 conflict session URI를 만든다.
 * @param rel 저장소 상대 경로. basename과 원래 확장자만 표시 이름에 사용한다.
 * @param id stale command를 분리하는 opaque session id
 * @param scheme writable 또는 readonly conflict provider scheme
 */
export function conflictSessionUri(
  rel: string,
  id: string,
  scheme: string
): vscode.Uri {
  const safeName = path.basename(rel).replace(/[^\p{L}\p{N}._-]+/gu, "_") || "result";
  return vscode.Uri.from({
    scheme,
    path: `/${safeName}`,
    query: `session=${encodeURIComponent(id)}`,
  });
}

/**
 * non-text Result의 native readonly 문서에 commit/rebase 판단 정보와 해결 상태를 담는다.
 * @param document host가 안전하게 읽은 conflict source/context snapshot
 * @param resolved true면 더 이상 action 대상이 아니라는 안내를 맨 위에 표시한다.
 */
export function virtualConflictDocumentText(
  document: ConflictDocument,
  resolved = false
): string {
  const presentation = buildConflictOverlayPresentation(document);
  const lines = [
    `${presentation.title}: ${presentation.path}`,
    `${presentation.operation}`,
    "",
    resolved ? vscode.l10n.t("This conflict is resolved.") : presentation.virtualNotice || "",
    "",
    ...presentation.cards.flatMap((card) => [
      card.title,
      card.identity,
      card.secondary || "",
      card.state || "",
      card.detail,
      "",
    ]),
    presentation.impact.title,
    presentation.impact.detail,
  ];
  return lines.filter((line, index) => line || lines[index - 1] !== "").join("\n");
}
