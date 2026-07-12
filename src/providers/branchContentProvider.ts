// 특정 ref 시점의 파일 내용을 "읽기 전용 가상 문서"로 제공하는 프로바이더.
// - vscode.diff 의 한쪽(브랜치 버전)으로 쓰인다. 가상 문서이므로 자동으로 편집 불가.
// - URI 에 담긴 ref/repoRoot/path 를 해석해 GitService 로 내용을 읽어 반환한다.
import * as vscode from "vscode";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { logInfo } from "../ui/outputLog";
import { parseRefUri } from "../utils/uri";

const changeEmitter = new vscode.EventEmitter<vscode.Uri>();
const contentCache = new Map<string, Promise<string>>();
const knownUris = new Map<string, Map<string, vscode.Uri>>();
const INDEX_DEPENDENT_REFS = [":0", ":unstaged"];

/** provider 캐시에 사용할 ref/path 키를 만든다. nonce 는 재사용 방해 요소라 제외한다. */
function cacheKey(ref: string, repoRoot: string, path: string): string {
  return `${repoRoot}\0${ref}\0${path}`;
}

/** 저장소 상대 경로를 provider 캐시의 URI path 형태로 맞춘다. */
function cachePath(relPath: string): string {
  return relPath.startsWith("/") ? relPath : `/${relPath}`;
}

/**
 * 같은 ref/path 내용을 공유하면서 fragment 등 identity가 다른 가상 문서를 모두 기억한다.
 * - 일반 diff 문서와 삭제 미리보기가 동시에 열려도 캐시는 하나만 쓰고 갱신 이벤트는 각각 보낸다.
 * @param key repoRoot/ref/path로 만든 내용 캐시 키
 * @param uri VS Code가 실제로 연 가상 문서 URI
 */
function rememberKnownUri(key: string, uri: vscode.Uri): void {
  let identities = knownUris.get(key);
  if (!identities) {
    identities = new Map<string, vscode.Uri>();
    knownUris.set(key, identities);
  }
  identities.set(uri.toString(), uri);
}

/**
 * 하나의 내용 캐시 키를 공유하는 모든 열린 URI identity에 변경 이벤트를 보낸다.
 * @param key repoRoot/ref/path로 만든 내용 캐시 키
 * @returns 이벤트를 받은 URI가 하나 이상이면 true
 */
function fireKnownUris(key: string): boolean {
  const identities = knownUris.get(key);
  if (!identities?.size) {
    return false;
  }
  for (const uri of identities.values()) {
    changeEmitter.fire(uri);
  }
  return true;
}

/**
 * 가상 ref 문서의 내용을 다시 읽도록 VS Code 에 알린다.
 * - `:0`, `:unstaged` 처럼 index/working tree 에 따라 변하는 문서는 stable URI 를 유지하되
 *   이 이벤트로 열린 diff 탭의 내용을 갱신한다.
 * - 같은 내용을 공유하는 일반 diff/삭제 미리보기 URI가 있으면 모두 함께 갱신한다.
 * @param uri 갱신할 ref/repoRoot/path를 식별하는 가상 문서 URI
 */
export function refreshBranchContent(uri: vscode.Uri): void {
  const { ref, repoRoot, path } = parseRefUri(uri);
  if (ref && repoRoot) {
    const key = cacheKey(ref, repoRoot, path);
    rememberKnownUri(key, uri);
    contentCache.delete(key);
    fireKnownUris(key);
    return;
  }
  changeEmitter.fire(uri);
}

/**
 * index 변경에 의존하는 같은 파일의 열린 가상 문서를 모두 갱신한다.
 * - line stage/unstage 는 `:0` 과 `:unstaged` 를 동시에 바꾸므로,
 *   active diff 밖에 열린 staged/unstaged 탭도 stale cache 를 비우고 onDidChange 를 보내야 한다.
 * @param repoRoot 저장소 루트
 * @param relPath 저장소 상대 파일 경로
 * @returns 실제 onDidChange 를 보낸 ref 목록
 */
export function refreshIndexDependentBranchContent(
  repoRoot: string,
  relPath: string
): string[] {
  const refreshed: string[] = [];
  const path = cachePath(relPath);
  for (const ref of INDEX_DEPENDENT_REFS) {
    const key = cacheKey(ref, repoRoot, path);
    contentCache.delete(key);
    if (!fireKnownUris(key)) {
      continue;
    }
    refreshed.push(ref);
  }
  if (refreshed.length) {
    logInfo("branch index-dependent content refreshed", {
      path: relPath,
      refs: refreshed,
    });
  }
  return refreshed;
}

/** git ref/index 변경처럼 모든 가상 문서 내용이 바뀔 수 있는 이벤트에서 캐시를 비운다. */
export function clearBranchContentCache(): void {
  contentCache.clear();
  for (const identities of knownUris.values()) {
    for (const uri of identities.values()) {
      changeEmitter.fire(uri);
    }
  }
}

/**
 * COMPARE_SCHEME URI 에 대해 git ref 의 파일 내용을 돌려주는 프로바이더.
 * - 브랜치 ref 는 스냅샷이지만 index/unstaged 가상 ref 는 변하므로 onDidChange 를 노출한다.
 */
export class BranchContentProvider
  implements vscode.TextDocumentContentProvider
{
  readonly onDidChange = changeEmitter.event;

  constructor(private readonly registry: GitServiceRegistry) {}

  /**
   * 가상 문서 URI 에 해당하는 텍스트 내용을 제공한다.
   * - URI 를 해석해 어떤 저장소의 어떤 ref/파일인지 알아낸 뒤 git 에서 읽는다.
   * - 해당 ref 에 파일이 없으면 GitService 가 빈 문자열을 주므로 빈 문서로 표시된다.
   * @param uri makeRefUri 로 생성된 가상 문서 URI
   * @returns 파일 내용 문자열
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const started = Date.now();
    const { ref, repoRoot, path } = parseRefUri(uri);
    if (!ref || !repoRoot) {
      return "";
    }
    const service = this.registry.get(repoRoot);
    // path 는 항상 "/" 로 시작하므로 앞 슬래시를 떼어 저장소 상대 경로로 만든다.
    const relative = path.replace(/^\//, "");
    const key = cacheKey(ref, repoRoot, path);
    rememberKnownUri(key, uri);
    const cached = contentCache.get(key);
    const promise =
      cached ??
      (ref === ":unstaged"
        ? service.getWorkingContentWithoutStaged(relative)
        : service.getFileContentAtRef(ref, relative));
    if (!cached) {
      contentCache.set(key, promise);
    }
    const content = await promise.catch((error) => {
      contentCache.delete(key);
      throw error;
    });
    logInfo("branch content provided", {
      ref,
      path: relative,
      elapsed: Date.now() - started,
      chars: content.length,
      cached: !!cached,
    });
    return content;
  }
}
