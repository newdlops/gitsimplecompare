// git graph 의 전체 저장소 검색을 담당하는 서비스.
// - 별도 인덱스를 만들지 않고 현재 로컬 git DB 를 직접 읽어 stale 관리 비용을 줄인다.
// - ref/hash 검색은 가볍게 처리하고, commit message 검색만 max-count 로 제한한다.
import { LOG_FIELD_SEPARATOR } from "./gitLogParse";
import { runGit } from "./gitExec";
import { GitRemoteTagRef, GitTagService } from "./gitTagService";

/** repository-wide graph 검색 결과 종류 */
export type GraphRepositorySearchKind = "commit" | "branch" | "tag" | "hash";

/** repository-wide graph 검색 대상 범위 */
export type GraphRepositorySearchScope = "all" | "commit" | "branch" | "tag";

/** repository-wide graph 검색 옵션 */
export interface GraphRepositorySearchOptions {
  /** commit/hash/branch/tag 중 어떤 종류를 검색할지 지정한다. */
  scope?: GraphRepositorySearchScope;
}

/** 웹뷰 검색 목록에 표시할 repository-wide 결과 한 건 */
export interface GraphRepositorySearchMatch {
  kind: GraphRepositorySearchKind;
  hash: string;
  shortHash: string;
  label: string;
  meta: string;
  refName?: string;
  tagOrigin?: "local" | "remote";
  remote?: string;
  subject?: string;
  authorName?: string;
  dateIso?: string;
}

/** repository-wide graph 검색 응답 */
export interface GraphRepositorySearchResult {
  query: string;
  scope: GraphRepositorySearchScope;
  matches: GraphRepositorySearchMatch[];
  skippedCommitSearch: boolean;
  elapsedMs: number;
}

const MAX_REF_MATCHES = 40;
const MAX_HASH_MATCHES = 20;
const MAX_COMMIT_MATCHES = 50;
const MAX_TOTAL_MATCHES = 80;
const MIN_COMMIT_SEARCH_CHARS = 3;
const SEARCH_FORMAT = ["%H", "%h", "%s", "%an", "%aI"].join(LOG_FIELD_SEPARATOR);

/**
 * graph 검색 입력을 현재 로컬 저장소 전체에서 찾는다.
 * - branch/tag 는 ref 목록만 훑으므로 커밋 수와 무관하게 빠르다.
 * - hash prefix 는 object prefix disambiguation 으로만 찾는다.
 * - commit message 검색은 짧은 검색어를 건너뛰고 결과 수도 제한한다.
 */
export class GraphSearchService {
  constructor(private readonly repoRoot: string) {}

