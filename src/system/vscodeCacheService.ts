// VS Code/Electron 이 다시 만들 수 있는 디스크 캐시를 탐색하고 선택적으로 비우는 서비스.
// - 명령/UI와 파일 시스템 로직을 분리해 테스트 가능한 경계를 유지한다.
// - 설정, 설치된 확장, workspaceStorage, 백업처럼 사용자 상태가 담긴 경로는 목록에 넣지 않는다.
import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
  clearCacheTarget,
  inspectCacheDefinitions,
  uniqueCacheIssues,
  VscodeCacheLocationError,
} from "./vscodeCacheFiles";
export {
  VscodeCacheInspectionCancelledError,
  VscodeCacheLocationError,
} from "./vscodeCacheFiles";

/** 사용자가 한 번에 선택할 수 있는 재생성 가능 캐시 묶음 식별자. */
export type VscodeCacheGroupId =
  | "workbench"
  | "renderer"
  | "webview"
  | "extensions";

/** 캐시 묶음 하나를 구성하는 고정 상대 경로 목록. */
export interface VscodeCacheGroupDefinition {
  /** UI와 로그에서 캐시 종류를 식별하는 안정적인 값. */
  id: VscodeCacheGroupId;
  /** VS Code user-data-dir 아래에서만 해석할 삭제 허용 경로. */
  relativePaths: readonly string[];
}

/** 탐색 또는 삭제 도중 건너뛴 경로와 원인을 설명한다. */
export interface VscodeCacheIssue {
  /** 문제가 발생한 캐시 묶음. */
  groupId: VscodeCacheGroupId;
  /** user-data-dir 기준 상대 경로로, 로그에서 안전하게 대상을 식별한다. */
  relativePath: string;
  /** 탐색 실패인지 실제 삭제 실패인지 구분하는 단계. */
  stage: "inspect" | "cleanup";
  /** 운영체제가 반환한 오류 또는 안전 검사 결과. */
  message: string;
}

/** 고정 캐시 경로 하나의 현재 디스크 사용량 스냅샷. */
export interface VscodeCacheTargetSnapshot {
  /** user-data-dir 기준 고정 상대 경로. */
  relativePath: string;
  /** 파일의 논리 크기를 합산한 근사 바이트 수. */
  bytes: number;
  /** 하위 파일, 디렉터리, 심볼릭 링크를 합한 항목 수. */
  entries: number;
}

/** Quick Pick 한 행으로 표시할 캐시 묶음의 사용량 스냅샷. */
export interface VscodeCacheGroupSnapshot {
  /** 캐시 묶음의 안정적인 식별자. */
  id: VscodeCacheGroupId;
  /** 묶음에 속한 모든 대상의 근사 바이트 합계. */
  bytes: number;
  /** 묶음에 속한 모든 대상의 항목 수 합계. */
  entries: number;
  /** 개별 허용 경로별 사용량. */
  targets: readonly VscodeCacheTargetSnapshot[];
}

/** 캐시 선택 UI를 만들 때 사용하는 전체 탐색 결과. */
export interface VscodeCacheInspection {
  /** 검사한 VS Code user-data-dir 절대 경로. */
  userDataDir: string;
  /** 고정 순서를 유지한 캐시 묶음별 스냅샷. */
  groups: readonly VscodeCacheGroupSnapshot[];
  /** 권한 문제나 비정상 파일 종류 때문에 읽지 못한 경로. */
  issues: readonly VscodeCacheIssue[];
}

/** 선택한 캐시를 비운 뒤 사용자에게 보고할 결과. */
export interface VscodeCacheCleanupResult {
  /** 실제 정리를 요청한 캐시 묶음. */
  groupIds: readonly VscodeCacheGroupId[];
  /** 확인 대화상자 직전 스냅샷의 근사 바이트 수. */
  requestedBytes: number;
  /** 정리 전후 스냅샷 차이로 계산한 근사 확보 용량. */
  reclaimedBytes: number;
  /** 정리 뒤에도 남았거나 실행 중 다시 생성된 근사 바이트 수. */
  remainingBytes: number;
  /** 캐시 루트 바로 아래에서 삭제에 성공한 항목 수. */
  removedEntries: number;
  /** 잠긴 파일, 권한, 심볼릭 링크 안전 검사 등으로 남은 문제. */
  issues: readonly VscodeCacheIssue[];
}

