// reflog 항목 사이의 ref 이동을 해석해 commit 이 어느 시점에 흐름 밖으로 밀렸는지 추정한다.
// - git object 에는 dangling 이 된 시간이 없으므로, branch reflog 의 "old tip -> new tip" 이동 기록을 근거로 삼는다.

/** drop 근거 계산에 필요한 최소 reflog record */
export interface ReflogDropRecord {
  hash: string;
  selector: string;
  shortSelector: string;
  message: string;
  dateIso?: string;
}

/** drop 근거 계산에 필요한 최소 commit parent 정보 */
export interface ReflogDropCommitRecord {
  hash: string;
  parentHashes: string[];
}

/** commit 이 현재 ref 흐름 밖으로 빠진 시점을 추정하는 근거 */
export interface ReflogDropSource {
  ref: string;
  name: string;
  selector: string;
  message: string;
  dateIso?: string;
  kind: "local" | "remote";
  fromHash: string;
  toHash: string;
  viaHash?: string;
}

/**
 * branch reflog 연속 항목을 비교해 어떤 commit tip 에서 branch 가 이동했는지 계산한다.
 * @param records `git reflog --all` 을 파싱한 최신순 record 목록
 */
export function directDropSourcesByHash(
  records: ReflogDropRecord[]
): Map<string, ReflogDropSource[]> {
  const groups = recordsByRef(records);
  const result = new Map<string, ReflogDropSource[]>();
  for (const recordsForRef of groups.values()) {
    const sorted = recordsForRef
      .slice()
      .sort((a, b) => recordTime(b) - recordTime(a));
    for (let index = 1; index < sorted.length; index += 1) {
      const oldRecord = sorted[index];
      const newRecord = sorted[index - 1];
      if (!oldRecord || !newRecord || oldRecord.hash === newRecord.hash) {
        continue;
      }
      const source = dropSourceFromMove(oldRecord, newRecord);
      if (source) {
        pushUniqueSource(result, oldRecord.hash, source);
      }
    }
  }
  return result;
}

/**
 * drop 된 tip 아래의 dangling parent chain 에도 같은 branch 이동 근거를 전파한다.
 * @param commits       fsck 로 찾은 unreachable commit 목록
 * @param directSources 직접 branch tip 이었던 commit 별 drop 근거
 */
export function inheritedDropSourcesByHash(
  commits: ReflogDropCommitRecord[],
  directSources: Map<string, ReflogDropSource[]>
): Map<string, ReflogDropSource[]> {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const result = new Map<string, ReflogDropSource[]>();
  for (const [hash, sources] of directSources) {
    sources.forEach((source) => pushUniqueSource(result, hash, source));
  }
  for (const commit of commits) {
    const sources = directSources.get(commit.hash) || [];
    for (const source of sources) {
      propagateToParents(commit.hash, commit.parentHashes, source, byHash, result, new Set([commit.hash]));
    }
  }
  return result;
}

/**
 * ref 이름별로 reflog record 를 묶는다.
 * @param records 최신순 reflog record 목록
 */
function recordsByRef(records: ReflogDropRecord[]): Map<string, ReflogDropRecord[]> {
  const groups = new Map<string, ReflogDropRecord[]>();
  for (const record of records) {
    const ref = refFromSelector(record.selector);
    if (!ref || (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/remotes/"))) {
      continue;
    }
    const list = groups.get(ref) || [];
    list.push(record);
    groups.set(ref, list);
  }
  return groups;
}

/**
 * oldRecord 에서 newRecord 로 branch tip 이 바뀐 근거를 UI 용 drop source 로 만든다.
 * @param oldRecord branch 가 이전에 가리키던 reflog 항목
 * @param newRecord branch 이동 이후 reflog 항목
 */
function dropSourceFromMove(
  oldRecord: ReflogDropRecord,
  newRecord: ReflogDropRecord
): ReflogDropSource | undefined {
  const ref = refFromSelector(oldRecord.selector);
  if (!ref) {
    return undefined;
  }
  const kind = ref.startsWith("refs/remotes/") ? "remote" : "local";
  const prefix = kind === "remote" ? "refs/remotes/" : "refs/heads/";
  return {
    ref,
    name: ref.slice(prefix.length),
    selector: newRecord.shortSelector || newRecord.selector,
    message: newRecord.message,
    dateIso: newRecord.dateIso,
    kind,
    fromHash: oldRecord.hash,
    toHash: newRecord.hash,
  };
}

/**
 * 같은 dangling chain 의 parent commit 에 drop 근거를 전파한다.
 * @param originHash    branch 가 직접 잃어버린 tip hash
 * @param parentHashes  현재 commit 의 parent hash 목록
 * @param source        전파할 drop 근거
 * @param byHash        unreachable commit lookup
 * @param result        hash 별 누적 drop 근거
 * @param seen          순환 방지용 방문 집합
 */
function propagateToParents(
  originHash: string,
  parentHashes: string[],
  source: ReflogDropSource,
  byHash: Map<string, ReflogDropCommitRecord>,
  result: Map<string, ReflogDropSource[]>,
  seen: Set<string>
): void {
  for (const parentHash of parentHashes) {
    if (seen.has(parentHash)) {
      continue;
    }
    const parent = byHash.get(parentHash);
    if (!parent) {
      continue;
    }
    seen.add(parentHash);
    pushUniqueSource(result, parentHash, { ...source, viaHash: originHash });
    propagateToParents(originHash, parent.parentHashes, source, byHash, result, seen);
  }
}

/**
 * 같은 ref 이동 근거가 중복 표시되지 않도록 한 번만 추가한다.
 * @param result hash 별 drop source map
 * @param hash   drop 근거를 붙일 commit hash
 * @param source 추가할 drop source
 */
function pushUniqueSource(
  result: Map<string, ReflogDropSource[]>,
  hash: string,
  source: ReflogDropSource
): void {
  const list = result.get(hash) || [];
  const key = sourceKey(source);
  if (!list.some((item) => sourceKey(item) === key)) {
    result.set(hash, [...list, source].slice(0, 8));
  }
}

/** drop source 중복 판별 키를 만든다. */
function sourceKey(source: ReflogDropSource): string {
  return [
    source.ref,
    source.fromHash,
    source.toHash,
    source.dateIso || "",
    source.viaHash || "",
  ].join("\t");
}

/** selector 에서 `refs/heads/main` 같은 ref 이름만 추출한다. */
function refFromSelector(selector: string): string | undefined {
  const match = /^(.+)@\{.+\}$/.exec(selector);
  return match?.[1];
}

/** reflog record 날짜를 비교 가능한 timestamp 로 변환한다. */
function recordTime(record: ReflogDropRecord): number {
  const value = record.dateIso ? Date.parse(record.dateIso) : 0;
  return Number.isFinite(value) ? value : 0;
}
