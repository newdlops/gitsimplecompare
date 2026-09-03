// VS Code 캐시 서비스의 제한된 파일 시스템 연산 구현.
// - 서비스가 넘긴 고정 정의만 읽고, 캐시 루트 자체나 심볼릭 링크 대상은 삭제하지 않는다.
// - 크기 탐색과 삭제 후 재검사 로직을 한곳에 두어 플랫폼별 파일 경합을 같은 방식으로 처리한다.
import { lstat, opendir, readdir, rm } from "node:fs/promises";
import * as path from "node:path";
import type {
  CacheCancellationProbe,
  VscodeCacheGroupDefinition,
  VscodeCacheGroupId,
  VscodeCacheGroupSnapshot,
  VscodeCacheInspection,
  VscodeCacheIssue,
  VscodeCacheTargetSnapshot,
} from "./vscodeCacheService";

/** 긴 디스크 탐색을 사용자가 취소했음을 명시적으로 전달하는 오류. */
export class VscodeCacheInspectionCancelledError extends Error {
  /** 일반 실패와 취소를 명령 레이어가 구분할 수 있도록 전용 이름을 설정한다. */
  constructor() {
    super("VS Code cache inspection was cancelled.");
    this.name = "VscodeCacheInspectionCancelledError";
  }
}

/** globalStorage 경로에서 안전한 user-data-dir을 얻지 못했음을 나타내는 오류. */
export class VscodeCacheLocationError extends Error {
  /** 사용자 데이터 루트 판별 실패 메시지를 보존한다. */
  constructor(message: string) {
    super(message);
    this.name = "VscodeCacheLocationError";
  }
}

/** 재귀 탐색 중 누적하는 내부 크기/항목 수. */
interface EntrySummary {
  bytes: number;
  entries: number;
}

/** 삭제 함수가 누적하는 성공 개수와 문제 목록. */
export interface VscodeCacheClearSummary {
  removedEntries: number;
  issues: VscodeCacheIssue[];
}

/**
 * 지정한 정의만 안정된 순서로 검사해 전체 또는 선택 그룹 스냅샷을 만든다.
 * @param userDataDir 검증된 VS Code user-data-dir
 * @param definitions 검사할 고정 캐시 정의 목록
 * @param isCancelled 재귀 탐색을 중단할 취소 확인 함수
 * @returns 그룹별 크기와 탐색 issue를 합친 스냅샷
 */
export async function inspectCacheDefinitions(
  userDataDir: string,
  definitions: readonly VscodeCacheGroupDefinition[],
  isCancelled?: CacheCancellationProbe
): Promise<VscodeCacheInspection> {
  const groups: VscodeCacheGroupSnapshot[] = [];
  const issues: VscodeCacheIssue[] = [];
  for (const definition of definitions) {
    throwIfCancelled(isCancelled);
    const targets: VscodeCacheTargetSnapshot[] = [];
    for (const relativePath of definition.relativePaths) {
      const target = await inspectCacheTarget(
        userDataDir,
        definition.id,
        relativePath,
        issues,
        isCancelled
      );
      targets.push(target);
    }
    groups.push({
      id: definition.id,
      bytes: targets.reduce((total, target) => total + target.bytes, 0),
      entries: targets.reduce((total, target) => total + target.entries, 0),
      targets,
    });
  }
  return { userDataDir, groups, issues };
}

/**
 * 캐시 루트 하나를 심볼릭 링크를 따라가지 않고 재귀 측정한다.
 * @param userDataDir 검증된 VS Code user-data-dir
 * @param groupId 문제가 생겼을 때 기록할 캐시 묶음
 * @param relativePath 허용 목록에 들어 있는 상대 경로
 * @param issues 탐색 중 발생한 문제를 누적할 배열
 * @param isCancelled 사용자 취소 여부 확인 함수
 * @returns 캐시 루트 아래의 근사 크기와 항목 수
 */
async function inspectCacheTarget(
  userDataDir: string,
  groupId: VscodeCacheGroupId,
  relativePath: string,
  issues: VscodeCacheIssue[],
  isCancelled?: CacheCancellationProbe
): Promise<VscodeCacheTargetSnapshot> {
  throwIfCancelled(isCancelled);
  const absolutePath = cacheTargetPath(userDataDir, relativePath);
  let targetStat: Awaited<ReturnType<typeof lstat>>;
  try {
    targetStat = await lstat(absolutePath);
  } catch (error) {
    if (!isMissingError(error)) {
      issues.push(issue(groupId, relativePath, "inspect", errorMessage(error)));
    }
    return { relativePath, bytes: 0, entries: 0 };
  }
  if (targetStat.isSymbolicLink()) {
    issues.push(
      issue(
        groupId,
        relativePath,
        "inspect",
        "Cache root is a symbolic link; skipped for safety."
      )
    );
    return { relativePath, bytes: 0, entries: 0 };
  }
  if (!targetStat.isDirectory()) {
    issues.push(
      issue(
        groupId,
        relativePath,
        "inspect",
        "Cache root is not a directory; skipped for safety."
      )
    );
    return { relativePath, bytes: 0, entries: 0 };
  }
  const summary = await measureDirectory(
    absolutePath,
    userDataDir,
    groupId,
    issues,
    isCancelled
  );
  return { relativePath, ...summary };
}

