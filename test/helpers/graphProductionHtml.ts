import { createRequire } from "node:module";
import path from "node:path";

let builder: Promise<(surface: unknown, extension: unknown) => string> | undefined;

/**
 * Playwright의 Node 환경에도 같은 HTML builder를 사용하도록 VS Code 경계만 별도 bundle로 주입한다.
 * @returns production HTML 조립 함수. 신뢰하는 저장소 source를 한 번 컴파일하며 측정 구간 전에 끝낸다.
 */
export function productionHtmlBuilder() {
  if (!builder) builder = (async () => {
    const root = process.cwd(), requireFixture = createRequire(path.join(process.env.GSC_BENCH_WORKSPACE_ROOT || root, "package.json"));
    const result = await requireFixture("esbuild").build({ entryPoints: [path.join(root, "src/webview/graphHtml.ts")],
      bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
      alias: { vscode: path.join(root, "test/helpers/graphHtmlVscode.ts") } });
    const compiled = { exports: {} as any };
    // 저장소의 HTML builder만 실행한다. 사용자 입력이나 외부 응답을 코드로 평가하지 않는다.
    new Function("module", "exports", "require", result.outputFiles[0].text)(compiled, compiled.exports, requireFixture);
    return compiled.exports.buildGraphHtml as (surface: unknown, extension: unknown) => string;
  })();
  return builder;
}
