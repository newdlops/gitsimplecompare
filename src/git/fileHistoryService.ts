// 열린 파일 기준 커밋 히스토리를 조회하는 git 서비스.
// - UI/명령 레이어와 분리해 저장소 루트 + 상대 경로만으로 재사용할 수 있게 한다.
// - rename 된 파일도 `git log --follow` 와 커밋별 rename 메타데이터를 조합해 이전 경로를 따라간다.
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import type { FileChangeStatus } from "./gitTypes";
import { runGit } from "./gitExec";

/** root commit 의 부모처럼 사용할 Git empty tree 객체 해시. */
export const EMPTY_TREE_REF = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** 파일 히스토리 한 커밋이 웹뷰/명령 레이어에 제공하는 정보. */
export interface FileHistoryEntry {
  /** 전체 커밋 해시 */
  hash: string;
  /** 짧은 커밋 해시 */
  shortHash: string;
  /** diff 왼쪽 기준 ref. 일반 커밋은 첫 부모, root commit 은 empty tree 이다. */
  baseRef: string;
  /** 커밋 제목 */
  title: string;
  /** 커밋 전체 메시지(subject + body) */
  message: string;
  /** 작성자 이름 */
  author: string;
  /** ISO strict 형식 작성 시각 */
  dateIso: string;
  /** Git 이 계산한 상대 시각 */
  relativeDate: string;
  /** 해당 커밋에서의 파일 상태 */
  status: FileChangeStatus;
  /** 해당 커밋 오른쪽(커밋 시점) 파일 경로 */
  path: string;
  /** rename/copy 의 왼쪽(부모 시점) 파일 경로 */
  oldPath?: string;
  /** 추가 라인 수 */
  additions?: number;
  /** 삭제 라인 수 */
  deletions?: number;
}

interface LogCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  dateIso: string;
  relativeDate: string;
  title: string;
  message: string;
}

interface CommitFileChange {
  status: FileChangeStatus;
  path: string;
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

/**
 * 저장소 루트 하나에 묶인 파일 히스토리 조회 서비스.
 */
export class FileHistoryService {
  constructor(private readonly repoRoot: string) {}

  /**
   * 특정 파일의 관련 커밋을 최신순으로 조회한다.
   * - `git log --follow` 로 rename 이전 커밋을 포함한다.
   * - 각 커밋의 diff 메타데이터를 읽어 클릭 시 열 diff 의 base/head/path 를 함께 제공한다.
   * @param relPath 저장소 루트 기준 상대 경로
   * @param limit   최대 커밋 수. 너무 오래된 파일에서 UI refresh 가 무거워지지 않게 제한한다.
   */
  async listFileHistory(
    relPath: string,
    limit = 60
  ): Promise<FileHistoryEntry[]> {
    const normalizedPath = normalizeGitPath(relPath);
    if (!normalizedPath) {
      return [];
    }
    const commits = await this.readFollowLog(normalizedPath, limit);
    const history: FileHistoryEntry[] = [];
    let pathAtCommit = normalizedPath;
    for (const commit of commits) {
      const baseRef = commit.parents[0] || EMPTY_TREE_REF;
      const change = await this.readCommitFileChange(
        baseRef,
        commit.hash,
        pathAtCommit
      );
      const item = change ?? {
        status: "M" as FileChangeStatus,
        path: pathAtCommit,
      };
      history.push({
        hash: commit.hash,
        shortHash: commit.shortHash,
        baseRef,
        title: commit.title,
        message: commit.message,
        author: commit.author,
        dateIso: commit.dateIso,
        relativeDate: commit.relativeDate,
        status: item.status,
        path: item.path,
        oldPath: item.oldPath,
        additions: item.additions,
        deletions: item.deletions,
      });
      if (item.status === "R" && item.oldPath) {
        pathAtCommit = item.oldPath;
      }
    }
    return history;
  }

  /**
   * 파일 경로를 따라가는 git log 를 읽어 커밋 메타데이터를 파싱한다.
   * @param relPath 저장소 상대 경로
   * @param limit   최대 커밋 수
   */
  private async readFollowLog(
    relPath: string,
    limit: number
  ): Promise<LogCommit[]> {
    const raw = await runGit(
      [
        "log",
        "--follow",
        `--max-count=${Math.max(1, limit)}`,
        "--date=relative",
        "--format=%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%ar%x1f%s%x1f%B%x1e",
        "--",
        relPath,
      ],
      this.repoRoot
    );
    return raw
      .split("\x1e")
      .map(parseLogRecord)
      .filter((entry): entry is LogCommit => !!entry);
  }

