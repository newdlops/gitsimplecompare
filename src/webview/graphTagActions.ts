// git graph 웹뷰의 태그 관련 액션을 처리하는 모듈.
// - graphActions.ts 는 메시지 라우팅에 집중하고, 태그 생성/checkout/push/delete 흐름은 여기로 모은다.
import * as vscode from "vscode";
import { GitLogService } from "../git/gitLogService";
import { GitTagService, GitTagStatus } from "../git/gitTagService";
import {
  focusCheckoutConflicts,
  isCheckoutConflictError,
  retryCheckoutWithConflicts,
} from "./graphCheckoutConflicts";
import { fetchTags } from "./graphSyncActions";

interface GraphTagActionDeps {
  logService: GitLogService;
  refreshGraph: () => Promise<void>;
}

type TagQuickAction =
  | "checkout"
  | "createBranch"
  | "push"
  | "deleteLocal"
  | "deleteRemote"
  | "fetch"
  | "copy"
  | "rename";

interface TagQuickPickItem extends vscode.QuickPickItem {
  action: TagQuickAction;
}

/**
 * 선택 커밋에 새 tag 를 만든다.
 * - staged/ongoing 같은 가상 커밋은 태그 대상으로 사용할 수 없어서 호출부 검증 함수를 받는다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param hash 태그를 붙일 실제 커밋 해시
 * @param isRealCommit 가상 커밋 여부를 판별하는 함수
 */
export async function createTag(
  deps: GraphTagActionDeps,
  hash: string,
  isRealCommit: (hash: string) => boolean
): Promise<void> {
  if (!isRealCommit(hash)) {
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("New tag name"),
    validateInput: (value) =>
      value.trim() ? undefined : vscode.l10n.t("Tag name is required."),
  });
  if (!name) {
    return;
  }
  await deps.logService.createTag(name.trim(), hash);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Tag '{0}' created.", name.trim())
  );
}

/**
 * tag chip 의 빠른 액션 메뉴를 보여준다.
 * - 태그 checkout/브랜치 생성/원격 동기화/삭제/복사 액션을 한 곳에서 선택하게 한다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param tag 사용자가 선택한 태그 이름
 */
export async function tagAction(
  deps: GraphTagActionDeps,
  tag: string,
  target?: string,
  remote?: string
): Promise<void> {
  const status = await tagStatus(deps, tag);
  const hasLocal = Boolean(status?.localHash);
  const hasRemote = Boolean(remote || status?.remoteTargets.length);
  const pick = await vscode.window.showQuickPick<TagQuickPickItem>(
    [
      {
        label: vscode.l10n.t("Checkout Tag"),
        description: vscode.l10n.t("Checkout detached at this tag."),
        action: "checkout",
      },
      {
        label: vscode.l10n.t("Create Branch from Tag"),
        description: vscode.l10n.t("Create a local branch at this tag."),
        action: "createBranch",
      },
      ...(hasLocal
        ? [
            { label: vscode.l10n.t("Rename Local Tag"), action: "rename" as const },
            { label: vscode.l10n.t("Push Tag"), action: "push" as const },
            { label: vscode.l10n.t("Delete Local Tag"), action: "deleteLocal" as const },
          ]
        : []),
      ...(hasRemote
        ? [{ label: vscode.l10n.t("Delete Remote Tag"), action: "deleteRemote" as const }]
        : []),
      { label: vscode.l10n.t("Fetch Tags"), action: "fetch" },
      { label: vscode.l10n.t("Copy Tag Name"), action: "copy" },
    ],
    { placeHolder: remote ? `${remote}/${tag}` : tag }
  );
  if (!pick) {
    return;
  }
  if (pick.action === "checkout") {
    await checkoutTag(deps, tag, target);
  } else if (pick.action === "createBranch") {
    await createBranchFromTag(deps, tag, target);
  } else if (pick.action === "rename") {
    await renameTag(deps, tag, status);
  } else if (pick.action === "push") {
    await pushTag(deps, tag);
  } else if (pick.action === "deleteLocal") {
    await deleteTag(deps, tag);
  } else if (pick.action === "deleteRemote") {
    await deleteRemoteTag(deps, tag, remote);
  } else if (pick.action === "fetch") {
    await fetchTags(deps);
  } else {
    await copyTagName(tag);
  }
}

