// 저장소 로컬 commit hook 을 조회하고 활성화 상태를 변경하는 서비스.
// - Git 실행 경로 해석은 runGit 으로 통일하고, 실제 hook 파일 조작만 Node 파일 API 로 수행한다.
// - hook 내용을 해석하거나 이름을 옮기지 않는다. 안전한 일반 파일만 실행 비트로 전환한다.
import { constants as fsConstants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import * as path from "node:path";
import {
  commitHooksDirectoryExists,
  createHookFile,
  readHookDirectoryState,
  readHookFileState,
  type HookFileState,
} from "./commitHookFiles";
import { commitHookGitState } from "./commitHookWorktreeState";
import {
  resolveCommitHookDirectory,
  resolveEffectiveHooksPath,
  type ResolvedHookDirectory,
} from "./commitHookPaths";

/** Git commit 과정에서 직접 실행되거나 amend 결과와 관련된 표준 hook 이름. */
export const COMMIT_HOOK_NAMES = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "post-rewrite",
  "pre-merge-commit",
] as const;

/** 서비스가 관리할 수 있는 표준 commit hook 이름. */
export type CommitHookName = (typeof COMMIT_HOOK_NAMES)[number];

/** UI 계층이 서비스 오류를 지역화할 수 있도록 노출하는 안정적인 오류 코드. */
export type CommitHookErrorCode =
  | "notInstalled"
  | "tracked"
  | "worktreeVisible"
  | "alreadyExistsOrTracked"
  | "alreadyExists"
  | "conflict"
  | "pathChanged"
  | "fileChanged"
  | "unsupported"
  | "notChangeable";

/**
 * 파일 기반 hook 관리에서 예상 가능한 도메인 실패를 오류 코드와 hook 이름으로 전달한다.
 * - 영문 message는 로그/테스트용이며, 사용자 알림은 command 계층에서 code를 지역화한다.
 */
export class CommitHookError extends Error {
  /**
   * @param code 실패 종류를 나타내는 안정적인 코드
   * @param hookName 실패한 hook 이름 또는 검증 전 입력
   */
  constructor(
    readonly code: CommitHookErrorCode,
    readonly hookName: string
  ) {
    super(commitHookErrorMessage(code, hookName));
    this.name = "CommitHookError";
  }
}

/** 디스크에서 확인한 hook 한 건의 활성화 상태. */
export type CommitHookState =
  | "enabled"
  | "disabled"
  | "notExecutable"
  | "entrypointMissing"
  | "conflict";

/** Changes UI 에 표시할 설치된 commit hook 한 건. */
export interface CommitHookEntry {
  /** 표준 hook 파일 이름 */
  name: CommitHookName;
  /** Git 이 현재 실행할 수 있는 상태인지 여부 */
  enabled: boolean;
  /** 활성/비활성 파일과 실행 권한을 종합한 상세 상태 */
  state: CommitHookState;
  /** 사용자가 열어 편집할 실제 hook 파일 절대 경로 */
  path: string;
  /** 이름 충돌 없이 활성화 상태를 전환할 수 있는지 여부 */
  canToggle: boolean;
  /** hook 파일이 Git index 에 추적되어 로컬 토글로 작업트리가 바뀔 수 있는지 여부 */
  tracked: boolean;
  /** hook 파일이 untracked 변경으로 보여 다음 smart commit에 포함될 수 있는지 여부 */
  worktreeVisible: boolean;
  /** 안전상 토글을 막은 이유. 충돌 또는 커밋 위험 파일이면 설정된다. */
  toggleBlockedReason?:
    | "conflict"
    | "tracked"
    | "worktree"
    | "entrypoint"
    | "proxy"
    | "symbolicLink"
    | "platform"
    | "renamed";
  /** hook 파일이 심볼릭 링크인지 여부 */
  symbolicLink: boolean;
  /** 파일의 마지막 수정 시각(epoch milliseconds) */
  modifiedAt: number;
}

