// 같은 PR 앵커의 원래 commit/file-count만 공유한다. 제목·상태·리뷰·댓글·라벨은 포함하지 않는다.
import type { PullRequestInfo } from "./pullRequestInfo";
import type { GitHubSnapshotIdentity } from "./githubPullRequestSnapshots";

export type StablePullRequestSnapshot = Pick<PullRequestInfo, "number" | "headHash" | "baseHash" | "baseRefName" |
  "commitHashes" | "commitSummaries" | "commitHashesComplete" | "fileCount" | "fileCountComplete">;
interface Entry { repository: string; credentialKey: string; value: StablePullRequestSnapshot; bytes: number; }

/** 불완전한 요약이나 SHA 대체 제목을 완료 snapshot으로 승격하지 않는 bounded 저장소다. */
export class GitHubCommitSnapshots {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  /** 인증을 결정하지 않는 query-shape 힌트이며 실제 재사용에는 현재 페이지 identity가 필요하다. */
  has(repository: string, number?: number): boolean {
    return [...this.entries.values()].some(entry => entry.repository === repository.toLowerCase() && (number === undefined || entry.value.number === number));
  }

  /** 최신 인증 응답이 보고한 PR 번호/head/base/대상 branch와 같은 완전한 값만 복사한다. */
  get(identity: GitHubSnapshotIdentity, number: number, head: string, base: string, baseRefName: string): StablePullRequestSnapshot | undefined {
    const key = this.key(identity, number, head, base, baseRefName), entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry); return clone(entry.value);
  }

  /** 모든 pagination·문맥 검증이 성공한 뒤 complete summary와 정확한 file count만 저장한다. */
  put(identity: GitHubSnapshotIdentity, value: StablePullRequestSnapshot): void {
    if (!canReuseStableConnections({ headRefOid: value.headHash, baseRefOid: value.baseHash, baseRefName: value.baseRefName }, value)) return;
    const key = this.key(identity, value.number, value.headHash!, value.baseHash!, value.baseRefName);
    const copy = clone(value), bytes = Buffer.byteLength(JSON.stringify(copy));
    if (bytes > 4 * 1024 * 1024) return;
    this.remove(key); this.entries.set(key, { repository: identity.repository.toLowerCase(), credentialKey: identity.credentialKey, value: copy, bytes });
    this.bytes += bytes;
    while (this.entries.size > 128 || this.bytes > 16 * 1024 * 1024) this.remove(this.entries.keys().next().value!);
  }

  /** 401나 활성화 종료 때 credential 경계를 벗어난 재사용 후보도 함께 제거한다. */
  invalidateCredential(key: string): void { for (const [entryKey, entry] of this.entries) if (entry.credentialKey === key) this.remove(entryKey); }
  /** 이 저장소의 완료 항목만 정리한다. */
  clear(): void { this.entries.clear(); this.bytes = 0; }
  /** 원래 commit의 API·정규화 버전과 실제 인증을 immutable key에 포함한다. */
  private key(identity: GitHubSnapshotIdentity, number: number, head: string, base: string, baseName: string): string {
    return JSON.stringify(["commits-v1", identity.host, identity.repository.toLowerCase(), number, head, base, baseName, identity.credentialKey]);
  }
  /** LRU 정리와 byte 수를 같은 경계에서 갱신한다. */
  private remove(key: string): void { const entry = this.entries.get(key); if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); } }
}

/** 실제 제목이 모든 원래 OID에 존재하는지 확인해 불완전한 commit 정보를 재사용하지 않는다. */
export function hasCompleteCommitSummaries(pr: StablePullRequestSnapshot): boolean {
  const hashes = new Set(pr.commitSummaries?.filter(summary => typeof summary.title === "string").map(summary => summary.hash));
  return pr.commitHashes.every(hash => hashes.has(hash));
}

/** 같은 head/base/대상 branch이고 commit/file count 둘 다 완료된 snapshot만 재사용한다. */
export function canReuseStableConnections(node: { headRefOid?: string; baseRefOid?: string; baseRefName?: string }, known?: StablePullRequestSnapshot): boolean {
  return !!node.headRefOid && !!node.baseRefOid && known?.commitHashesComplete === true && known.fileCountComplete === true
    && Number.isSafeInteger(known.fileCount) && known.fileCount >= 0 && hasCompleteCommitSummaries(known)
    && node.headRefOid === known.headHash && node.baseRefOid === known.baseHash && node.baseRefName === known.baseRefName;
}

/** 저장소/소비자 사이의 배열·요약 객체 변경을 차단한다. */
function clone(value: StablePullRequestSnapshot): StablePullRequestSnapshot {
  return { number: value.number, headHash: value.headHash, baseHash: value.baseHash, baseRefName: value.baseRefName,
    fileCount: value.fileCount, fileCountComplete: value.fileCountComplete, commitHashesComplete: value.commitHashesComplete,
    commitHashes: [...value.commitHashes], commitSummaries: value.commitSummaries?.map(item => ({ ...item })) };
}
