// --all reflog 출력에서 UI 에 직접 보여줄 branch reflog record 를 고르는 순수 유틸.
// - HEAD reflog 와 같은 이벤트를 중복 표시하지 않고, 다른 브랜치/원격 브랜치의 이동 기록만 entry 로 승격한다.

/** branch reflog 선별에 필요한 최소 record 형태 */
export interface ReflogBranchRecordInput {
  hash: string;
  selector: string;
  shortSelector: string;
  message: string;
  dateIso?: string;
}

/**
 * `git reflog --all` 결과에서 HEAD 와 중복되지 않는 branch reflog record 를 고른다.
 * @param records     --all reflog 파싱 결과
 * @param headRecords HEAD reflog 파싱 결과
 * @param limit       UI 에 추가할 branch reflog 최대 개수
 * @returns branch/remote branch 에서 온 reflog record 목록
 */
export function visibleBranchReflogRecords<T extends ReflogBranchRecordInput>(
  records: T[],
  headRecords: ReflogBranchRecordInput[],
  limit: number
): T[] {
  const headKeys = new Set(headRecords.map(headEquivalentKey));
  const seen = new Set<string>();
  const result: T[] = [];
  for (const record of records) {
    if (!isBranchRecord(record) || headKeys.has(headEquivalentKey(record))) {
      continue;
    }
    const key = recordKey(record);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(record);
    if (result.length >= Math.max(0, Math.floor(limit))) {
      break;
    }
  }
  return result;
}

/**
 * HEAD reflog 와 같은 시각/메시지/commit 을 가리키는 branch record 인지 비교할 키를 만든다.
 * @param record reflog record
 */
function headEquivalentKey(record: ReflogBranchRecordInput): string {
  return [record.hash, record.dateIso || "", record.message].join("\t");
}

/**
 * 같은 ref reflog record 가 여러 번 표시되지 않도록 selector 까지 포함한 고유 키를 만든다.
 * @param record reflog record
 */
function recordKey(record: ReflogBranchRecordInput): string {
  return [record.selector, record.hash, record.message].join("\t");
}

/**
 * selector 가 local/remote branch reflog 를 가리키는지 확인한다.
 * @param record reflog record
 */
function isBranchRecord(record: ReflogBranchRecordInput): boolean {
  const ref = refFromSelector(record.selector);
  return Boolean(ref?.startsWith("refs/heads/") || ref?.startsWith("refs/remotes/"));
}

/**
 * `refs/heads/main@{...}` selector 에서 ref 이름만 분리한다.
 * @param selector reflog selector 문자열
 */
function refFromSelector(selector: string): string | undefined {
  const match = /^(.+)@\{.+\}$/.exec(selector);
  return match?.[1];
}
