// 보이는 diff의 준비 상태와 editor group 순서를 Hunk renderer snapshot에 연결한다.
import type { HunkOverlaySnapshot } from "./hunkCheckboxController";
import type { ActiveHunkDiffTarget } from "./hunkDiffContext";
import { isDiffOpenInProgress } from "./diffOpenGate";
import { skipInvalidatedHunkSnapshot } from "./hunkCacheEvents";

/**
 * 준비된 diff는 즉시 읽고 대기 중인 group은 제어 없는 자리표시자로 남겨 파일 연결을 보존한다.
 * @param targets editor group 순서로 정렬된 보이는 diff 대상
 * @param revision 선택 상태/내용 변경을 구분할 snapshot 세대
 * @param read Git 조회와 표시 줄 좌표 계산을 담당하는 소비자 함수
 * @returns 하나라도 준비되면 전체 group 배열, 전부 대기 중이면 주입을 시작하지 않을 빈 배열
 */
export async function readHunkOverlaySnapshots(
  targets: readonly ActiveHunkDiffTarget[], revision: number,
  read: (target: ActiveHunkDiffTarget) => Promise<HunkOverlaySnapshot | undefined>
): Promise<HunkOverlaySnapshot[]> {
  if (targets.every(target => isDiffOpenInProgress(target.modified))) return [];
  const snapshots = await Promise.all(targets.map(async target => {
    const snapshot = isDiffOpenInProgress(target.modified) ? undefined
      : await skipInvalidatedHunkSnapshot(target.relPath, () => read(target));
    // 대상을 배열에서 빼면 DOM 순서가 밀려 다른 파일에 체크박스가 붙을 수 있다.
    return snapshot ?? {
      originalUri: target.original.toString(), uri: target.modified.toString(), path: target.relPath,
      action: target.stage === "staged" ? "unstage" as const : "stage" as const,
      revision, lines: [], pending: true,
    };
  }));
  return snapshots.some(snapshot => !snapshot.pending) ? snapshots : [];
}