/** 저장소에서 해석된 commit hook 관리 상태 전체. */
export interface CommitHooksSnapshot {
  /** 이 상태를 조회한 저장소 루트 */
  repoRoot: string;
  /** 운영체제 alias와 symlink를 정규화한 저장소 루트 */
  canonicalRepoRoot: string;
  /** 사용자가 편집할 hook 파일이 있는 관리 디렉터리 */
  directory: string;
  /** mutation 확인과 lock에 사용할 실제 hook 디렉터리 */
  canonicalDirectory: string;
  /** Git 이 실제 hook entrypoint 를 찾는 디렉터리 */
  effectiveDirectory: string;
  /** core.hooksPath 원문. 기본 .git/hooks 이면 undefined */
  configuredPath?: string;
  /** core.hooksPath 를 정의한 git config 파일/범위 설명 */
  configOrigin?: string;
  /** 저장소 밖 또는 전역 설정 경로라 여러 저장소가 공유할 수 있는지 여부 */
  shared: boolean;
  /** Husky 같은 알려진 hook 관리 도구 이름 */
  framework?: "husky";
  /** 사용자 파일과 별도의 실행 wrapper를 사용하는 Husky v9 layout인지 여부 */
  usesProxyEntrypoints: boolean;
  /** hook 경로가 Git metadata 안에 있어 작업트리와 분리되는지 여부 */
  localMetadata: boolean;
  /** hook 실제 경로가 현재 작업트리 안인지 여부 */
  insideWorktree: boolean;
  /** hook 경로가 디렉터리인지, 아직 없는지, 파일이라 사용할 수 없는지 상태 */
  directoryState: "ready" | "missing" | "notDirectory";
  /** 실제 설치가 확인된 표준 commit hook 목록 */
  hooks: CommitHookEntry[];
  /** 새 파일로 만들 수 있는 아직 설치되지 않은 hook 이름 */
  creatable: CommitHookName[];
}

/**
 * 특정 저장소의 로컬 commit hook 파일을 관리한다.
 * - command/UI 계층과 독립적이라 refresh, Quick Pick, 웹뷰 어디서든 재사용할 수 있다.
 */
export class CommitHookService {
  /**
   * @param repoRoot hook 경로를 해석하고 git config 를 읽을 저장소 루트 절대 경로
   */
  constructor(readonly repoRoot: string) {}

  /**
   * 현재 hook 디렉터리와 설치된 표준 commit hook 목록을 조회한다.
   * @returns UI 렌더와 후속 안전 검증에 사용할 불변 스냅샷
   */
  async inspect(): Promise<CommitHooksSnapshot> {
    const resolved = await resolveCommitHookDirectory(this.repoRoot);
    const directoryState = await readHookDirectoryState(resolved.directory);
    const entries = directoryState === "notDirectory"
      ? []
      : await Promise.all(
          COMMIT_HOOK_NAMES.map((name) => this.inspectHook(resolved, name))
        );
    const discovered = entries.filter(
      (entry): entry is CommitHookEntry => entry !== undefined
    );
    const gitState = await commitHookGitState(
      this.repoRoot,
      resolved,
      discovered,
      COMMIT_HOOK_NAMES
    );
    const installed = new Set([
      ...gitState.hooks.map((hook) => hook.name),
      ...gitState.reservedNames,
    ]);
    return {
      repoRoot: this.repoRoot,
      ...resolved,
      directoryState,
      hooks: gitState.hooks,
      creatable:
        directoryState === "notDirectory"
          ? []
          : COMMIT_HOOK_NAMES.filter((name) => !installed.has(name)),
    };
  }

  /**
   * 곧 실행될 표준 commit hook entrypoint 이름만 한 번의 Git 경로 조회와 병렬 lstat로 읽는다.
   * - UI 관리 상태·tracked/worktree 검사는 생략하고, 실패 진단에 필요한 실제 실행 후보만 고정한다.
   * @returns Git이 현재 실행할 수 있는 표준 commit hook 이름 목록
   */
  async enabledEntrypoints(): Promise<CommitHookName[]> {
    const directory = await resolveEffectiveHooksPath(this.repoRoot);
    const [canonicalDirectory, states] = await Promise.all([
      realpath(directory).catch(() => directory),
      Promise.all(
        COMMIT_HOOK_NAMES.map((name) =>
          readHookFileState(path.join(directory, name))
        )
      ),
    ]);
    const huskyLayout =
      isHuskyProxyDirectory(directory) ||
      isHuskyProxyDirectory(canonicalDirectory);
    const proxyFiles = huskyLayout
      ? await Promise.all([
          readHookFileState(path.join(directory, "h")),
          ...COMMIT_HOOK_NAMES.map((name) =>
            readHookFileState(path.join(path.dirname(directory), name))
          ),
        ])
      : undefined;
    const hasHuskyDispatcher = proxyFiles?.[0]?.exists === true;
    return COMMIT_HOOK_NAMES.filter(
      (_name, index) =>
        states[index]?.exists &&
        states[index]?.executable &&
        (!hasHuskyDispatcher || proxyFiles?.[index + 1]?.exists)
    );
  }

