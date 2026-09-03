/** Node 단위 테스트가 OUTPUT·외부 URL 경로를 실행할 때만 쓰는 최소 VS Code API 대역이다. */
export const __outputLines: string[] = [];
export const __externalUris: unknown[] = [];
export const __warningMessages: string[] = [];
export const __errorMessages: string[] = [];
export const __informationMessages: string[] = [];
export const __clipboardWrites: string[] = [];
export const __executedCommands: Array<{ id: string; args: unknown[] }> = [];
export const __quickPickItems: unknown[][] = [];
let externalResult: boolean | Error = true;
let warningMessageResult: string | undefined;
let informationMessageResult: string | undefined;
let quickPickResult: unknown | ((items: readonly unknown[]) => unknown);

/** 테스트마다 이전 OUTPUT 기록을 비운다. */
export function __resetOutputLines(): void { __outputLines.length = 0; }
/** 테스트마다 외부 URL 호출과 사용자 메시지 기록을 비우고 성공 결과로 복원한다. */
export function __resetWindowMessages(): void {
  __externalUris.length = 0;
  __warningMessages.length = 0;
  __errorMessages.length = 0;
  __informationMessages.length = 0;
  __clipboardWrites.length = 0;
  __executedCommands.length = 0;
  __quickPickItems.length = 0;
  externalResult = true;
  warningMessageResult = undefined;
  informationMessageResult = undefined;
  quickPickResult = undefined;
}
/** openExternal의 성공·거부·예외 경로를 테스트가 명시적으로 선택하게 한다. */
export function __setOpenExternalResult(result: boolean | Error): void { externalResult = result; }
/** warning 알림에서 테스트 사용자가 누를 액션 라벨을 지정한다. */
export function __setWarningMessageResult(result: string | undefined): void { warningMessageResult = result; }
/** information 알림에서 테스트 사용자가 누를 액션 라벨을 지정한다. */
export function __setInformationMessageResult(result: string | undefined): void { informationMessageResult = result; }
/** Quick Pick 결과 또는 전달된 항목으로 결과를 만드는 선택 함수를 지정한다. */
export function __setQuickPickResult(result: unknown | ((items: readonly unknown[]) => unknown)): void { quickPickResult = result; }

export const window = {
  visibleTextEditors: [] as any[],
  createOutputChannel: () => ({
    append(value: string) { __outputLines.push(value); },
    appendLine(value: string) { __outputLines.push(value); },
    show() {}, dispose() {},
  }),
  createTextEditorDecorationType: () => ({ dispose() {} }),
  onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
  showTextDocument: async (document: unknown) => ({
    document,
    setDecorations() {},
    revealRange() {},
  }),
  showWarningMessage(message: string) { __warningMessages.push(message); return Promise.resolve(warningMessageResult); },
  showErrorMessage(message: string) { __errorMessages.push(message); return Promise.resolve(undefined); },
  showInformationMessage(message: string) { __informationMessages.push(message); return Promise.resolve(informationMessageResult); },
  showQuickPick: async (items: readonly unknown[]) => {
    __quickPickItems.push([...items]);
    return typeof quickPickResult === "function" ? quickPickResult(items) : quickPickResult;
  },
  withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
    task(
      { report() {} },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
    ),
};
export const l10n = { t: (value: string, ...values: unknown[]) => value.replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? "")) };
export class EventEmitter<T = unknown> { public event = () => ({ dispose() {} }); public fire(_value: T) {} public dispose() {} }
export const Uri = { file: (fsPath: string) => ({ fsPath, path: fsPath, scheme: "file", toString: () => fsPath }), parse: (value: string) => ({ toString: () => value }), from: (value: unknown) => value, joinPath: (...parts: any[]) => parts.at(-1) };
export const commands = { executeCommand: async (id: string, ...args: unknown[]) => { __executedCommands.push({ id, args }); } }; export const workspace = { isTrusted: true, getConfiguration: () => ({ get: () => false }), openTextDocument: async () => ({}) };
export const ViewColumn = { Active: 1 };
export const ProgressLocation = { Notification: 15 };
export const env = { remoteName: undefined as string | undefined, openExternal: async (uri: unknown) => { __externalUris.push(uri); if (externalResult instanceof Error) throw externalResult; return externalResult; }, clipboard: { writeText: async (value: string) => { __clipboardWrites.push(value); } } };
export class Range { public readonly values: unknown[]; public constructor(...values: unknown[]) { this.values = values; } } export class MarkdownString { public readonly value: unknown; public constructor(value: unknown) { this.value = value; } }
export class ThemeColor { public constructor(..._values: unknown[]) {} } export const OverviewRulerLane = { Right: 1 }; export const DecorationRangeBehavior = { ClosedClosed: 1 }; export const TextEditorRevealType = { InCenterIfOutsideViewport: 1 }; export const comments = { createCommentController: () => ({ dispose() {} }) }; export const CommentThreadCollapsibleState = { Collapsed: 1 }; export const CommentMode = { Preview: 1 }; export const EndOfLine = { CRLF: 1 }; export class WorkspaceEdit { public replace(..._values: unknown[]) {} }
