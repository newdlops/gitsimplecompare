// 특정 ref 시점의 파일 내용을 "읽기 전용 가상 문서"로 제공하는 프로바이더.
// - vscode.diff 의 한쪽(브랜치 버전)으로 쓰인다. 가상 문서이므로 자동으로 편집 불가.
// - URI 에 담긴 ref/repoRoot/path 를 해석해 GitService 로 내용을 읽어 반환한다.
import * as vscode from "vscode";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { parseRefUri } from "../utils/uri";

/**
 * COMPARE_SCHEME URI 에 대해 git ref 의 파일 내용을 돌려주는 프로바이더.
 * - 내용은 ref 시점 스냅샷이라 변하지 않으므로 별도 무효화(onDidChange)는 두지 않는다.
 */
export class BranchContentProvider
  implements vscode.TextDocumentContentProvider
{
  constructor(private readonly registry: GitServiceRegistry) {}

  /**
   * 가상 문서 URI 에 해당하는 텍스트 내용을 제공한다.
   * - URI 를 해석해 어떤 저장소의 어떤 ref/파일인지 알아낸 뒤 git 에서 읽는다.
   * - 해당 ref 에 파일이 없으면 GitService 가 빈 문자열을 주므로 빈 문서로 표시된다.
   * @param uri makeRefUri 로 생성된 가상 문서 URI
   * @returns 파일 내용 문자열
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { ref, repoRoot, path } = parseRefUri(uri);
    if (!ref || !repoRoot) {
      return "";
    }
    const service = this.registry.get(repoRoot);
    // path 는 항상 "/" 로 시작하므로 앞 슬래시를 떼어 저장소 상대 경로로 만든다.
    const relative = path.replace(/^\//, "");
    return service.getFileContentAtRef(ref, relative);
  }
}
