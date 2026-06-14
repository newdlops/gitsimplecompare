// 특정 ref 시점의 파일 내용을 "읽기 전용 가상 문서"로 제공하는 프로바이더.
// - vscode.diff 의 한쪽(브랜치 버전)으로 쓰인다. 가상 문서이므로 자동으로 편집 불가.
// - URI 에 담긴 ref/repoRoot/path 를 해석해 GitService 로 내용을 읽어 반환한다.
import * as vscode from "vscode";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { logInfo } from "../ui/outputLog";
import { parseRefUri } from "../utils/uri";

const changeEmitter = new vscode.EventEmitter<vscode.Uri>();
const contentCache = new Map<string, Promise<string>>();
const knownUris = new Map<string, vscode.Uri>();

/** provider 캐시에 사용할 ref/path 키를 만든다. nonce 는 재사용 방해 요소라 제외한다. */
function cacheKey(ref: string, repoRoot: string, path: string): string {
  return `${repoRoot}\0${ref}\0${path}`;
}

/**
 * 가상 ref 문서의 내용을 다시 읽도록 VS Code 에 알린다.
 * - `:0`, `:unstaged` 처럼 index/working tree 에 따라 변하는 문서는 stable URI 를 유지하되
 *   이 이벤트로 열린 diff 탭의 내용을 갱신한다.
 * @param uri 갱신할 가상 문서 URI
 */
export function refreshBranchContent(uri: vscode.Uri): void {
  const { ref, repoRoot, path } = parseRefUri(uri);
  if (ref && repoRoot) {
    contentCache.delete(cacheKey(ref, repoRoot, path));
  }
  changeEmitter.fire(uri);
}

/** git ref/index 변경처럼 모든 가상 문서 내용이 바뀔 수 있는 이벤트에서 캐시를 비운다. */
export function clearBranchContentCache(): void {
  contentCache.clear();
  for (const uri of knownUris.values()) {
    changeEmitter.fire(uri);
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
    knownUris.set(key, uri);
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