  /**
   * 검색어에 맞는 repository-wide 결과를 반환한다.
   * @param query 사용자가 graph 검색창에 입력한 원문
   * @param options 검색 대상 범위. all 이면 commit/hash/branch/tag 를 모두 검색한다.
   * @returns ref/hash/commit message 검색 결과 묶음
   */
  async search(
    query: string,
    options: GraphRepositorySearchOptions = {}
  ): Promise<GraphRepositorySearchResult> {
    const started = Date.now();
    const scope = normalizeScope(options.scope);
    const terms = searchTerms(query);
    if (!terms.length) {
      return {
        query,
        scope,
        matches: [],
        skippedCommitSearch: scopeAllows(scope, "commit"),
        elapsedMs: 0,
      };
    }
    const commitSearch = scopeAllows(scope, "commit") && shouldSearchCommits(query, terms);
    const [refs, hashes, commits] = await Promise.all([
      scopeAllows(scope, "branch") || scopeAllows(scope, "tag")
        ? this.searchRefs(terms, scope)
        : Promise.resolve([]),
      scopeAllows(scope, "hash") ? this.searchHashPrefix(query) : Promise.resolve([]),
      commitSearch ? this.searchCommits(terms) : Promise.resolve([]),
    ]);
    return {
      query,
      scope,
      matches: uniqueMatches([...refs, ...hashes, ...commits]).slice(0, MAX_TOTAL_MATCHES),
      skippedCommitSearch: scopeAllows(scope, "commit") && !commitSearch,
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * 전체 로컬/원격 branch 와 tag 이름을 검색한다.
   * @param terms 정규화된 검색 단어 목록
   * @param scope branch/tag 중 어떤 ref 종류를 허용할지 지정한다.
   * @returns 이름이 부분일치하는 ref 결과
   */
  private async searchRefs(
    terms: string[],
    scope: GraphRepositorySearchScope
  ): Promise<GraphRepositorySearchMatch[]> {
    const format = "%(refname:short)%00%(*objectname)%00%(objectname)%00%(objecttype)%00%(refname)";
    const [localRefs, remoteTags] = await Promise.all([
      runGit([
        "for-each-ref",
        `--format=${format}`,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ], this.repoRoot).catch(() => ""),
      scopeAllows(scope, "tag")
        ? new GitTagService(this.repoRoot).getRemoteTagRefs()
        : Promise.resolve([]),
    ]);
    return localRefs
      .split("\n")
      .map(parseRefLine)
      .concat(remoteTags.map(remoteTagMatch))
      .filter((match): match is GraphRepositorySearchMatch => Boolean(match))
      .filter((match) => scopeAllows(scope, match.kind))
      .filter((match) => matchesTerms(searchableRefText(match), terms))
      .slice(0, MAX_REF_MATCHES);
  }

  /**
   * hexadecimal prefix 로 보이는 입력을 object hash prefix 로 검색한다.
   * @param query 사용자가 입력한 원문
   * @returns commit 객체로 확인된 hash 후보
   */
  private async searchHashPrefix(query: string): Promise<GraphRepositorySearchMatch[]> {
    const prefix = query.trim();
    if (!/^[0-9a-f]{4,40}$/i.test(prefix)) {
      return [];
    }
    const out = await runGit(["rev-parse", `--disambiguate=${prefix}`], this.repoRoot).catch(() => "");
    const hashes = out.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, MAX_HASH_MATCHES);
    const commits = await this.commitSummaries(await this.commitObjectHashes(hashes));
    return commits.map((commit) => ({ ...commit, kind: "hash" as const }));
  }

  /**
   * commit subject/body 를 제한된 개수만 검색한다.
   * @param terms 정규화된 검색 단어 목록
   * @returns 검색어가 commit message 에 포함된 commit 후보
   */
  private async searchCommits(terms: string[]): Promise<GraphRepositorySearchMatch[]> {
    const grepArgs = terms.flatMap((term) => [`--grep=${term}`]);
    const out = await runGit([
      "log",
      "--branches",
      "--remotes",
      "--tags",
      "--regexp-ignore-case",
      "--fixed-strings",
      "--all-match",
      ...grepArgs,
      `--max-count=${MAX_COMMIT_MATCHES}`,
      `--format=${SEARCH_FORMAT}`,
    ], this.repoRoot).catch(() => "");
    return parseCommitLines(out).map((commit) => ({ ...commit, kind: "commit" as const }));
  }

  /**
   * hash 후보의 commit 요약을 한 번에 읽는다.
   * @param hashes commit 인지 확인할 object hash 후보
   * @returns commit 으로 해석되는 후보의 표시용 요약
   */
  private async commitSummaries(hashes: string[]): Promise<Omit<GraphRepositorySearchMatch, "kind">[]> {
    if (!hashes.length) {
      return [];
    }
    const out = await runGit([
      "show",
      "-s",
      `--format=${SEARCH_FORMAT}`,
      ...hashes,
    ], this.repoRoot).catch(() => "");
    return parseCommitLines(out);
  }

  /**
   * object hash 후보 중 commit 객체만 남긴다.
   * @param hashes rev-parse disambiguation 으로 찾은 object 후보
   * @returns commit 으로 확인된 object hash 목록
   */
  private async commitObjectHashes(hashes: string[]): Promise<string[]> {
    const checked = await Promise.all(hashes.map(async (hash) => {
      const type = (await runGit(["cat-file", "-t", hash], this.repoRoot).catch(() => "")).trim();
      return type === "commit" ? hash : "";
    }));
    return checked.filter(Boolean);
  }
}

/** for-each-ref 출력 한 줄을 검색 결과로 변환한다. */
function parseRefLine(line: string): GraphRepositorySearchMatch | undefined {
  const [shortName, peeledHash, objectHash, objectType, fullName] = line.split("\0");
  const hash = peeledHash || objectHash;
  if (!shortName || !hash || shortName.endsWith("/HEAD") || fullName?.endsWith("/HEAD")) {
    return undefined;
  }
  const kind: GraphRepositorySearchKind = fullName?.startsWith("refs/tags/") ? "tag" : "branch";
  return {
    kind,
    hash,
    shortHash: hash.slice(0, 7),
    label: shortName,
    meta: kind === "tag" ? "local tag" : (objectType === "commit" ? "branch" : objectType || "ref"),
    refName: fullName,
    tagOrigin: kind === "tag" ? "local" : undefined,
  };
}

/** 원격 tag 레코드를 검색 결과로 변환한다. */
function remoteTagMatch(tag: GitRemoteTagRef): GraphRepositorySearchMatch {
  return {
    kind: "tag",
    hash: tag.hash,
    shortHash: tag.hash.slice(0, 7),
    label: `${tag.remote}/${tag.name}`,
    meta: `remote tag | ${tag.remote}`,
    refName: `refs/remotes/${tag.remote}/tags/${tag.name}`,
    tagOrigin: "remote",
    remote: tag.remote,
  };
}

/** ref 검색에서 사용할 통합 검색 문자열을 만든다. */
function searchableRefText(match: GraphRepositorySearchMatch): string {
  return [
    match.label,
    match.refName,
    match.kind,
    match.tagOrigin,
    match.remote,
  ].filter(Boolean).join(" ");
}

/** git log/show 출력 여러 줄을 commit 검색 결과로 변환한다. */
function parseCommitLines(out: string): Omit<GraphRepositorySearchMatch, "kind">[] {
  return out.split("\n").map((line) => {
    const [hash, shortHash, subject, authorName, dateIso] = line.split(LOG_FIELD_SEPARATOR);
    if (!hash) {
      return undefined;
    }
    const match: Omit<GraphRepositorySearchMatch, "kind"> = {
      hash,
      shortHash: shortHash || hash.slice(0, 7),
      label: subject || hash.slice(0, 12),
      meta: [shortHash || hash.slice(0, 7), authorName, shortDate(dateIso)].filter(Boolean).join(" | "),
      subject,
      authorName,
      dateIso,
    };
    return match;
  }).filter((match): match is Omit<GraphRepositorySearchMatch, "kind"> => Boolean(match));
}

/** 검색어를 대소문자/공백 차이 없는 단어 목록으로 바꾼다. */
function searchTerms(query: string): string[] {
  return query.toLowerCase().replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}

/** 외부에서 받은 검색 범위 값을 지원 범위로 정규화한다. */
function normalizeScope(scope: GraphRepositorySearchScope | undefined): GraphRepositorySearchScope {
  return scope === "commit" || scope === "branch" || scope === "tag" ? scope : "all";
}

/** 검색 범위가 특정 결과 종류를 포함하는지 확인한다. */
function scopeAllows(
  scope: GraphRepositorySearchScope,
  kind: GraphRepositorySearchKind
): boolean {
  return scope === "all" || scope === kind || (scope === "commit" && kind === "hash");
}

/** commit message 검색을 실행할 만큼 검색어가 구체적인지 판단한다. */
function shouldSearchCommits(query: string, terms: string[]): boolean {
  const compact = terms.join("");
  return compact.length >= MIN_COMMIT_SEARCH_CHARS && !/^[0-9a-f]{4,40}$/i.test(query.trim());
}

/** 모든 검색 단어가 대상 문자열에 부분일치하는지 확인한다. */
function matchesTerms(value: string, terms: string[]): boolean {
  const haystack = value.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** 같은 종류/대상 결과가 여러 경로에서 나왔을 때 첫 항목만 유지한다. */
function uniqueMatches(matches: GraphRepositorySearchMatch[]): GraphRepositorySearchMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.kind}:${match.refName || match.hash}:${match.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** 검색 결과 메타에 들어갈 날짜를 짧게 만든다. */
function shortDate(value: string | undefined): string {
  return value ? value.slice(0, 10) : "";
}
