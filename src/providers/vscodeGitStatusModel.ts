// VS Code 내장 Git API 상태를 해석하는 순수 모델 모듈.
// - status enum 변환, working-status fingerprint, snapshot 전이 분류, statusLimit 잘림 판정을 담는다.
// - vscode 런타임에 의존하지 않아 provider(이벤트/생명주기)와 분리해 단위 테스트할 수 있다.
import * as path from "node:path";
import type { FileChange, FileChangeStatus } from "../git/gitTypes";

/** branch 이름과 HEAD commit을 분리해 상태 이벤트 의미를 판별하는 snapshot이다. */
export interface VscodeGitRepositoryIdentity {
  branch: string;
  head: string;
}

/** provider working-status fingerprint가 사용하는 변경 항목의 최소 구조다. */
export interface VscodeGitFingerprintChange {
  readonly uri: { readonly fsPath: string };
  readonly renameUri?: { readonly fsPath: string };
  readonly status: number;
}

/** index/working/untracked/merge 배열만 분리해 순수 fingerprint 테스트에 사용하는 구조다. */
export interface VscodeGitFingerprintState {
  readonly indexChanges: readonly VscodeGitFingerprintChange[];
  readonly workingTreeChanges: readonly VscodeGitFingerprintChange[];
  readonly untrackedChanges: readonly VscodeGitFingerprintChange[];
  readonly mergeChanges: readonly VscodeGitFingerprintChange[];
}

/** branch/HEAD와 working fingerprint를 함께 비교하는 provider repository snapshot이다. */
export interface VscodeGitRepositorySnapshot extends VscodeGitRepositoryIdentity {
  statusFingerprint: string;
}

/** repository snapshot 변화에서 callback 이유와 status revision 증가 여부를 분리한 결과다. */
export interface VscodeGitRepositoryTransition {
  reasons: Array<"vscodeGit:head" | "vscodeGit:identity" | "vscodeGit:state">;
  statusChanged: boolean;
}

/** VS Code 내장 Git 의 `git.statusLimit` 기본값. */
export const DEFAULT_VSCODE_GIT_STATUS_LIMIT = 10000;

/** VS Code Git API 의 Status enum 숫자값(공개 API 계약). */
const enum VscodeGitStatus {
  IndexModified = 0,
  IndexAdded = 1,
  IndexDeleted = 2,
  IndexRenamed = 3,
  IndexCopied = 4,
  Modified = 5,
  Deleted = 6,
  Untracked = 7,
  Ignored = 8,
  IntentToAdd = 9,
  BothDeleted = 10,
  AddedByUs = 11,
  DeletedByThem = 12,
  AddedByThem = 13,
  DeletedByUs = 14,
  BothAdded = 15,
  BothModified = 16,
}

/**
 * 인덱스 변경 상태를 FileChangeStatus 로 변환한다.
 * @param status VS Code Git Status enum 숫자값
 */
export function mapIndexStatus(status: number): FileChangeStatus | undefined {
  switch (status) {
    case VscodeGitStatus.IndexModified:
      return "M";
    case VscodeGitStatus.IndexAdded:
      return "A";
    case VscodeGitStatus.IndexDeleted:
      return "D";
    case VscodeGitStatus.IndexRenamed:
      return "R";
    case VscodeGitStatus.IndexCopied:
      return "C";
    default:
      return isConflictStatus(status) ? "U" : undefined;
  }
}

/**
 * 작업트리 변경 상태를 FileChangeStatus 로 변환한다.
 * @param status VS Code Git Status enum 숫자값
 */
export function mapWorkingStatus(status: number): FileChangeStatus | undefined {
  switch (status) {
    case VscodeGitStatus.Modified:
      return "M";
    case VscodeGitStatus.Deleted:
      return "D";
    case VscodeGitStatus.Untracked:
    case VscodeGitStatus.IntentToAdd:
      return "A";
    case VscodeGitStatus.Ignored:
      return undefined;
    default:
      return isConflictStatus(status) ? "U" : undefined;
  }
}

/**
 * merge/rebase 충돌 상태인지 확인한다.
 * @param status VS Code Git Status enum 숫자값
 */