// VS Code 소스의 cacheHome/extension download 경로와 Chromium 캐시 이름만 허용한다.
// 새 캐시를 지원할 때 이 목록에 추가하면 서비스와 선택 UI가 기존 로직을 그대로 재사용한다.
const CACHE_GROUP_DEFINITIONS: readonly VscodeCacheGroupDefinition[] = [
  {
    id: "workbench",
    relativePaths: [
      "Cache",
      "CachedConfigurations",
      "CachedData",
      "CachedProfilesData",
    ],
  },
  {
    id: "renderer",
    relativePaths: [
      "Code Cache",
      "GPUCache",
      "DawnCache",
      "DawnGraphiteCache",
      "DawnWebGPUCache",
      "GraphiteDawnCache",
      "GrShaderCache",
      "ShaderCache",
    ],
  },
  {
    id: "webview",
    relativePaths: [
      path.join("Service Worker", "CacheStorage"),
      path.join("Service Worker", "ScriptCache"),
    ],
  },
  {
    id: "extensions",
    relativePaths: ["CachedExtensionVSIXs", "CachedExtensions"],
  },
];

/** VS Code CancellationToken과 결합하지 않고 서비스 테스트에 주입할 취소 확인 함수. */
export type CacheCancellationProbe = () => boolean;

/**
 * ExtensionContext.globalStorageUri 경로에서 VS Code user-data-dir을 역산한다.
 * - VS Code의 `<user-data-dir>/User/globalStorage/<extension-id>` 구조만 허용한다.
 * - 파일 시스템 루트가 계산되면 광범위 삭제 위험이 있으므로 거부한다.
 * @param globalStorageFsPath 현재 확장에 할당된 globalStorageUri.fsPath
 * @returns 검증된 user-data-dir 절대 경로, 구조가 다르면 undefined
 */
export function deriveVscodeUserDataDir(
  globalStorageFsPath: string
): string | undefined {
  if (!globalStorageFsPath.trim()) {
    return undefined;
  }
  const extensionStorage = path.resolve(globalStorageFsPath);
  const globalStorage = path.dirname(extensionStorage);
  const userDirectory = path.dirname(globalStorage);
  const userDataDir = path.dirname(userDirectory);
  if (
    !samePathSegment(path.basename(globalStorage), "globalStorage") ||
    !samePathSegment(path.basename(userDirectory), "User") ||
    path.basename(extensionStorage).length === 0 ||
    path.parse(userDataDir).root === userDataDir
  ) {
    return undefined;
  }
  return userDataDir;
}

/**
 * 고정된 VS Code 캐시 경로만 탐색하고 비우는 재사용 가능한 시스템 서비스.
 * - 인스턴스가 생성될 때 삭제 루트를 확정해 UI 입력이나 임의 경로가 삭제 API로 흘러들지 않는다.
 */
export class VscodeCacheService {
  /** 검사와 정리에 사용할 검증된 VS Code user-data-dir. */
  readonly userDataDir: string;

  /**
   * 확장 globalStorage 경로를 받아 같은 VS Code 인스턴스의 캐시 루트를 고정한다.
   * @param globalStorageFsPath ExtensionContext.globalStorageUri.fsPath
   * @throws VscodeCacheLocationError VS Code 표준 저장 구조가 아니거나 루트가 위험한 경우
   */
  constructor(globalStorageFsPath: string) {
    const userDataDir = deriveVscodeUserDataDir(globalStorageFsPath);
    if (!userDataDir) {
      throw new VscodeCacheLocationError(
        "Could not derive a safe VS Code user-data directory from global storage."
      );
    }
    this.userDataDir = userDataDir;
  }

  /**
   * 모든 허용 캐시 묶음의 현재 근사 크기와 항목 수를 읽는다.
   * - 심볼릭 링크인 캐시 루트는 따라가지 않고 issue로 남긴다.
   * @param isCancelled 각 파일 시스템 단계 사이에 취소 여부를 알려 주는 함수
   * @returns UI 선택 목록과 진단 로그에 사용할 전체 스냅샷
   */
  async inspect(
    isCancelled?: CacheCancellationProbe
  ): Promise<VscodeCacheInspection> {
    await ensureDirectory(this.userDataDir);
    return inspectCacheDefinitions(
      this.userDataDir,
      CACHE_GROUP_DEFINITIONS,
      isCancelled
    );
  }

