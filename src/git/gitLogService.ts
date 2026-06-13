// git 로그/커밋 상세를 읽는 서비스 모듈.
// - 그래프 UI 가 필요로 하는 커밋 목록과, 노드 클릭 시 보여줄 상세 정보를 제공한다.
// - git 접근은 공유 실행기(runGit)만 사용한다(경계 분리).
import { runGit } from "./gitExec";
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import {
  Commit,
  CommitBranchInfo,
  CommitDetail,
  CommitFileChange,
  GraphRowKind,
  LocalBranchStatus,
} from "../graph/graphTypes";
import { parseBranchRefs, parseTrack } from "./gitLogRefs";
import { countUntrackedLines } from "./untrackedStats";

/** 빈 트리 오브젝트 해시(루트 커밋의 부모 대용으로 diff 비교에 사용) */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** 작업트리 전체 상태를 나타내는 그래프 전용 가상 커밋 해시 */
export const ONGOING_COMMIT_HASH = "__gsc_virtual_ongoing__";
/** index 상태를 나타내는 그래프 전용 가상 커밋 해시 */
export const STAGED_COMMIT_HASH = "__gsc_virtual_staged__";

/** 로그 필드 구분자(제어문자 Unit Separator) */
const FS = "\x1f";

/**
 * 특정 저장소의 로그/상세를 다루는 서비스(저장소 루트 1개에 대응).
 */
export class GitLogService {
  constructor(public readonly repoRoot: string) {}

  /**
   * 커밋 목록을 자식→부모 순(topo-order)으로 반환한다.
   * - refs 가 비면 모든 참조(--all)를 대상으로 한다.
   * - %D(decoration)로 브랜치/태그/HEAD 참조 이름을 함께 읽는다.
   * @param limit 가져올 최대 커밋 수(성능 보호)
   * @param refs  대상 참조 목록(비면 --all)
   */
  async getCommits(limit: number, refs: string[] = []): Promise<Commit[]> {
    return this.getCommitPage(limit, 0, refs);
  }

  /**
   * 커밋 목록을 페이지 단위로 반환한다.
   * - 큰 저장소에서 그래프를 한 번에 모두 읽지 않고, 웹뷰 스크롤에 맞춰 필요한 구간만
   *   이어 붙일 수 있도록 skip/limit 을 git log 옵션으로 직접 전달한다.
   * - refs 가 비면 모든 참조(--all)를 대상으로 한다.
   * @param limit 이번 페이지에서 가져올 최대 커밋 수
   * @param skip  이미 로드한 커밋 수(앞에서 건너뛸 개수)
   * @param refs  대상 참조 목록(비면 --all)
   */
  async getCommitPage(
    limit: number,
    skip: number,
    refs: string[] = []
  ): Promise<Commit[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) {
      return [];
    }
    const safeSkip = Math.max(0, Math.floor(skip));
    const format = ["%H", "%P", "%an", "%ae", "%aI", "%D", "%s"].join(FS);
    const refArgs = refs.length > 0 ? refs : ["--all"];
    const out = await runGit(
      [
        "log",
        "--topo-order",
        "--decorate=short",
        `--pretty=tformat:${format}`,
        "-z",
        `-n${safeLimit}`,
        ...(safeSkip > 0 ? [`--skip=${safeSkip}`] : []),
        ...refArgs,
      ],
      this.repoRoot
    );