function isConflictStatus(status: number): boolean {
  return (
    status >= VscodeGitStatus.BothDeleted &&
    status <= VscodeGitStatus.BothModified
  );
}

/**
 * 중복 상태 항목을 제거한다.
 * @param changes 병합 전 변경 목록
 */
export function uniqueChanges(changes: FileChange[]): FileChange[] {
  const seen = new Set<string>();
  const out: FileChange[] = [];
  for (const change of changes) {
    const key = `${change.status}\0${change.path}\0${change.oldPath ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(change);
  }
  return out;
}

/**
 * VS Code Git의 working-status 배열을 순서와 경로 구분자에 안정적인 fingerprint로 만든다.
 * - branch/HEAD는 포함하지 않아 identity-only event가 direct-file fallback revision을 올리지 않는다.
 * @param state index/working/untracked/merge 변경 배열
 * @returns bucket·status·현재/rename 경로를 정렬해 결합한 문자열
 */
export function vscodeGitWorkingStatusFingerprint(
  state: VscodeGitFingerprintState
): string {
  const entries: string[] = [];
  for (const [bucket, changes] of [
    ["index", state.indexChanges],
    ["working", state.workingTreeChanges],
    ["untracked", state.untrackedChanges],
    ["merge", state.mergeChanges],
  ] as const) {
    for (const change of changes) {
      entries.push([
        bucket,
        change.status,
        normalizeGitApiPath(change.uri.fsPath),
        change.renameUri ? normalizeGitApiPath(change.renameUri.fsPath) : "",
      ].join("\0"));
    }
  }
  return entries.sort().join("\n");
}

/**
 * 내장 Git 상태 배열이 `git.statusLimit` 때문에 잘렸을 수 있는지 판정한다.
 * - 내장 Git 은 porcelain 항목 수가 한도를 넘으면 한도 개수까지만 보관한다. 항목 하나가 index/working
 *   양쪽에 나타날 수 있어 배열 합계는 항목 수 이상이므로, 합계가 한도 이상이면 잘림 가능성으로 본다.
 * - 한도와 정확히 같은 실제 변경 수도 폴백 대상이 되지만 CLI 로 한 번 더 읽을 뿐 결과는 정확하다.
 * @param state index/working/untracked/merge 변경 배열
 * @param limit `git.statusLimit` 설정값. 0 이하면 무제한
 * @returns 잘렸을 수 있으면 true
 */
export function vscodeGitStatusMayBeTruncated(
  state: VscodeGitFingerprintState,
  limit: number
): boolean {
  if (!Number.isFinite(limit) || limit <= 0) {
    return false;
  }
  const total =
    state.indexChanges.length +
    state.workingTreeChanges.length +
    state.untrackedChanges.length +
    state.mergeChanges.length;
  return total >= limit;
}

/**
 * 이전/현재 repository snapshot을 head 우선 event와 독립 status revision으로 분류한다.
 * - head 변화는 full refresh 하나로 충분하고, same-head identity+status는 목록과 working 의미를 각각 보존한다.
 * - 실제 onDidChange에서 identity가 그대로면 fingerprint가 같아도 state를 보내 동일 M 파일의 통계 보강을 다시 예약한다.
 * @param previous 직전 branch/HEAD/working fingerprint
 * @param current 최신 branch/HEAD/working fingerprint
 * @returns emit할 이유 순서와 status revision 증가 여부
 */
export function classifyVscodeGitRepositoryTransition(
  previous: VscodeGitRepositorySnapshot,
  current: VscodeGitRepositorySnapshot
): VscodeGitRepositoryTransition {
  const statusChanged =
    previous.statusFingerprint !== current.statusFingerprint;
  if (previous.head !== current.head) {
    return { reasons: ["vscodeGit:head"], statusChanged };
  }
  const reasons: VscodeGitRepositoryTransition["reasons"] = [];
  const branchChanged = previous.branch !== current.branch;
  if (branchChanged) reasons.push("vscodeGit:identity");
  if (statusChanged || !branchChanged) reasons.push("vscodeGit:state");
  return { reasons, statusChanged };
}

/**
 * 플랫폼별 경로 차이를 줄이기 위해 비교용 경로를 정규화한다.
 * @param value 절대 경로
 */
export function normalizeGitApiPath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}
