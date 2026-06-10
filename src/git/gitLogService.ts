// git 로그/커밋 상세를 읽는 서비스 모듈.
// - 그래프 UI 가 필요로 하는 커밋 목록과, 노드 클릭 시 보여줄 상세 정보를 제공한다.
// - git 접근은 공유 실행기(runGit)만 사용한다(경계 분리).
import { runGit } from "./gitExec";
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import { Commit, CommitDetail, CommitFileChange } from "../graph/graphTypes";

/** 빈 트리 오브젝트 해시(루트 커밋의 부모 대용으로 diff 비교에 사용) */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
    const format = ["%H", "%P", "%an", "%ae", "%aI", "%D", "%s"].join(FS);
    const refArgs = refs.length > 0 ? refs : ["--all"];
    const out = await runGit(
      [
        "log",
        "--topo-order",
        "--decorate=short",
        `--pretty=tformat:${format}`,
        "-z",
        `-n${limit}`,
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
    const headerFormat = ["%H", "%P", "%an", "%ae", "%aI", "%B"].join(FS);
    const header = await runGit(
      ["show", "-s", `--pretty=format:${headerFormat}`, hash],
      this.repoRoot
    );
    const parts = header.split(FS);
    const parents = parts[1] ? parts[1].split(" ").filter(Boolean) : [];
    const base = parents[0] ?? EMPTY_TREE;

    const files = await this.getCommitFiles(base, hash);
    return {
      hash: parts[0],
      parents,
      authorName: parts[2] ?? "",
      authorEmail: parts[3] ?? "",
      authorDateIso: parts[4] ?? "",
      message: parts.slice(5).join(FS).trimEnd(),
      files,
    };
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
    const nameStatus = await runGit(
      ["diff", "--name-status", "-M", "-z", base, hash],
      this.repoRoot
    );
    const numstat = await runGit(
      ["diff", "--numstat", "-M", base, hash],
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
}

/**
 * %D(decoration) 문자열을 참조 이름 배열로 파싱한다.
 * - "HEAD -> main, origin/main, tag: v1" → ["HEAD", "main", "origin/main", "v1"]
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
      return [part.slice("tag: ".length)];
    }
    return part ? [part] : [];
  });
}