  /**
   * 기존 hook 을 활성화 또는 비활성화한다.
   * - 외부 편집과 경합해도 내용을 잃지 않도록 Unix 일반 파일의 실행 비트만 변경한다.
   * - Husky proxy, symlink, Windows, 기존 `.disabled` 이름은 안전상 UI 토글을 허용하지 않는다.
   * @param name 허용 목록에 속한 표준 commit hook 이름
   * @param enabled 변경 뒤 Git 이 hook 을 실행해야 하는지 여부
   * @param expectedDirectory 사용자 확인 당시의 canonical hook 디렉터리
   * @returns 변경 직후 다시 조회한 최신 hook 스냅샷
   */
  async setEnabled(
    name: CommitHookName,
    enabled: boolean,
    expectedDirectory?: string
  ): Promise<CommitHooksSnapshot> {
    assertCommitHookName(name);
    const before = await this.inspect();
    assertExpectedDirectory(before, expectedDirectory, name);
    const hook = before.hooks.find((entry) => entry.name === name);
    if (!hook) {
      throw new CommitHookError("notInstalled", name);
    }
    if (hook.tracked) {
      throw new CommitHookError("tracked", name);
    }
    if (hook.worktreeVisible) {
      throw new CommitHookError("worktreeVisible", name);
    }
    if (!hook.canToggle) {
      throw new CommitHookError("notChangeable", name);
    }
    const activePath = path.join(before.directory, name);
    const disabledPath = disabledHookPath(activePath);
    const [active, disabled] = await Promise.all([
      readHookFileState(activePath),
      readHookFileState(disabledPath),
    ]);

    if (active.exists && disabled.exists) {
      throw new CommitHookError("conflict", name);
    }
    if (!active.exists) {
      throw new CommitHookError("notInstalled", name);
    }
    await setExecutable(active, enabled, name);
    return this.inspect();
  }

  /**
   * 선택한 표준 hook 의 안전한 shell 기본 파일을 새로 만들고 편집 가능한 상태로 둔다.
   * @param name 만들 표준 commit hook 이름
   * @param expectedDirectory 사용자 확인 당시의 canonical hook 디렉터리
   * @returns 생성 직후 다시 조회한 최신 hook 스냅샷
   */
  async create(
    name: CommitHookName,
    expectedDirectory?: string
  ): Promise<CommitHooksSnapshot> {
    assertCommitHookName(name);
    const before = await this.inspect();
    assertExpectedDirectory(before, expectedDirectory, name);
    if (!before.creatable.includes(name)) {
      throw new CommitHookError("alreadyExistsOrTracked", name);
    }
    const activePath = path.join(before.directory, name);
    const disabledPath = disabledHookPath(activePath);
    const [active, disabled] = await Promise.all([
      readHookFileState(activePath),
      readHookFileState(disabledPath),
    ]);
    if (active.exists || disabled.exists) {
      throw new CommitHookError("alreadyExists", name);
    }
    await mkdir(before.directory, { recursive: true });
    await createHookFile(activePath, hookTemplate(name));
    return this.inspect();
  }

  /**
   * UI 에서 전달한 이름에 대응하는 현재 hook 파일을 다시 검증해 반환한다.
   * @param name 열거나 조작하려는 표준 commit hook 이름
   * @returns 설치된 hook 파일 절대 경로, 없으면 undefined
   */
  async resolveInstalledPath(
    name: CommitHookName
  ): Promise<string | undefined> {
    assertCommitHookName(name);
    const snapshot = await this.inspect();
    return snapshot.hooks.find((hook) => hook.name === name)?.path;
  }