/**
 * tag 로 detached HEAD checkout 을 수행한다.
 * - 로컬 변경 충돌은 commit checkout 과 같은 충돌 확인 UI 를 사용한다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param tag checkout 할 태그 이름
 */
export async function checkoutTag(
  deps: GraphTagActionDeps,
  tag: string,
  target?: string
): Promise<void> {
  const startPoint = target || tag;
  const ok = await confirm(
    vscode.l10n.t("Checkout tag '{0}' as detached HEAD?", tag),
    vscode.l10n.t("Checkout")
  );
  if (!ok) {
    return;
  }
  try {
    await deps.logService.checkoutCommitDetached(startPoint);
  } catch (err) {
    if (!isCheckoutConflictError(err)) {
      throw err;
    }
    const result = await retryCheckoutWithConflicts(
      err,
      deps.logService.repoRoot,
      startPoint,
      () => deps.logService.checkoutCommitDetached(startPoint, true)
    );
    if (result === "cancelled") {
      return;
    }
    await deps.refreshGraph();
    if (await focusCheckoutConflicts(deps.logService.repoRoot)) {
      return;
    }
    if (result === "conflicts") {
      return;
    }
  }
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Checked out tag '{0}'.", tag)
  );
}

/**
 * 태그를 시작점으로 새 로컬 브랜치를 만든다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param tag 브랜치 시작점으로 사용할 태그 이름
 */
export async function createBranchFromTag(
  deps: GraphTagActionDeps,
  tag: string,
  target?: string
): Promise<void> {
  const startPoint = target || tag;
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Create branch from tag '{0}'", tag),
    validateInput: (value) =>
      value.trim() ? undefined : vscode.l10n.t("Branch name is required."),
  });
  if (!name) {
    return;
  }
  await deps.logService.createBranchAt(name.trim(), startPoint);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch '{0}' created.", name.trim())
  );
}

/**
 * 로컬 tag 를 삭제한다. tag 를 넘기지 않으면 목록에서 고른다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param tagName 바로 삭제할 태그 이름. 없으면 QuickPick 으로 선택한다.
 */
export async function deleteTag(
  deps: GraphTagActionDeps,
  tagName?: string
): Promise<void> {
  const tag = tagName ?? (await pickTag(deps));
  if (
    !tag ||
    !(await confirm(vscode.l10n.t("Delete local tag '{0}'?", tag), vscode.l10n.t("Delete")))
  ) {
    return;
  }
  await deps.logService.deleteTag(tag);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(vscode.l10n.t("Tag '{0}' deleted.", tag));
}

/**
 * 원격 tag 삭제를 수행한다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param tag 삭제할 태그 이름
 */
export async function deleteRemoteTag(
  deps: GraphTagActionDeps,
  tag: string,
  remoteName?: string
): Promise<void> {
  const remote = remoteName ?? (await pickRemote(deps));
  if (
    !remote ||
    !(await confirm(
      vscode.l10n.t("Delete remote tag '{0}' from '{1}'?", tag, remote),
      vscode.l10n.t("Delete")
    ))
  ) {
    return;
  }
  await deps.logService.deleteRemoteTag(remote, tag);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Remote tag '{0}' deleted.", tag)
  );
}

/**
 * tag 를 원격 저장소로 push 한다. tag 를 넘기지 않으면 목록에서 고른다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param tagName 바로 push 할 태그 이름. 없으면 QuickPick 으로 선택한다.
 */
