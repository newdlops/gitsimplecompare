import path from "node:path";
import { lifecycleResourceUri } from "./graphLifecycleSurface";
export { l10n, env } from "./vscodeMock";

/** HTML 조립에서만 쓰는 Uri.joinPath를 실제 파일 경로·query를 보존하는 transport 대역으로 제공한다. */
export const Uri = { joinPath: (base: { fsPath: string }, ...parts: string[]) => lifecycleResourceUri(path.join(base.fsPath, ...parts)) };