  /**
   * 활성/비활성 파일 상태를 바탕으로 hook 한 건의 UI 모델을 만든다.
   * @param resolved 사용자 파일과 실제 실행 entrypoint 경로를 함께 담은 해석 결과
   * @param name 조회할 표준 hook 이름
   * @returns 설치 파일이 없으면 undefined, 있으면 상태가 포함된 entry
   */
  private async inspectHook(
    resolved: ResolvedHookDirectory,
    name: CommitHookName
  ): Promise<CommitHookEntry | undefined> {
    const activePath = path.join(resolved.directory, name);
    const disabledPath = disabledHookPath(activePath);
    const [active, disabled] = await Promise.all([
      readHookFileState(activePath),
      readHookFileState(disabledPath),
    ]);
    if (!active.exists && !disabled.exists) {
      return undefined;
    }
    const entrypoint = resolved.usesProxyEntrypoints
      ? await readHookFileState(path.join(resolved.effectiveDirectory, name))
      : active;
    const conflict = active.exists && disabled.exists;
    const state: CommitHookState = conflict
      ? "conflict"
      : active.exists && entrypoint.exists && entrypoint.executable
        ? "enabled"
        : active.exists && resolved.usesProxyEntrypoints
          ? "entrypointMissing"
        : active.exists
          ? "notExecutable"
          : "disabled";
    const selected = active.exists ? active : disabled;
    const toggleBlockedReason = baseToggleBlockedReason(
      state,
      active,
      disabled,
      selected,
      resolved
    );
    return {
      name,
      enabled: state === "enabled",
      state,
      path: selected.path,
      canToggle: toggleBlockedReason === undefined,
      tracked: false,
      worktreeVisible: false,
      toggleBlockedReason,
      symbolicLink: selected.symbolicLink,
      modifiedAt: selected.modifiedAt,
    };
  }

}

/**
 * Git의 effective hook 경로가 Husky v9 dispatcher 디렉터리 형태인지 확인한다.
 * @param directory lexical 경로 또는 symlink를 해석한 실제 hook 디렉터리
 * @returns 마지막 두 segment가 `.husky/_`이면 true
 */
function isHuskyProxyDirectory(directory: string): boolean {
  return (
    path.basename(directory) === "_" &&
    path.basename(path.dirname(directory)) === ".husky"
  );
}

/**
 * pathname 이동 없이 실행 비트만 바꾸는 안전한 토글을 적용할 수 있는지 판정한다.
 * @param state 활성/비활성 파일과 proxy entrypoint를 합친 hook 상태
 * @param active 표준 활성 이름 파일 상태
 * @param disabled 기존 `.disabled` 이름 파일 상태
 * @param selected UI에서 열 실제 파일 상태
 * @param resolved Husky proxy 및 경로 정보를 담은 해석 결과
 * @returns 토글 가능하면 undefined, 열기만 허용해야 하면 차단 이유
 */
function baseToggleBlockedReason(
  state: CommitHookState,
  active: HookFileState,
  disabled: HookFileState,
  selected: HookFileState,
  resolved: ResolvedHookDirectory
): CommitHookEntry["toggleBlockedReason"] {
  if (state === "conflict") {
    return "conflict";
  }
  if (state === "entrypointMissing") {
    return "entrypoint";
  }
  if (resolved.usesProxyEntrypoints) {
    return "proxy";
  }
  if (process.platform === "win32") {
    return "platform";
  }
  if (selected.symbolicLink) {
    return "symbolicLink";
  }
  if (!active.exists && disabled.exists) {
    return "renamed";
  }
  return undefined;
}

/**
 * 사용자 확인 이후 core.hooksPath 또는 symlink target이 바뀌지 않았는지 검증한다.
 * @param snapshot mutation 직전에 다시 해석한 hook 상태
 * @param expectedDirectory command 계층이 확인 대화상자 전에 보관한 canonical 경로
 * @param name 변경하려는 hook 이름
 */