/**
 * 한 디렉터리의 자식들을 순차 순회해 과도한 파일 핸들 사용 없이 크기를 합산한다.
 * @param directory 현재 순회할 절대 디렉터리
 * @param userDataDir 상대 오류 경로를 계산할 루트
 * @param groupId 오류가 속한 캐시 묶음
 * @param issues 읽지 못한 자식 경로를 누적할 배열
 * @param isCancelled 사용자 취소 여부 확인 함수
 * @returns 모든 읽을 수 있는 자식의 근사 크기와 항목 수
 */
async function measureDirectory(
  directory: string,
  userDataDir: string,
  groupId: VscodeCacheGroupId,
  issues: VscodeCacheIssue[],
  isCancelled?: CacheCancellationProbe
): Promise<EntrySummary> {
  let handle: Awaited<ReturnType<typeof opendir>>;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if (!isMissingError(error)) {
      issues.push(
        issue(
          groupId,
          relativeToRoot(userDataDir, directory),
          "inspect",
          errorMessage(error)
        )
      );
    }
    return { bytes: 0, entries: 0 };
  }
  const summary: EntrySummary = { bytes: 0, entries: 0 };
  for await (const entry of handle) {
    throwIfCancelled(isCancelled);
    const child = safeChildPath(directory, entry.name);
    const measured = await measureEntry(
      child,
      userDataDir,
      groupId,
      issues,
      isCancelled
    );
    summary.bytes += measured.bytes;
    summary.entries += measured.entries;
  }
  return summary;
}

/**
 * 파일/링크 하나는 크기만 더하고 실제 디렉터리만 재귀 순회한다.
 * @param entryPath 측정할 절대 자식 경로
 * @param userDataDir 상대 오류 경로를 계산할 루트
 * @param groupId 오류가 속한 캐시 묶음
 * @param issues 읽기 실패를 누적할 배열
 * @param isCancelled 사용자 취소 여부 확인 함수
 * @returns 현재 항목 자체와 읽을 수 있는 하위 항목의 합계
 */
async function measureEntry(
  entryPath: string,
  userDataDir: string,
  groupId: VscodeCacheGroupId,
  issues: VscodeCacheIssue[],
  isCancelled?: CacheCancellationProbe
): Promise<EntrySummary> {
  throwIfCancelled(isCancelled);
  let entryStat: Awaited<ReturnType<typeof lstat>>;
  try {
    entryStat = await lstat(entryPath);
  } catch (error) {
    if (!isMissingError(error)) {
      issues.push(
        issue(
          groupId,
          relativeToRoot(userDataDir, entryPath),
          "inspect",
          errorMessage(error)
        )
      );
    }
    return { bytes: 0, entries: 0 };
  }
  if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
    return { bytes: entryStat.size, entries: 1 };
  }
  const children = await measureDirectory(
    entryPath,
    userDataDir,
    groupId,
    issues,
    isCancelled
  );
  return { bytes: children.bytes, entries: children.entries + 1 };
}

/**
 * 캐시 루트의 직접 자식만 삭제 요청해 루트 디렉터리와 고정 경계를 보존한다.
 * @param userDataDir 검증된 VS Code user-data-dir
 * @param groupId 정리 중인 캐시 묶음
 * @param relativePath 허용 목록의 캐시 상대 경로
 * @returns 삭제 성공한 직접 항목 수와 실패 목록
 */
export async function clearCacheTarget(
  userDataDir: string,
  groupId: VscodeCacheGroupId,
  relativePath: string
): Promise<VscodeCacheClearSummary> {
  const absolutePath = cacheTargetPath(userDataDir, relativePath);
  let targetStat: Awaited<ReturnType<typeof lstat>>;
  try {
    targetStat = await lstat(absolutePath);
  } catch (error) {
    return isMissingError(error)
      ? { removedEntries: 0, issues: [] }
      : {
          removedEntries: 0,
          issues: [
            issue(groupId, relativePath, "cleanup", errorMessage(error)),
          ],
        };
  }
  if (targetStat.isSymbolicLink()) {
    return {
      removedEntries: 0,
      issues: [
        issue(
          groupId,
          relativePath,
          "cleanup",
          "Cache root is a symbolic link; skipped for safety."
        ),
      ],
    };
  }
  if (!targetStat.isDirectory()) {
    return {
      removedEntries: 0,
      issues: [
        issue(
          groupId,
          relativePath,
          "cleanup",
          "Cache root is not a directory; skipped for safety."
        ),
      ],
    };
  }

  let names: string[];
  try {
    names = await readdir(absolutePath);
  } catch (error) {
    return {
      removedEntries: 0,
      issues: [
        issue(groupId, relativePath, "cleanup", errorMessage(error)),
      ],
    };
  }
  const summary: VscodeCacheClearSummary = {
    removedEntries: 0,
    issues: [],
  };
  const batchSize = 8;
  for (let offset = 0; offset < names.length; offset += batchSize) {
    const batch = names.slice(offset, offset + batchSize);
    const outcomes = await Promise.all(
      batch.map(async (name) => {
        const child = safeChildPath(absolutePath, name);
        try {
          await rm(child, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 75,
          });
          return undefined;
        } catch (error) {
          return issue(
            groupId,
            relativeToRoot(userDataDir, child),
            "cleanup",
            errorMessage(error)
          );
        }
      })
    );
    for (const outcome of outcomes) {
      if (outcome) {
        summary.issues.push(outcome);
      } else {
        summary.removedEntries++;
      }
    }
  }
  return summary;
}

