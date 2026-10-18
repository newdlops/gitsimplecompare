// 같은 native 문서/version의 marker 파싱을 decoration과 CodeLens가 공유한다.
import { scanConflictMarkers, type ConflictMarkerScan } from "./conflictMarkerModel";

interface ConflictTextDocument { version: number; getText(): string }
const scans = new WeakMap<ConflictTextDocument, { version: number; scan: ConflictMarkerScan }>();

/**
 * 같은 문서 객체와 version의 파싱만 재사용하고 실제 편집 뒤에는 즉시 다시 읽는다.
 * @param document VS Code가 version을 증가시키는 native 문서. 닫힌 문서는 WeakMap에서 회수된다.
 * @returns 표시용 scan. mutation은 현재 원문과 action token을 별도로 다시 검증한다.
 */
export function scanConflictDocument(document: ConflictTextDocument): ConflictMarkerScan {
  const cached = scans.get(document);
  if (cached?.version === document.version) return cached.scan;
  const scan = scanConflictMarkers(document.getText());
  scans.set(document, { version: document.version, scan });
  return scan;
}
