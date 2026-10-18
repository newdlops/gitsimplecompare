// 충돌 설명 한 번을 만드는 동안만 commit 조회를 공유한다. 다음 호출에는 캐시를 넘기지 않는다.
import { runGit } from "./gitExec";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readGitCheckoutIdentity, type GitCheckoutIdentity } from "./repositoryIdentity";

interface CommitDescription { commit: string; subject?: string }

/** ref와 이미 해석한 immutable OID의 중복 조회를 한 metadata 요청 안에서 제거한다. */
export class ConflictCommitReader {
  private readonly reads = new Map<string, Promise<CommitDescription | undefined>>();
  private checkoutRead?: Promise<GitCheckoutIdentity>;

  constructor(private readonly root: string, public readonly signal?: AbortSignal) {}

  /** 이번 설명 요청의 branch/Git directory를 함께 읽는다. 다음 metadata 요청과는 공유하지 않는다. */
  checkout(): Promise<GitCheckoutIdentity> {
    return this.checkoutRead ??= readGitCheckoutIdentity(this.root, this.signal);
  }

  /**
   * rebase 안의 실제 operation marker만 확인해 없는 nested ref마다 Git을 실행하지 않는다.
   * @param ref Git directory 아래에 놓이는 고정 pseudo-ref 이름
   * @returns 존재하며 Git이 commit으로 검증한 참조. marker 부재는 undefined다.
   */
  async readPresentRef(ref: "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "REBASE_HEAD"): Promise<CommitDescription | undefined> {
    const identity = await this.checkout().catch(() => { this.signal?.throwIfAborted(); return undefined; });
    if (!identity) return this.read(ref);
    const present = await stat(join(identity.gitDir, ref)).then(() => true, () => false);
    this.signal?.throwIfAborted();
    return present ? this.read(ref) : undefined;
  }

  /**
   * ref의 commit OID와 제목을 하나의 Git 실행으로 읽고 같은 요청의 소비자와 공유한다.
   * @param ref 현재 operation의 ref 또는 상태 파일에서 읽은 commit hash
   * @returns commit 정보. 없는 ref나 commit이 아닌 객체는 undefined이며 취소는 전파한다.
   */
  read(ref: string): Promise<CommitDescription | undefined> {
    if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref)) return Promise.resolve(undefined);
    let pending = this.reads.get(ref);
    if (!pending) {
      pending = this.readCommit(ref).then(value => {
        if (value && !this.reads.has(value.commit)) this.reads.set(value.commit, Promise.resolve(value));
        return value;
      });
      this.reads.set(ref, pending);
    }
    return pending;
  }

  /** ref를 commit으로 검증하면서 제목도 함께 읽어 별도의 rev-parse를 피한다. */
  private async readCommit(ref: string): Promise<CommitDescription | undefined> {
    const output = await runGit(["show", "-s", "--format=%H%x00%s", `${ref}^{commit}`, "--"], this.root, { signal: this.signal })
      .catch(() => { this.signal?.throwIfAborted(); return ""; });
    const line = output.split(/\r?\n/).find(Boolean) || "";
    const [commit, subject] = line.split("\0");
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) ? { commit, subject: subject || undefined } : undefined;
  }
}
