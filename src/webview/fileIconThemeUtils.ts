// 파일 아이콘 테마 해석에 필요한 순수 유틸리티.
// - VS Code API 에 의존하지 않는 문자열/경로 보조 함수만 둔다.
import * as path from "path";

/** 저장소 경로만 있는 웹뷰 상황에서 흔한 파일 확장자를 VS Code language id 로 추정한다. */
export function inferLanguageId(fileName: string): string | undefined {
  const name = fileName.toLowerCase();
  if (name === "dockerfile" || name.endsWith(".dockerfile")) {
    return "dockerfile";
  }
  if (name === "makefile" || name === "cmakelists.txt") {
    return "makefile";
  }
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
  switch (ext) {
    case "ts":
      return "typescript";
    case "tsx":
      return "typescriptreact";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "javascriptreact";
    case "json":
      return "json";
    case "jsonc":
      return "jsonc";
    case "md":
    case "markdown":
      return "markdown";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "html":
    case "htm":
      return "html";
    case "py":
    case "pyw":
      return "python";
    case "yml":
    case "yaml":
      return "yaml";
    case "xml":
      return "xml";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return "shellscript";
    case "ps1":
      return "powershell";
    case "sql":
      return "sql";
    case "java":
      return "java";
    case "c":
      return "c";
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hxx":
      return "cpp";
    case "cs":
      return "csharp";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "rb":
      return "ruby";
    case "php":
      return "php";
    case "swift":
      return "swift";
    case "kt":
    case "kts":
      return "kotlin";
    case "vue":
      return "vue";
    case "svelte":
      return "svelte";
    default:
      return undefined;
  }
}

/** `lib.d.ts` 같은 파일이 `d.ts`, `.d.ts`, `ts`, `.ts` 순서로 매칭되도록 후보를 만든다. */
export function extensionCandidates(fileName: string): string[] {
  const out: string[] = [];
  for (let idx = fileName.indexOf("."); idx >= 0; idx = fileName.indexOf(".", idx + 1)) {
    if (idx > 0 && idx < fileName.length - 1) {
      out.push(fileName.slice(idx + 1));
      out.push(fileName.slice(idx));
    }
  }
  return out;
}

/** JSONC 의 주석과 trailing comma 를 제거해 JSON.parse 가 처리할 수 있게 한다. */
export function stripJsonc(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") {
        i++;
      }
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i++;
      }
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

/** icon 파일 확장자에 맞는 MIME 타입을 반환한다. */
export function mimeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** 글꼴 파일 확장자/format 에 맞는 MIME 타입을 반환한다. */
export function fontMimeFor(filePath: string, format: string | undefined): string {
  const normalized = (format ?? path.extname(filePath).slice(1)).toLowerCase();
  switch (normalized) {
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "truetype":
    case "ttf":
      return "font/ttf";
    case "opentype":
    case "otf":
      return "font/otf";
    default:
      return "application/octet-stream";
  }
}

/** 문자열에서 CSS font-family 에 쓰기 쉬운 짧은 해시를 만든다. */
export function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** unknown 값이 객체 레코드인지 확인한다. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