function assertExpectedDirectory(
  snapshot: CommitHooksSnapshot,
  expectedDirectory: string | undefined,
  name: string
): void {
  if (
    expectedDirectory !== undefined &&
    normalizedIdentityPath(snapshot.canonicalDirectory) !==
      normalizedIdentityPath(expectedDirectory)
  ) {
    throw new CommitHookError("pathChanged", name);
  }
}

/**
 * canonical 경로를 플랫폼의 대소문자 규칙에 맞춰 안정적인 비교 문자열로 바꾼다.
 * @param candidate 비교할 절대 경로
 * @returns separator를 정규화하고 Windows에서는 소문자로 바꾼 경로
 */
function normalizedIdentityPath(candidate: string): string {
  const normalized = path.normalize(candidate);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 일반 hook 파일의 실행 비트만 바꿔 pathname 이동 없이 Git 실행 여부를 전환한다.
 * - 내용이나 이름을 삭제하지 않으므로 에디터 atomic save와 경합해도 hook 내용을 잃지 않는다.
 * @param state 현재 활성 이름의 일반 hook 파일 상태
 * @param enabled 변경 뒤 Git이 실행해야 하는지 여부
 * @param name 오류 메시지에 포함할 표준 hook 이름
 */
async function setExecutable(
  state: HookFileState,
  enabled: boolean,
  name: CommitHookName
): Promise<void> {
  if (process.platform === "win32" || state.symbolicLink) {
    throw new CommitHookError("notChangeable", name);
  }
  const handle = await open(
    state.path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  );
  try {
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.dev !== state.dev ||
      current.ino !== state.ino
    ) {
      throw new CommitHookError("fileChanged", name);
    }
    const mode = enabled ? current.mode | 0o111 : current.mode & ~0o111;
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

/**
 * 활성 hook 경로에 대응하는 보존용 비활성 파일 이름을 만든다.
 * @param activePath 확장자 없는 표준 hook 파일 경로
 * @returns `.disabled` 접미사를 붙인 경로
 */
function disabledHookPath(activePath: string): string {
  return `${activePath}.disabled`;
}

/**
 * 새 hook 에 넣을 최소 shell 템플릿을 만든다.
 * @param name 주석에 표시할 표준 hook 이름
 * @returns 실패 없이 시작하고 사용자가 검사 명령을 추가할 수 있는 텍스트
 */
function hookTemplate(name: CommitHookName): string {
  return `#!/bin/sh\n\n# Git Simple Compare: ${name}\n# Add checks below. A non-zero exit code stops the commit.\n\nexit 0\n`;
}

/**
 * 도메인 오류 코드에 대응하는 안정적인 영문 로그 message를 만든다.
 * @param code hook 관리 실패 종류
 * @param name 실패한 hook 이름 또는 허용 목록 밖 입력
 * @returns 진단 로그와 하위 호환 테스트에 사용할 영문 오류 설명
 */
function commitHookErrorMessage(
  code: CommitHookErrorCode,
  name: string
): string {
  switch (code) {
    case "notInstalled":
      return `Hook '${name}' is not installed.`;
    case "tracked":
      return `Tracked hook '${name}' cannot be toggled safely.`;
    case "worktreeVisible":
      return `Untracked hook '${name}' could be included in the next commit.`;
    case "alreadyExistsOrTracked":
      return `Hook '${name}' already exists or is tracked by Git.`;
    case "alreadyExists":
      return `Hook '${name}' already exists.`;
    case "conflict":
      return `Hook '${name}' has both active and disabled files.`;
    case "pathChanged":
      return `The hook path changed before '${name}' could be updated.`;
    case "fileChanged":
      return `Hook '${name}' changed before its executable bit could be updated.`;
    case "unsupported":
      return `Unsupported commit hook '${name}'.`;
    case "notChangeable":
      return `Hook '${name}' cannot be changed in its current state.`;
  }
}

/**
 * 런타임 입력이 허용된 표준 commit hook 이름인지 검증한다.
 * @param name 웹뷰/명령에서 전달된 hook 이름
 */
export function assertCommitHookName(name: string): asserts name is CommitHookName {
  if (!(COMMIT_HOOK_NAMES as readonly string[]).includes(name)) {
    throw new CommitHookError("unsupported", name);
  }
}

export { commitHooksDirectoryExists };
