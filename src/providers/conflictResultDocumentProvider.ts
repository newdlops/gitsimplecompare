// native conflict TextEditor가 읽고 저장할 전용 URI provider.
// - text Result는 FileSystemProvider save를 host의 no-follow CAS에 위임하고 특수 파일은 readonly content로 연다.
import * as vscode from "vscode";

/** provider가 파일 상태와 내용을 읽는 데 필요한 session 최소 view다. */
export interface ConflictResultResource {
  readonly uri: vscode.Uri;
  readonly readOnly: boolean;
  content: string;
  ctime: number;
  mtime: number;
}

/** session 소유권 검증과 실제 CAS 저장을 controller에 위임하는 계약이다. */
export interface ConflictResultResourceHost {
  /** URI가 현재 session에 속하면 resource를 반환한다. */
  resourceForUri(uri: vscode.Uri): ConflictResultResource | undefined;
  /** 현재 resource인지 다시 검증한 뒤 UTF-8 Result를 안전하게 저장한다. */
  writeResource(resource: ConflictResultResource, content: string): Promise<void>;
}

/** editable text Result용 VS Code FileSystemProvider다. */
export class ConflictResultFileSystemProvider implements vscode.FileSystemProvider {
  private readonly changeEmitter =
    new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  readonly onDidChangeFile = this.changeEmitter.event;

  constructor(private readonly host: ConflictResultResourceHost) {}

  /** VS Code watcher 수명주기를 만족하며 실제 감시는 controller refresh 이벤트가 담당한다. */
  watch(
    _uri: vscode.Uri,
    _options: { readonly recursive: boolean; readonly excludes: readonly string[] }
  ): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  /** session content 길이와 갱신 시각을 native editor에 제공한다. */
  stat(uri: vscode.Uri): vscode.FileStat {
    const resource = this.required(uri);
    return {
      type: vscode.FileType.File,
      ctime: resource.ctime,
      mtime: resource.mtime,
      size: Buffer.byteLength(resource.content, "utf8"),
    };
  }

  /** native Monaco가 열 전체 UTF-8 Result를 반환한다. */
  readFile(uri: vscode.Uri): Uint8Array {
    return Buffer.from(this.required(uri).content, "utf8");
  }

  /** native Save bytes를 controller의 no-follow/CAS 저장 경로로 전달한다. */
  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const resource = this.required(uri);
    if (resource.readOnly) {
      throw vscode.FileSystemError.NoPermissions(
        vscode.l10n.t("This conflict Result is read-only.")
      );
    }
    await this.host.writeResource(
      resource,
      Buffer.from(content).toString("utf8")
    );
  }

  /** editor가 직접 생성할 수 있는 디렉터리 구조가 아니므로 빈 목록만 반환한다. */
  readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
    return [];
  }

  /** conflict session URI에서는 임의 디렉터리 생성을 거부한다. */
  createDirectory(_uri: vscode.Uri): void {
    throw noPermissions();
  }

  /** conflict session URI 자체 삭제를 거부한다. */
  delete(
    _uri: vscode.Uri,
    _options: { readonly recursive: boolean }
  ): void {
    throw noPermissions();
  }

  /** conflict session URI 이동/이름 변경을 거부한다. */
  rename(
    _oldUri: vscode.Uri,
    _newUri: vscode.Uri,
    _options: { readonly overwrite: boolean }
  ): void {
    throw noPermissions();
  }

  /** host content가 바뀌었음을 native editor에 알려 clean buffer를 다시 읽게 한다. */
  fireChanged(uri: vscode.Uri): void {
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  /** provider event emitter를 확장 비활성화 시 정리한다. */
  dispose(): void {
    this.changeEmitter.dispose();
  }

  /** URI가 현재 editable resource인지 확인하고 없으면 FileNotFound를 던진다. */
  private required(uri: vscode.Uri): ConflictResultResource {
    const resource = this.host.resourceForUri(uri);
    if (!resource) throw vscode.FileSystemError.FileNotFound(uri);
    return resource;
  }
}

/** binary/symlink/absent/nonfile Result를 native readonly 문서로 제공한다. */
export class ConflictReadonlyContentProvider
implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly host: ConflictResultResourceHost) {}

  /** 특수 Result를 편집 가능한 바이트로 노출하지 않고 판단용 plaintext만 반환한다. */
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.host.resourceForUri(uri)?.content ??
      vscode.l10n.t("This conflict editor session is no longer available.");
  }

  /** operation/source context가 바뀌면 readonly native 문서를 다시 읽게 한다. */
  fireChanged(uri: vscode.Uri): void {
    this.changeEmitter.fire(uri);
  }

  /** readonly provider event emitter를 정리한다. */
  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** 쓰기/이름 변경 같은 지원하지 않는 URI mutation 오류를 통일한다. */
function noPermissions(): vscode.FileSystemError {
  return vscode.FileSystemError.NoPermissions(
    vscode.l10n.t("Conflict Result resources cannot be created, deleted, or renamed.")
  );
}
