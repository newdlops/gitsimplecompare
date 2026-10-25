// esbuild 번들 스크립트
// - 확장 호스트 CommonJS와 Graph browser 자산을 각각의 실행 환경에 맞게 번들한다.
// - `vscode` 모듈은 런타임에서 호스트가 주입하므로 external 처리한다.
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** 두 실행 환경의 빌드/감시를 함께 준비한다. 배포 빌드는 둘 다 성공해야 완료된다. */
async function main() {
  const { graphBrowserBuildOptions } = await import("./scripts/browser-bundle.mjs");
  const contexts = await Promise.all([esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "info",
  }), esbuild.context({ ...graphBrowserBuildOptions(process.cwd(), production), logLevel: "info" })]);

  try {
    // F5가 첫 watch 완료 직후 열려도 browser 자산이 준비돼 있어야 한다.
    await Promise.all(contexts.map(ctx => ctx.rebuild()));
    if (watch) await Promise.all(contexts.map(ctx => ctx.watch()));
  } finally {
    if (!watch) await Promise.all(contexts.map(ctx => ctx.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