/**
 * 고정 상대 경로가 user-data-dir 안에만 머무는지 재검증하고 절대 경로를 만든다.
 * @param userDataDir 검증된 VS Code user-data-dir
 * @param relativePath 캐시 정의의 상대 경로
 * @returns user-data-dir 내부의 절대 캐시 경로
 * @throws VscodeCacheLocationError 경로가 루트 자신이거나 외부로 벗어나는 경우
 */
function cacheTargetPath(userDataDir: string, relativePath: string): string {
  const target = path.resolve(userDataDir, relativePath);
  const relative = path.relative(userDataDir, target);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new VscodeCacheLocationError(
      `Refusing unsafe VS Code cache path: ${relativePath}`
    );
  }
  return target;
}

/**
 * readdir가 반환한 이름이 현재 캐시 루트 밖으로 나가지 않는지 확인한다.
 * @param directory 삭제 또는 측정 중인 캐시 디렉터리
 * @param name readdir/opendir가 반환한 단일 자식 이름
 * @returns 현재 디렉터리 내부의 검증된 절대 경로
 */
function safeChildPath(directory: string, name: string): string {
  const child = path.resolve(directory, name);
  const relative = path.relative(directory, child);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new VscodeCacheLocationError(
      `Refusing unsafe cache child path: ${name}`
    );
  }
  return child;
}

/**
 * 절대 경로를 운영체제 구분자를 유지한 user-data-dir 상대 경로로 바꾼다.
 * @param userDataDir 기준이 되는 VS Code user-data-dir
 * @param absolutePath 캐시 내부 절대 경로
 * @returns 로그와 진단에 사용할 상대 경로
 */
function relativeToRoot(userDataDir: string, absolutePath: string): string {
  return path.relative(userDataDir, absolutePath) || ".";
}

/**
 * 서비스 전 구간에서 같은 모양의 진단 객체를 만든다.
 * @param groupId 문제가 속한 캐시 묶음
 * @param relativePath user-data-dir 기준 상대 경로
 * @param stage 탐색 또는 삭제 단계
 * @param message 오류 요약
 * @returns 로그와 UI 집계에 사용할 진단 객체
 */
function issue(
  groupId: VscodeCacheGroupId,
  relativePath: string,
  stage: VscodeCacheIssue["stage"],
  message: string
): VscodeCacheIssue {
  return { groupId, relativePath, stage, message };
}

/**
 * 사후 재검사와 삭제 단계에서 같은 문제가 반복되면 한 번만 보고한다.
 * @param issues 중복될 수 있는 진단 목록
 * @returns 단계·그룹·경로·메시지가 같은 항목을 제거한 목록
 */
export function uniqueCacheIssues(
  issues: readonly VscodeCacheIssue[]
): VscodeCacheIssue[] {
  const seen = new Set<string>();
  return issues.filter((entry) => {
    const key = `${entry.stage}\0${entry.groupId}\0${entry.relativePath}\0${entry.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * VS Code CancellationToken을 단순 함수 경계로 받아 재귀 탐색을 즉시 끝낸다.
 * @param isCancelled 취소되면 true를 반환하는 선택적 함수
 * @throws VscodeCacheInspectionCancelledError 사용자가 진행 알림에서 취소한 경우
 */
function throwIfCancelled(isCancelled?: CacheCancellationProbe): void {
  if (isCancelled?.()) {
    throw new VscodeCacheInspectionCancelledError();
  }
}

/**
 * 파일이 탐색과 동시에 사라진 정상 경합인지 판별한다.
 * @param error Node 파일 시스템 오류
 * @returns ENOENT이면 true
 */
function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * 알 수 없는 throw 값을 OUTPUT에 남길 수 있는 짧은 문자열로 바꾼다.
 * @param error Error 또는 임의 throw 값
 * @returns 사람이 읽을 오류 메시지
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
