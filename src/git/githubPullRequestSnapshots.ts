// PR의 불변 raw 파일만 저장한다. 댓글이 합쳐진 DTO는 저장하지 않아 새 리뷰 상태를 가리지 않는다.
import { GitHubCommitSnapshots } from "./githubCommitSnapshots";
export interface RawPullRequestFile { path: string; additions: number; deletions: number; changeType: string; }
export interface GitHubSnapshotIdentity { host: string; repository: string; credentialKey: string; }
interface FileEntry { repository: string; number: number; credentialKey: string; files: RawPullRequestFile[]; bytes: number; comparable: boolean; }
interface Limits { maxEntries?: number; maxBytes?: number; maxEntryBytes?: number; }

/** 활성화별 bounded immutable snapshot 저장소. 각 반환값은 새 객체여서 소비자 변경을 격리한다. */
export class GitHubPullRequestSnapshots {
  readonly commits = new GitHubCommitSnapshots();
  private readonly files = new Map<string, FileEntry>();
  private bytes = 0;
  constructor(private readonly limits: Limits = {}) {}

  /** 인증을 결정하지 않는 query-shape 힌트다. 실제 body 재사용은 성공한 앵커와 인증 key를 다시 요구한다. */
  hasFiles(repository: string, number: number, comparisonOnly = false): boolean {
    return [...this.files.values()].some(entry => entry.repository === repository.toLowerCase() && entry.number === number && (!comparisonOnly || entry.comparable));
  }

  /** 현재 인증의 성공한 head/base·파일 합계와 정확히 일치하는 완전한 raw 파일만 복사한다. */
  getFiles(identity: GitHubSnapshotIdentity, number: number, head: string, base: string, total: number): RawPullRequestFile[] | undefined {
    const key = this.key(identity, number, head, base), entry = this.files.get(key);
    if (!entry || entry.files.length !== total) return undefined;
    this.files.delete(key); this.files.set(key, entry);
    return entry.files.map(file => ({ ...file }));
  }

  /** 호출자가 모든 페이지/문맥/취소를 검증한 성공에만 등록한다. 상한 초과·중복 raw 파일은 저장하지 않는다. */
  putFiles(identity: GitHubSnapshotIdentity, number: number, head: string, base: string, files: readonly RawPullRequestFile[]): void {
    const key = this.key(identity, number, head, base);
    const bytes = Buffer.byteLength(JSON.stringify(files));
    if (bytes > (this.limits.maxEntryBytes ?? 4 * 1024 * 1024) || new Set(files.map(file => file.path)).size !== files.length) return;
    this.remove(key);
    this.files.set(key, { repository: identity.repository.toLowerCase(), number, credentialKey: identity.credentialKey,
      files: files.map(file => ({ ...file })), bytes, comparable: canReuseComparisonFiles(files) });
    this.bytes += bytes;
    while (this.files.size > (this.limits.maxEntries ?? 128) || this.bytes > (this.limits.maxBytes ?? 16 * 1024 * 1024)) {
      this.remove(this.files.keys().next().value!);
    }
  }

  /** 401로 무효화된 인증의 완전한 snapshot도 즉시 제거한다. */
  invalidateCredential(credentialKey: string): void {
    this.commits.invalidateCredential(credentialKey);
    for (const [key, value] of this.files) if (value.credentialKey === credentialKey) this.remove(key);
  }

  /** 소유 활성화만 정리하므로 이전 disposer가 새 활성화의 저장소를 지우지 못한다. */
  clear(): void { this.files.clear(); this.bytes = 0; this.commits.clear(); }
  /** API·정규화 버전, canonical host/repository, PR 앵커와 실제 인증을 한 cache key에 넣는다. */
  private key(identity: GitHubSnapshotIdentity, number: number, head: string, base: string): string {
    return JSON.stringify(["raw-files-v1", identity.host, identity.repository.toLowerCase(), number, head, base, identity.credentialKey]);
  }
  /** 항목 제거와 byte 계산을 묶어 덮어쓰기/정리 후에도 메모리 상한을 지킨다. */
  private remove(key: string): void { const entry = this.files.get(key); if (entry) { this.bytes -= entry.bytes; this.files.delete(key); } }
}

/** oldPath가 필요 없고 REST 정규화와 동등한 완전한 파일 배열만 비교용 힌트로 허용한다. */
export function canReuseComparisonFiles(files: readonly RawPullRequestFile[]): boolean {
  return files.length < 3000 && files.every(file => typeof file.path === "string" && file.path.length > 0
    && ["ADDED", "DELETED", "MODIFIED"].includes(file.changeType)
    && Number.isSafeInteger(file.additions) && file.additions >= 0 && Number.isSafeInteger(file.deletions) && file.deletions >= 0);
}