  /**
   * 한 커밋에서 해당 파일이 어떻게 변했는지 읽는다.
   * - first-parent diff 를 사용해 merge commit 도 "이 커밋이 기존 라인에 만든 변화"로 표시한다.
   * - rename 이면 new path 를 오른쪽 경로로, old path 를 왼쪽 경로로 유지한다.
   * @param baseRef 기준 ref(부모 또는 empty tree)
   * @param headRef 대상 커밋
   * @param relPath 현재 log walk 가 바라보는 파일 경로
   */
  private async readCommitFileChange(
    baseRef: string,
    headRef: string,
    relPath: string
  ): Promise<CommitFileChange | undefined> {
    const [nameStatus, numstat] = await Promise.all([
      runGit(
        ["diff", "--name-status", "-z", "-M", baseRef, headRef, "--", relPath],
        this.repoRoot
      ).catch(() => ""),
      runGit(
        ["diff", "--numstat", "-z", "-M", baseRef, headRef, "--", relPath],
        this.repoRoot
      ).catch(() => ""),
    ]);
    const changes = parseNameStatusZ(nameStatus);
    const preferred =
      changes.find(
        (change) => change.path === relPath || change.oldPath === relPath
      ) ?? changes[0];
    const rename = preferred?.status === "A"
      ? await this.findRenameInWholeCommit(baseRef, headRef, relPath)
      : undefined;
    const selected = rename ?? preferred;
    if (!selected) {
      return undefined;
    }
    const counts = rename?.counts ?? parseNumstat(numstat);
    const stat = counts.get(selected.path);
    return {
      status: selected.status,
      path: selected.path,
      oldPath: selected.oldPath,
      additions: stat?.additions,
      deletions: stat?.deletions,
    };
  }

  /**
   * pathspec 으로 보면 rename 이 add 로 축약되는 경우가 있어 전체 커밋 diff 에서 rename 을 재확인한다.
   * - 새 경로가 현재 파일 경로와 같은 rename 만 선택해 실제 신규 파일 추가와 구분한다.
   * @param baseRef 기준 ref
   * @param headRef 대상 커밋
   * @param relPath 현재 파일 경로
   */
  private async findRenameInWholeCommit(
    baseRef: string,
    headRef: string,
    relPath: string
  ): Promise<
    | {
        status: FileChangeStatus;
        path: string;
        oldPath?: string;
        counts: Map<string, { additions: number; deletions: number }>;
      }
    | undefined
  > {
    if (baseRef === EMPTY_TREE_REF) {
      return undefined;
    }
    const nameStatus = await runGit(
      ["diff", "--name-status", "-z", "-M", "--diff-filter=R", baseRef, headRef],
      this.repoRoot
    ).catch(() => "");
    const rename = parseNameStatusZ(nameStatus).find(
      (change) => change.status === "R" && change.path === relPath
    );
    if (!rename) {
      return undefined;
    }
    const numstat = await runGit(
      ["diff", "--numstat", "-z", "-M", "--diff-filter=R", baseRef, headRef],
      this.repoRoot
    ).catch(() => "");
    return { ...rename, counts: parseNumstat(numstat) };
  }
}

/**
 * git pathspec 으로 넘길 상대 경로를 POSIX 구분자로 정규화한다.
 * @param relPath 저장소 상대 경로
 */
function normalizeGitPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * 커스텀 구분자 기반 git log 레코드를 LogCommit 으로 변환한다.
 * @param record `readFollowLog` 가 받은 한 커밋 레코드
 */
function parseLogRecord(record: string): LogCommit | undefined {
  const text = record.replace(/^\n+/, "").replace(/\n+$/, "");
  if (!text.trim()) {
    return undefined;
  }
  const parts = text.split("\x1f");
  if (parts.length < 8 || !parts[0]) {
    return undefined;
  }
  const [
    hash,
    shortHash,
    parentText,
    author,
    dateIso,
    relativeDate,
    title,
    ...message
  ] = parts;
  return {
    hash,
    shortHash,
    parents: parentText ? parentText.split(" ").filter(Boolean) : [],
    author,
    dateIso,
    relativeDate,
    title,
    message: message.join("\x1f").trimEnd() || title,
  };
}