    return out
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => this.parseCommit(entry));
  }

  /**
   * 커밋 한 개의 상세(메시지/작성자/변경 파일+증감)를 반환한다.
   * - 변경 파일은 첫 부모(루트면 빈 트리)와의 diff 로 구한다.
   * @param hash 대상 커밋 해시
   */
  async getCommitDetail(hash: string): Promise<CommitDetail> {
    if (isVirtualCommitHash(hash)) {
      return this.getVirtualCommitDetail(hash);
    }
    const headerFormat = ["%H", "%P", "%an", "%ae", "%aI", "%B"].join(FS);
    const header = await runGit(
      ["show", "-s", `--pretty=format:${headerFormat}`, hash],
      this.repoRoot
    );
    const parts = header.split(FS);
    const parents = parts[1] ? parts[1].split(" ").filter(Boolean) : [];
    const base = parents[0] ?? EMPTY_TREE;

    const [files, branches] = await Promise.all([
      this.getCommitFiles(base, hash),
      this.getBranchesPointingAt(hash),
    ]);
    return {
      hash: parts[0],
      parents,
      authorName: parts[2] ?? "",
      authorEmail: parts[3] ?? "",
      authorDateIso: parts[4] ?? "",
      message: parts.slice(5).join(FS).trimEnd(),
      branches,
      files,
    };
  }

  /**
   * 로컬 브랜치 현황을 반환한다.
   * - refs/heads 만 읽어 현재 브랜치, upstream, ahead/behind, 마지막 커밋 정보를 보여준다.
   * - upstream 이 사라진 브랜치는 gone=true 로 표시해 사용자가 정리가 필요한 브랜치를 찾게 한다.
   */
  async getLocalBranches(): Promise<LocalBranchStatus[]> {
    const format = [
      "%(HEAD)",
      "%(refname:short)",
      "%(objectname)",
      "%(upstream:short)",
      "%(upstream:track)",
      "%(committerdate:iso8601-strict)",
      "%(subject)",
    ].join(FS);
    const out = await runGit(
      ["for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/heads"],
      this.repoRoot
    );
    return out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => this.parseBranchStatus(line));
  }

  /**
   * 현재 index/working tree 상태를 그래프 맨 위에 붙일 가상 커밋으로 만든다.
   * - uncommitted 변경이 없으면 빈 배열을 반환해 실제 git log 만 렌더링하게 한다.
   * - ongoing 은 working tree 전체(HEAD 대비 staged+unstaged), staged 는 index 스냅샷을 뜻한다.
   */
  async getVirtualCommits(): Promise<Commit[]> {
    const status = await runGit(["status", "--porcelain=v1"], this.repoRoot);
    if (!status.trim()) {
      return [];
    }
    const head = await this.getHeadHash();
    const now = new Date().toISOString();
    return [
      virtualCommit("ongoing", ONGOING_COMMIT_HASH, [STAGED_COMMIT_HASH], now),
      virtualCommit("staged", STAGED_COMMIT_HASH, head ? [head] : [], now),
    ];
  }

  /**
   * 그래프의 로컬 브랜치 chip 클릭에서 선택한 브랜치로 전환한다.
   * - 호출부에서 getLocalBranches 로 검증한 로컬 브랜치 이름만 전달한다.
   * - 작업트리 충돌/미저장 변경으로 전환할 수 없으면 git 오류를 그대로 던져 UI 가 안내한다.
   * @param branchName 전환할 로컬 브랜치 이름
   */
  async checkoutLocalBranch(branchName: string): Promise<void> {
    await runGit(["switch", branchName], this.repoRoot);
  }

  /**
   * 원격 브랜치와 같은 이름의 로컬 브랜치를 만들고 checkout 한다.
   * - origin/feature 처럼 remote/name 형태의 ref 에서 name 부분을 로컬 브랜치명으로 쓴다.
   * - merge=true 면 작업트리 변경과 대상 브랜치를 3-way merge 하며 checkout 해 충돌을 노출한다.
   * @param remoteBranch checkout 할 원격 브랜치 short name
   * @param merge        로컬 변경 충돌 시 merge checkout 을 시도할지 여부
   * @returns 생성/checkout 한 로컬 브랜치명
   */
  async checkoutRemoteBranchAsLocal(
    remoteBranch: string,
    merge = false
  ): Promise<string> {
    const localName = localNameFromRemoteRef(remoteBranch);
    await runGit(
      [
        "switch",
        ...(merge ? ["--merge"] : []),
        "-c",
        localName,
        "--track",
        remoteBranch,
      ],
      this.repoRoot
    );
    return localName;
  }

  /** 특정 커밋으로 detached HEAD checkout 을 수행한다. */
  async checkoutCommitDetached(hash: string): Promise<void> {
    await runGit(["switch", "--detach", hash], this.repoRoot);
  }

  /** 지정 커밋을 시작점으로 새 로컬 브랜치를 만든다. */
  async createBranchAt(name: string, startPoint: string): Promise<void> {
    await runGit(["branch", name, startPoint], this.repoRoot);
  }

  /** 로컬 브랜치를 삭제한다. */
  async deleteLocalBranch(name: string, force = false): Promise<void> {
    await runGit(["branch", force ? "-D" : "-d", name], this.repoRoot);
  }

  /** 원격 브랜치를 원격 저장소에서 삭제한다. */
  async deleteRemoteBranch(ref: string): Promise<void> {
    const parsed = splitRemoteRef(ref);
    await runGit(["push", parsed.remote, "--delete", parsed.branch], this.repoRoot);
  }

  /** 그래프 액션에서 선택할 수 있는 브랜치 목록을 반환한다. */
  async getBranches(): Promise<{ name: string; kind: "local" | "remote" }[]> {
    const out = await runGit(
      [
        "for-each-ref",
        "--format=%(refname:short)\x1f%(refname)",
        "refs/heads",
        "refs/remotes",
      ],
      this.repoRoot
    );
    return out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        const [name, full] = line.split(FS);
        if (!name || name.endsWith("/HEAD")) {
          return [];
        }
        return [{ name, kind: full.startsWith("refs/remotes/") ? "remote" : "local" }];
      });
  }

  /** 특정 커밋에 lightweight tag 를 만든다. */
  async createTag(name: string, target: string): Promise<void> {
    await runGit(["tag", name, target], this.repoRoot);
  }

  /** 로컬 tag 를 삭제한다. */
  async deleteTag(name: string): Promise<void> {
    await runGit(["tag", "-d", name], this.repoRoot);
  }

  /** 원격 저장소에서 tag 를 삭제한다. */
  async deleteRemoteTag(remote: string, name: string): Promise<void> {
    await runGit(["push", remote, `:refs/tags/${name}`], this.repoRoot);
  }

  /** tag 목록을 이름순으로 반환한다. */
  async getTags(): Promise<string[]> {
    const out = await runGit(["tag", "--list"], this.repoRoot);
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /** 원격 저장소 목록을 반환한다. */
  async getRemotes(): Promise<string[]> {
    const out = await runGit(["remote"], this.repoRoot);
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /** 지정 tag 를 원격 저장소로 push 한다. */
  async pushTag(remote: string, name: string): Promise<void> {
    await runGit(["push", remote, `refs/tags/${name}`], this.repoRoot);
  }

  /** 전체 원격 브랜치 ref 를 fetch/prune 한다. tag 동기화는 tag 충돌을 피하기 위해 별도 액션으로 분리한다. */
  async fetchAll(): Promise<void> {
    await runGit(["fetch", "--all", "--prune"], this.repoRoot);
  }

  /** tag 목록만 원격에서 가져온다. */
  async fetchTags(): Promise<void> {
    await runGit(["fetch", "--tags"], this.repoRoot);
  }

  /** 현재 브랜치의 upstream 변경을 fast-forward 방식으로 pull 한다. */
  async pullCurrent(): Promise<void> {
    await runGit(["pull", "--ff-only"], this.repoRoot);
  }

  /** 현재 브랜치의 커밋을 upstream 으로 push 한다. */
  async pushCurrent(): Promise<void> {
    await runGit(["push"], this.repoRoot);
  }

  /** 지정 커밋을 현재 브랜치에 cherry-pick 한다. */
  async cherryPick(hash: string): Promise<void> {
    await runGit(["cherry-pick", hash], this.repoRoot);
  }

  /**
   * 현재 로컬 브랜치의 최신 unpushed commit 을 되돌린다.
   * - HEAD 가 요청 해시와 같고, 현재 브랜치가 upstream 보다 앞서 있거나 upstream 이 없는 경우만 허용한다.
   * - --soft reset 을 사용해 커밋 내용은 staged 상태로 남긴다.
   * @param hash undo 대상 HEAD 커밋 해시
   */
  async undoLastUnpushedCommit(hash: string): Promise<void> {
    const branch = (await this.getLocalBranches()).find((item) => item.current);
    if (!branch || branch.hash !== hash || !isUnpushedLocalHead(branch)) {
      throw new Error(`Commit is not an unpushed local HEAD: ${hash}`);
    }
    await runGit(["reset", "--soft", "HEAD~1"], this.repoRoot);
  }

  // ---- 내부 구현 ----

  /**
   * base..hash 사이 변경 파일 목록을 상태 + 증감 라인 수와 함께 만든다.
   * @param base 비교 기준(첫 부모 또는 빈 트리)
   * @param hash 대상 커밋
   */
  private async getCommitFiles(
    base: string,
    hash: string
  ): Promise<CommitFileChange[]> {
    return this.getFilesFromDiff(
      ["diff", "--name-status", "-M", "-z", base, hash],
      ["diff", "--numstat", "-M", base, hash]
    );
  }

  /**
   * 가상 커밋 detail 을 만든다.
   * @param hash ongoing/staged 가상 커밋 해시
   */
  private async getVirtualCommitDetail(hash: string): Promise<CommitDetail> {
    const kind: GraphRowKind =
      hash === ONGOING_COMMIT_HASH ? "ongoing" : "staged";
    const head = await this.getHeadHash();
    const base = head ? "HEAD" : EMPTY_TREE;
    let files =
      kind === "ongoing"
        ? await this.getFilesFromDiff(
            ["diff", "--name-status", "-M", "-z", base],
            ["diff", "--numstat", "-M", base]
          )
        : await this.getFilesFromDiff(
            ["diff", "--cached", "--name-status", "-M", "-z", base],
            ["diff", "--cached", "--numstat", "-M", base]
          );
    if (kind === "ongoing") {
      files = [...files, ...(await this.getUntrackedFiles(files))];
    }
    const parent = kind === "ongoing" ? STAGED_COMMIT_HASH : head;
    return {
      hash,
      parents: parent ? [parent] : [],
      authorName: kind === "ongoing" ? "Working Tree" : "Index",
      authorEmail: "",
      authorDateIso: new Date().toISOString(),
      message:
        kind === "ongoing"
          ? "Ongoing changes\n\nIncludes staged and unstaged working tree changes."
          : "Staged changes\n\nRepresents the current index snapshot.",
      branches: await this.getCurrentBranchInfo(),
      files,
      kind,
    };
  }

  /**
   * 지정 커밋을 직접 가리키는 local/remote 브랜치를 찾는다.
   * - 상세 패널 클릭마다 실행되므로 히스토리를 걷는 `--contains` 대신 `--points-at`을 써서
   *   ref 테이블만 확인한다. 오래된 커밋의 "포함 브랜치"보다 현재 ref 위치를 빠르게 보여주는 데 초점을 둔다.
   * @param hash 브랜치 ref 가 직접 가리키는지 검사할 커밋 해시
   */
  private async getBranchesPointingAt(hash: string): Promise<CommitBranchInfo[]> {
    const format = ["%(HEAD)", "%(refname:short)", "%(refname)"].join(FS);
    const out = await runGit(
      [
        "for-each-ref",
        `--points-at=${hash}`,
        `--format=${format}`,
        "refs/heads",
        "refs/remotes",
      ],
      this.repoRoot
    ).catch(() => "");
    return parseBranchRefs(out, FS);
  }

  /**
   * 가상 커밋(Working Tree/Index)에 표시할 현재 브랜치 정보를 만든다.
   * - 가상 노드는 실제 커밋이 아니므로 contains 검색 대신 현재 checkout 브랜치만 보여준다.
   */
  private async getCurrentBranchInfo(): Promise<CommitBranchInfo[]> {
    return (await this.getLocalBranches())
      .filter((branch) => branch.current)
      .map((branch) => ({
        name: branch.name,
        kind: "local" as const,
        current: true,
      }));
  }

  /**
   * name-status 와 numstat 인자 쌍을 실행해 CommitFileChange 배열로 합친다.
   * @param nameStatusArgs `git` 뒤에 붙일 name-status 인자
   * @param numstatArgs    `git` 뒤에 붙일 numstat 인자
   */
  private async getFilesFromDiff(
    nameStatusArgs: string[],
    numstatArgs: string[]
  ): Promise<CommitFileChange[]> {
    const nameStatus = await runGit(
      nameStatusArgs,
      this.repoRoot
    );
    const numstat = await runGit(
      numstatArgs,
      this.repoRoot
    );
    const counts = parseNumstat(numstat);

    return parseNameStatusZ(nameStatus).map((change) => {
      const stat = counts.get(change.path);
      return {
        status: change.status,
        path: change.path,
        oldPath: change.oldPath,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
      };
    });
  }

  /**
   * 아직 git 이 추적하지 않는 파일을 ongoing 가상 커밋 파일 목록에 추가한다.
   * @param existing 이미 diff 로 찾은 파일 목록(중복 방지용)
   */
  private async getUntrackedFiles(
    existing: CommitFileChange[]
  ): Promise<CommitFileChange[]> {
    const seen = new Set(existing.map((file) => file.path));
    const out = await runGit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      this.repoRoot
    );
    const paths = out
      .split("\0")
      .filter((path) => path.length > 0 && !seen.has(path));
    return Promise.all(
      paths.map(async (path) => ({
        status: "A" as const,
        path,
        additions: await countUntrackedLines(this.repoRoot, path),
        deletions: 0,
      }))
    );
  }

  /** 현재 HEAD 해시를 반환한다. 아직 커밋이 없으면 undefined 를 반환한다. */
  private async getHeadHash(): Promise<string | undefined> {
    try {
      return (await runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot)).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * 로그 한 항목(FS 로 구분된 문자열)을 Commit 으로 파싱한다.
   * @param entry git log 한 커밋 출력
   */
  private parseCommit(entry: string): Commit {
    const [hash, parentsStr, authorName, authorEmail, dateIso, decoration, subject] =
      entry.split(FS);
    return {
      hash,
      parents: parentsStr ? parentsStr.split(" ").filter(Boolean) : [],
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      dateIso: dateIso ?? "",
      refs: parseRefs(decoration ?? ""),
      subject: subject ?? "",
    };
  }

  /**
   * git for-each-ref 한 줄을 로컬 브랜치 상태로 변환한다.
   * @param entry FS 로 구분된 브랜치 출력
   */
  private parseBranchStatus(entry: string): LocalBranchStatus {
    const [head, name, hash, upstream, track, dateIso, subject] = entry.split(FS);
    const parsedTrack = parseTrack(track ?? "");
    return {
      name: name ?? "",
      hash: hash ?? "",
      upstream: upstream || undefined,
      ahead: parsedTrack.ahead,
      behind: parsedTrack.behind,
      gone: parsedTrack.gone,
      current: head === "*",
      dateIso: dateIso ?? "",
      subject: subject ?? "",
    };
  }
}

/**
 * %D(decoration) 문자열을 참조 이름 배열로 파싱한다.
 * - "HEAD -> main, origin/main, tag: v1" → ["HEAD", "main", "origin/main", "tag:v1"]
 * @param decoration git 의 decoration 문자열
 */
function parseRefs(decoration: string): string[] {
  if (!decoration.trim()) {
    return [];
  }
  return decoration.split(",").flatMap((raw) => {
    const part = raw.trim();
    if (part.startsWith("HEAD -> ")) {
      return ["HEAD", part.slice("HEAD -> ".length)];
    }
    if (part === "HEAD") {
      return ["HEAD"];
    }
    if (part.startsWith("tag: ")) {
      return [`tag:${part.slice("tag: ".length)}`];
    }
    return part ? [part] : [];
  });
}

/** 지정 해시가 그래프 전용 가상 커밋인지 확인한다. */
function isVirtualCommitHash(hash: string): boolean {
  return hash === ONGOING_COMMIT_HASH || hash === STAGED_COMMIT_HASH;
}

/** 작업트리/index 상태를 나타내는 가상 Commit 객체를 만든다. */
function virtualCommit(
  kind: GraphRowKind,
  hash: string,
  parents: string[],
  dateIso: string
): Commit {
  return {
    hash,
    parents,
    authorName: kind === "ongoing" ? "Working Tree" : "Index",
    authorEmail: "",
    dateIso,
    refs: [`virtual:${kind}`],
    subject: kind === "ongoing" ? "Ongoing changes" : "Staged changes",
    kind,
  };
}

/** origin/feature 형태의 원격 브랜치 ref 를 remote 이름과 브랜치 이름으로 나눈다. */
function splitRemoteRef(ref: string): { remote: string; branch: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid remote branch: ${ref}`);
  }
  return {
    remote: ref.slice(0, slash),
    branch: ref.slice(slash + 1),
  };
}

/** 원격 브랜치 short name 에서 로컬 브랜치명을 만든다. */
function localNameFromRemoteRef(ref: string): string {
  return splitRemoteRef(ref).branch;
}

/** 현재 로컬 HEAD 가 remote 에 아직 반영되지 않은 상태인지 판단한다. */
function isUnpushedLocalHead(branch: LocalBranchStatus): boolean {
  return branch.ahead > 0 || !branch.upstream || branch.gone;
}