  /**
   * 선택한 캐시 묶음의 내용만 삭제하고 디렉터리 자체는 남긴다.
   * - VS Code가 실행 중인 동안 다시 만든 파일은 사후 스캔의 remainingBytes에 반영한다.
   * - 기준 스냅샷이 같은 user-data-dir의 것이 아니면 새로 검사해 임의 결과 주입을 막는다.
   * @param groupIds 사용자가 명시적으로 선택한 캐시 묶음 식별자
   * @param baseline 확인 대화상자에 표시했던 선택 직전 스냅샷
   * @returns 전후 크기 차이, 삭제 성공 개수, 실패 경로를 담은 결과
   */
  async cleanup(
    groupIds: readonly VscodeCacheGroupId[],
    baseline?: VscodeCacheInspection
  ): Promise<VscodeCacheCleanupResult> {
    await ensureDirectory(this.userDataDir);
    const selected = selectedDefinitions(groupIds);
    const before =
      baseline?.userDataDir === this.userDataDir
        ? baseline
        : await inspectCacheDefinitions(this.userDataDir, selected);
    const requestedBytes = sumSelectedBytes(before, selected);
    const issues: VscodeCacheIssue[] = [];
    let removedEntries = 0;

    for (const definition of selected) {
      for (const relativePath of definition.relativePaths) {
        const result = await clearCacheTarget(
          this.userDataDir,
          definition.id,
          relativePath
        );
        removedEntries += result.removedEntries;
        issues.push(...result.issues);
      }
    }

    const after = await inspectCacheDefinitions(this.userDataDir, selected);
    const remainingBytes = after.groups.reduce(
      (total, group) => total + group.bytes,
      0
    );
    issues.push(...after.issues);
    return {
      groupIds: selected.map((definition) => definition.id),
      requestedBytes,
      reclaimedBytes: Math.max(0, requestedBytes - remainingBytes),
      remainingBytes,
      removedEntries,
      issues: uniqueCacheIssues(issues),
    };
  }
}

/**
 * 현재 플랫폼의 경로 대소문자 규칙에 맞춰 고정 디렉터리 이름을 비교한다.
 * @param actual 실제 경로 세그먼트
 * @param expected VS Code 표준 세그먼트
 * @returns Windows에서는 대소문자를 무시하고, 그 외 플랫폼에서는 정확히 같으면 true
 */
function samePathSegment(actual: string, expected: string): boolean {
  return process.platform === "win32"
    ? actual.toLocaleLowerCase() === expected.toLocaleLowerCase()
    : actual === expected;
}

/**
 * user-data-dir이 실제 디렉터리인지 확인한다.
 * @param directory 검사할 절대 경로
 * @returns 디렉터리이면 반환값 없이 완료
 * @throws VscodeCacheLocationError 경로가 없거나 디렉터리가 아닌 경우
 */
async function ensureDirectory(directory: string): Promise<void> {
  try {
    if (!(await stat(directory)).isDirectory()) {
      throw new VscodeCacheLocationError(
        "The derived VS Code user-data path is not a directory."
      );
    }
  } catch (error) {
    if (error instanceof VscodeCacheLocationError) {
      throw error;
    }
    throw new VscodeCacheLocationError(
      `Could not access the VS Code user-data directory: ${errorMessage(error)}`
    );
  }
}

/**
 * 사용자 선택을 중복 없는 고정 정의 목록으로 바꾼다.
 * @param groupIds Quick Pick에서 선택된 캐시 묶음 식별자
 * @returns 선언 순서를 유지하고 알려지지 않은 런타임 값은 제외한 정의 목록
 */
function selectedDefinitions(
  groupIds: readonly VscodeCacheGroupId[]
): readonly VscodeCacheGroupDefinition[] {
  const wanted = new Set<string>(groupIds);
  return CACHE_GROUP_DEFINITIONS.filter((definition) =>
    wanted.has(definition.id)
  );
}

/**
 * 기준 스냅샷에서 선택 정의에 해당하는 바이트만 합산한다.
 * @param inspection 정리 전 캐시 스냅샷
 * @param definitions 실제 정리할 고정 정의 목록
 * @returns 확인창에 표시한 근사 정리 대상 바이트 수
 */
function sumSelectedBytes(
  inspection: VscodeCacheInspection,
  definitions: readonly VscodeCacheGroupDefinition[]
): number {
  const wanted = new Set(definitions.map((definition) => definition.id));
  return inspection.groups.reduce(
    (total, group) => total + (wanted.has(group.id) ? group.bytes : 0),
    0
  );
}

/**
 * 알 수 없는 throw 값을 OUTPUT에 남길 수 있는 짧은 문자열로 바꾼다.
 * @param error Error 또는 임의 throw 값
 * @returns 사람이 읽을 오류 메시지
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