export async function pushTag(
  deps: GraphTagActionDeps,
  tagName?: string
): Promise<void> {
  const tag = tagName ?? (await pickTag(deps));
  const remote = tag ? await pickRemote(deps) : undefined;
  if (!tag || !remote) {
    return;
  }
  await deps.logService.pushTag(remote, tag);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(vscode.l10n.t("Tag '{0}' pushed.", tag));
}

/**
 * 로컬 tag 이름을 변경한다.
 * - 원격 tag 는 git 프로토콜상 rename 이 없어 로컬 tag 만 바꾸고 원격은 별도 push/delete 액션으로 처리한다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param tag 기존 로컬 tag 이름
 * @param knownStatus 이미 조회해 둔 tag 상태. 없으면 내부에서 다시 조회한다.
 */
export async function renameTag(
  deps: GraphTagActionDeps,
  tag: string,
  knownStatus?: GitTagStatus
): Promise<void> {
  const status = knownStatus ?? (await tagStatus(deps, tag));
  if (!status?.localHash) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Only local tags can be renamed.")
    );
    return;
  }
  const nextName = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Rename tag '{0}'", tag),
    value: tag,
    validateInput: (value) =>
      value.trim() ? undefined : vscode.l10n.t("Tag name is required."),
  });
  if (!nextName || nextName.trim() === tag) {
    return;
  }
  await new GitTagService(deps.logService.repoRoot).renameLocalTag(tag, nextName.trim());
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Tag '{0}' renamed to '{1}'.", tag, nextName.trim())
  );
  if (status.remoteTargets.length > 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("Remote tags are unchanged. Push the new tag and delete the old remote tag if needed.")
    );
  }
}

/**
 * 태그 이름을 클립보드에 복사한다.
 * @param tag 복사할 태그 이름
 */
export async function copyTagName(tag: string): Promise<void> {
  await vscode.env.clipboard.writeText(tag);
  vscode.window.showInformationMessage(vscode.l10n.t("Tag name copied."));
}

/**
 * tag 목록에서 작업 대상을 고른다.
 * @param deps graph 패널이 제공하는 git service
 * @returns 사용자가 고른 태그 이름. 취소하면 undefined.
 */
async function pickTag(deps: GraphTagActionDeps): Promise<string | undefined> {
  const tags = await deps.logService.getTags();
  return vscode.window.showQuickPick(tags, {
    placeHolder: vscode.l10n.t("Select a tag"),
  });
}

/**
 * 원격 저장소 목록에서 작업 대상을 고른다.
 * @param deps graph 패널이 제공하는 git service
 * @returns 사용자가 고른 remote 이름. 취소하거나 remote 가 없으면 undefined.
 */
async function pickRemote(deps: GraphTagActionDeps): Promise<string | undefined> {
  const remotes = await deps.logService.getRemotes();
  if (remotes.length === 0) {
    vscode.window.showWarningMessage(vscode.l10n.t("No git remote found."));
    return undefined;
  }
  return remotes.length === 1
    ? remotes[0]
    : vscode.window.showQuickPick(remotes, {
        placeHolder: vscode.l10n.t("Select a remote"),
      });
}

/**
 * tag 의 로컬/원격 상태를 조회한다.
 * @param deps graph 패널이 제공하는 git service
 * @param tag 조회할 tag 이름
 */
async function tagStatus(
  deps: GraphTagActionDeps,
  tag: string
): Promise<GitTagStatus | undefined> {
  return (await new GitTagService(deps.logService.repoRoot).getTagStatuses()).find(
    (item) => item.name === tag
  );
}

/**
 * 확인이 필요한 파괴적/상태 변경 작업을 모달로 확인한다.
 * @param message 사용자에게 보여줄 확인 문구
 * @param label 확인 버튼 라벨
 * @returns 사용자가 확인 버튼을 눌렀으면 true
 */
async function confirm(message: string, label: string): Promise<boolean> {
  return (
    (await vscode.window.showWarningMessage(message, { modal: true }, label)) ===
    label
  );
}
