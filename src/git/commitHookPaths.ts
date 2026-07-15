// core.hooksPath, linked worktree, Husky 규칙을 반영해 commit hook 관리 경로를 해석한다.
// - Git 경로 정책은 `rev-parse --git-path hooks`에 맡기고 config 원문은 UI 경고 메타데이터로 보존한다.
import { homedir } from "node:os";
import * as path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { runGit } from "./gitExec";

/** git config 에서 읽은 core.hooksPath 최종 값과 정의 위치. */
export interface HookPathConfig {
  value?: string;
  scope?: string;
  origin?: string;
}

/** 서비스가 hook 파일을 조회/편집할 때 사용할 해석된 경로 정보. */
export interface ResolvedHookDirectory {
  /** symlink와 운영체제 경로 alias를 정규화한 저장소 루트 */
  canonicalRepoRoot: string;
  /** 사용자가 열고 파일 API가 조작할 Git 해석 경로 */
  directory: string;
  /** symlink를 따라 작업트리/index 안전성 판정에 사용할 실제 경로 */
  canonicalDirectory: string;
  effectiveDirectory: string;
  configuredPath?: string;
  configOrigin?: string;
  shared: boolean;
  framework?: "husky";
  usesProxyEntrypoints: boolean;
  localMetadata: boolean;
  insideWorktree: boolean;
}

/**
 * 저장소의 유효 hook 디렉터리와 설정 출처를 한 번에 해석한다.
 * - Husky v9 `.husky/_` entrypoint는 사용자가 편집할 상위 `.husky` 경로로 분리한다.
 * @param repoRoot git config/rev-parse를 실행할 저장소 루트
 * @returns Git 실행 경로, 사용자 관리 경로, 공유 위험과 framework 정보
 */
export async function resolveCommitHookDirectory(
  repoRoot: string
): Promise<ResolvedHookDirectory> {
  const [config, effectiveDirectory, commonDirectory] = await Promise.all([
    readHooksPathConfig(repoRoot),
    resolveEffectiveHooksPath(repoRoot),
    resolveCommonGitDirectory(repoRoot),
  ]);
  const canonicalEffectiveDirectory = await canonicalPath(effectiveDirectory);
  const lexicalHuskyLayout = isHuskyLayoutPath(effectiveDirectory);
  const canonicalHuskyLayout = isHuskyLayoutPath(canonicalEffectiveDirectory);
  const huskyV9 =
    (lexicalHuskyLayout || canonicalHuskyLayout) &&
    (await hasHuskyDispatcher(canonicalEffectiveDirectory));
  // Husky h는 `$0`의 lexical parent에서 사용자 hook을 찾으므로 symlink를 canonical parent로 바꾸지 않는다.
  const directory = huskyV9
    ? path.dirname(effectiveDirectory)
    : effectiveDirectory;
  const framework =
    huskyV9 || path.basename(directory) === ".husky"
      ? ("husky" as const)
      : undefined;
  const configOrigin = [config.scope, config.origin]
    .filter(Boolean)
    .join(" · ");
  const [canonicalRepoRoot, canonicalDirectory, canonicalCommonDirectory] =
    await Promise.all([
      canonicalPath(repoRoot),
      canonicalPath(directory),
      canonicalPath(commonDirectory),
    ]);
  const localMetadata = isInside(canonicalCommonDirectory, canonicalDirectory);
  const insideWorktree = isInside(canonicalRepoRoot, canonicalDirectory);
  const absoluteConfig = isAbsoluteConfiguredPath(config.value);
  const needsWorktreeCount =
    (localMetadata && config.scope !== "worktree") ||
    (absoluteConfig && config.scope !== "worktree");
  const multipleWorktrees =
    needsWorktreeCount && (await hasMultipleWorktrees(repoRoot));
  const metadataPathShared =
    localMetadata && config.scope !== "worktree" && multipleWorktrees;
  const absoluteConfigShared = Boolean(
    absoluteConfig &&
      config.scope !== "worktree" &&
      (config.scope === "global" ||
        config.scope === "system" ||
        multipleWorktrees)
  );
  const shared = Boolean(
    !insideWorktree ||
      metadataPathShared ||
      absoluteConfigShared
  );
  return {
    canonicalRepoRoot,
    directory,
    canonicalDirectory,
    effectiveDirectory,
    configuredPath: config.value,
    configOrigin: configOrigin || undefined,
    shared,
    framework,
    usesProxyEntrypoints: huskyV9,
    localMetadata,
    insideWorktree,
  };
}

/**
 * core.hooksPath 최종 값과 정의 출처를 git config 에서 읽는다.
 * @param repoRoot 설정 우선순위를 평가할 저장소 루트
 * @returns 설정이 없으면 빈 객체, 있으면 값/범위/파일 출처
 */
async function readHooksPathConfig(repoRoot: string): Promise<HookPathConfig> {
  const detailed = await runGit(
    ["config", "--show-scope", "--show-origin", "--get", "core.hooksPath"],
    repoRoot
  ).catch(() => "");
  if (detailed.trim()) {
    return parseHooksPathConfig(detailed);
  }
  const raw = await runGit(["config", "--get", "core.hooksPath"], repoRoot).catch(
    () => ""
  );
  return raw ? { value: raw.replace(/(?:\r?\n)+$/, "") } : {};
}

/**
 * `git config --show-scope --show-origin` 한 줄을 구조화한다.
 * - 빈 설정 값의 마지막 탭도 보존해 "설정 없음"과 `core.hooksPath=`를 구분한다.
 * @param output scope, origin, 값이 탭으로 구분된 git 출력
 * @returns 파싱된 hook 경로 설정
 */
