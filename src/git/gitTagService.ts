// git tag 목록/상태/이름 변경을 담당하는 서비스 모듈.
// - GitLogService 의 그래프/커밋 책임과 태그 관리 책임을 분리해 파일 크기와 경계를 유지한다.
// - 원격 tag 는 git 이 로컬 tracking ref 로 보관하지 않으므로 ls-remote 로 별도 조회한다.
import { runGit } from "./gitExec";

/** 로컬 tag 한 건. hash 는 annotated tag 를 peel 한 실제 대상 객체를 우선 사용한다. */
export interface GitLocalTagRef {
  name: string;
  hash: string;
}

/** 원격 저장소에서 읽은 tag 한 건. remote 는 origin 같은 git remote 이름이다. */
export interface GitRemoteTagRef {
  remote: string;
  name: string;
  hash: string;
}

/** 그래프 UI 가 로컬/원격 tag 를 구분해 표시하기 위한 통합 상태 */
export interface GitTagStatus {
  name: string;
  localHash?: string;
  remoteTargets: GitRemoteTagRef[];
}

/** 특정 저장소의 tag 상태와 tag 이름 변경을 다루는 서비스 */
export class GitTagService {
  constructor(private readonly repoRoot: string) {}

  /**
   * 로컬 tag 와 원격 tag 를 통합한 상태 목록을 반환한다.
   * - 같은 이름의 tag 가 로컬/여러 remote 에 있을 수 있으므로 이름 기준으로 묶는다.
   * - 원격 조회 실패는 해당 remote 만 건너뛰고 로컬 tag 표시는 유지한다.
   */
  async getTagStatuses(): Promise<GitTagStatus[]> {
    const [localTags, remoteTags] = await Promise.all([
      this.getLocalTagRefs(),
      this.getRemoteTagRefs(),
    ]);
    const byName = new Map<string, GitTagStatus>();
    for (const tag of localTags) {
      byName.set(tag.name, {
        name: tag.name,
        localHash: tag.hash,
        remoteTargets: [],
      });
    }
    for (const tag of remoteTags) {
      const status = byName.get(tag.name) ?? {
        name: tag.name,
        remoteTargets: [],
      };
      status.remoteTargets.push(tag);
      byName.set(tag.name, status);
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 로컬 tag 목록과 대상 해시를 반환한다.
   * - annotated tag 는 %(*objectname) 으로 peel 된 커밋/객체를 우선 사용한다.
   */
  async getLocalTagRefs(): Promise<GitLocalTagRef[]> {
    const out = await runGit(
      [
        "for-each-ref",
        "--format=%(refname:short)%00%(*objectname)%00%(objectname)",
        "refs/tags",
      ],
      this.repoRoot
    ).catch(() => "");
    return out
      .split("\n")
      .flatMap((line) => {
        const [name, peeledHash, objectHash] = line.split("\0");
        const hash = peeledHash || objectHash;
        return name && hash ? [{ name, hash }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 모든 remote 에서 tag 목록을 조회한다.
   * - private remote 인증 실패처럼 조회할 수 없는 remote 는 빈 목록으로 처리한다.
   */
  async getRemoteTagRefs(): Promise<GitRemoteTagRef[]> {
    const remotes = await this.getRemotes();
    const nested = await Promise.all(
      remotes.map((remote) => this.getRemoteTagRefsForRemote(remote).catch(() => []))
    );
    return nested.flat().sort(compareRemoteTag);
  }

  /**
   * 로컬 tag 이름을 변경한다.
   * - git 에 tag rename 명령이 없으므로 새 ref 를 같은 object 로 만든 뒤 기존 ref 를 삭제한다.
   * - update-ref 를 사용해 annotated tag object 도 그대로 보존한다.
   * @param oldName 기존 로컬 tag 이름
   * @param newName 새 로컬 tag 이름
   */
  async renameLocalTag(oldName: string, newName: string): Promise<void> {
    await this.assertValidTagName(newName);
    if (await this.hasLocalTag(newName)) {
      throw new Error(`Tag already exists: ${newName}`);
    }
    await runGit(
      ["update-ref", `refs/tags/${newName}`, `refs/tags/${oldName}`],
      this.repoRoot
    );
    await runGit(["update-ref", "-d", `refs/tags/${oldName}`], this.repoRoot);
  }

  /**
   * 지정한 이름의 로컬 tag 가 있는지 확인한다.
   * @param name 확인할 tag 이름
   */
  async hasLocalTag(name: string): Promise<boolean> {
    return runGit(
      ["show-ref", "--verify", "--quiet", `refs/tags/${name}`],
      this.repoRoot
    ).then(
      () => true,
      () => false
    );
  }

  /**
   * 한 remote 에서 tag 목록을 조회한다.
   * - annotated tag 는 refs/tags/name^{} 행이 있으면 그 peeled hash 를 우선 사용한다.
   * @param remote 조회할 git remote 이름
   */
  private async getRemoteTagRefsForRemote(remote: string): Promise<GitRemoteTagRef[]> {
    const out = await runGit(
      ["ls-remote", "--tags", remote],
      this.repoRoot,
      { env: { GIT_TERMINAL_PROMPT: "0" }, retryOnLock: false }
    );
    const byName = new Map<string, { hash: string; peeled?: string }>();
    for (const line of out.split("\n")) {
      const [hash, ref] = line.trim().split(/\s+/);
      if (!hash || !ref || !ref.startsWith("refs/tags/")) {
        continue;
      }
      const peeled = ref.endsWith("^{}");
      const name = ref.slice("refs/tags/".length, peeled ? -"^{}".length : undefined);
      const entry = byName.get(name) ?? { hash };
      if (peeled) {
        entry.peeled = hash;
      } else {
        entry.hash = hash;
      }
      byName.set(name, entry);
    }
    return Array.from(byName.entries()).map(([name, target]) => ({
      remote,
      name,
      hash: target.peeled || target.hash,
    }));
  }

  /** 저장소에 등록된 remote 이름 목록을 반환한다. */
  private async getRemotes(): Promise<string[]> {
    const out = await runGit(["remote"], this.repoRoot).catch(() => "");
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /**
   * 새 tag 이름이 git refname 규칙을 만족하는지 확인한다.
   * @param name 검사할 tag 이름
   */
  private async assertValidTagName(name: string): Promise<void> {
    await runGit(["check-ref-format", `refs/tags/${name}`], this.repoRoot);
  }
}

/** remote/name 순서로 tag 를 안정적으로 정렬한다. */
function compareRemoteTag(a: GitRemoteTagRef, b: GitRemoteTagRef): number {
  return a.remote === b.remote
    ? a.name.localeCompare(b.name)
    : a.remote.localeCompare(b.remote);
}
