// production 빌드와 격리 source benchmark가 동일한 browser compiler 옵션을 사용한다.
import path from "node:path";

/** @param root source 루트 @param production 배포용 minify 여부 @returns Node API를 포함하지 않는 Graph browser 빌드 옵션. */
export function graphBrowserBuildOptions(root, production = true) {
  return { entryPoints: [path.join(root, "media/graph/graphEntry.js")], bundle: true,
    platform: "browser", format: "iife", target: "es2020", outfile: path.join(root, "media/bundled/graph.js"),
    minify: production, sourcemap: !production, logLevel: "silent" };
}