export function parseHooksPathConfig(output: string): HookPathConfig {
  const normalized = output.replace(/(?:\r?\n)+$/, "");
  const line = normalized.split(/\r?\n/).at(-1) ?? "";
  const fields = line.split("\t");
  if (fields.length >= 3) {
    return {
      scope: fields[0]?.trim() || undefined,
      origin: fields[1]?.trim() || undefined,
      value: fields.slice(2).join("\t").trim(),
    };
  }
  if (
    fields.length === 2 &&
    /^(local|worktree|global|system|command)$/.test(fields[0]?.trim() ?? "")
  ) {
    return {
      scope: fields[0]?.trim(),
      origin: fields[1]?.trim() || undefined,
      value: "",
    };
  }
  if (fields.length === 1) {
    return { value: line.trim() || undefined };
  }
  const prefix = fields[0]?.trim() ?? "";
  const value = fields[1]?.trim() ?? "";
  const match = /^(\S+)\s+([\s\S]+)$/.exec(prefix);
  return {
    scope: match?.[1],
    origin: (match?.[2] ?? prefix) || undefined,
    value: value || undefined,
  };
}

/**
 * 유효 hook 디렉터리를 Git 자체의 core.hooksPath/worktree/common-dir 규칙으로 해석한다.
 * @param repoRoot `git rev-parse --git-path hooks` 를 실행할 저장소
 * @returns 정규화된 절대 hook 디렉터리
 */
export async function resolveEffectiveHooksPath(repoRoot: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-path", "hooks"], repoRoot)).trim();
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(repoRoot, raw);
}

/**
 * linked worktree들이 공유하는 common git directory를 절대 경로로 해석한다.
 * @param repoRoot rev-parse를 실행할 현재 worktree 루트
 * @returns main/linked worktree가 함께 사용하는 git metadata 디렉터리
 */
async function resolveCommonGitDirectory(repoRoot: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-common-dir"], repoRoot)).trim();
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(repoRoot, raw);
}

/**
 * 현재 저장소에 main 이외 linked worktree가 있어 기본 hooks가 공유되는지 확인한다.
 * - 조회 실패를 단일 worktree로 오인하지 않도록 Git 오류는 상위 inspect까지 전달한다.
 * @param repoRoot `git worktree list --porcelain`을 실행할 저장소
 * @returns worktree 레코드가 둘 이상이면 true
 */
async function hasMultipleWorktrees(repoRoot: string): Promise<boolean> {
  const output = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  return output.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length > 1;
}

/**
 * lexical/canonical layout 판정 뒤 Husky v9 dispatcher인 `h` 파일이 실제로 있는지 확인한다.
 * @param effectiveDirectory symlink/alias를 따라 실제 위치로 정규화한 hook entrypoint 디렉터리
 * @returns dispatcher가 일반 파일로 확인되면 true
 */
async function hasHuskyDispatcher(effectiveDirectory: string): Promise<boolean> {
  return stat(path.join(effectiveDirectory, "h")).then(
    (entry) => entry.isFile(),
    () => false
  );
}

/**
 * 후보 경로의 마지막 두 segment가 Husky v9의 `.husky/_` 구조인지 확인한다.
 * @param candidate Git이 반환한 lexical 경로 또는 symlink를 따른 canonical 경로
 * @returns `.husky/_`로 끝나면 true
 */
function isHuskyLayoutPath(candidate: string): boolean {
  return (
    path.basename(candidate) === "_" &&
    path.basename(path.dirname(candidate)) === ".husky"
  );
}

/**
 * symlink를 따라 실제 경로를 구하되 아직 없는 마지막 디렉터리는 실제 parent에 다시 붙인다.
 * @param candidate 공유 범위 판정에 사용할 절대 경로
 * @returns 가능한 범위에서 canonicalize한 절대 경로
 */
async function canonicalPath(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return path.join(existing, ...missingSegments);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return path.resolve(candidate);
      }
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * config 원문이 모든 worktree에서 같은 위치를 가리키는 절대/홈 경로인지 판별한다.
 * @param configuredPath core.hooksPath 최종 값. 설정이 없으면 undefined
 * @returns 절대 경로 또는 `~` 홈 경로이면 true
 */
function isAbsoluteConfiguredPath(configuredPath: string | undefined): boolean {
  return Boolean(
    configuredPath !== undefined &&
      (path.isAbsolute(configuredPath) ||
        configuredPath === "~" ||
        configuredPath.startsWith("~/") ||
        configuredPath.startsWith(`~${path.sep}`))
  );
}

/**
 * core.hooksPath 문자열의 홈 축약과 상대 경로를 저장소 기준 절대 경로로 바꾼다.
 * - 프로덕션 해석은 Git에 맡기며, 이 함수는 입력 검증/테스트와 독립 호출에 제공한다.
 * @param repoRoot 상대 경로 기준이 되는 저장소 루트
 * @param configuredPath git config 에 저장된 core.hooksPath 값
 * @returns 정규화된 절대 경로
 */
export function resolveConfiguredPath(
  repoRoot: string,
  configuredPath: string
): string {
  const expanded = configuredPath === "~"
    ? homedir()
    : configuredPath.startsWith(`~${path.sep}`) || configuredPath.startsWith("~/")
      ? path.join(homedir(), configuredPath.slice(2))
      : configuredPath;
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(repoRoot, expanded);
}

/**
 * 후보 경로가 저장소 루트 자체이거나 그 하위인지 플랫폼 경로 규칙으로 확인한다.
 * @param parent 저장소 루트 절대 경로
 * @param candidate custom hook 디렉터리 절대 경로
 * @returns 저장소 내부이면 true
 */
function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
