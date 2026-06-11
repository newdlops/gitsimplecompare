// VS Code 파일 아이콘 테마를 웹뷰에서 쓸 수 있는 이미지 URI로 해석하는 모듈.
// - 웹뷰는 워크벤치의 파일 아이콘 CSS를 직접 상속받지 못하므로, 현재
//   workbench.iconTheme 의 JSON 정의를 읽어 이미지 기반 아이콘만 data URI 로 전달한다.
// - 글꼴 glyph 기반 아이콘은 웹뷰 재현 비용이 크므로 기존 codicon fallback 에 맡긴다.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  extensionCandidates,
  fontMimeFor,
  hashText,
  inferLanguageId,
  isRecord,
  mimeFor,
  stripJsonc,
} from "./fileIconThemeUtils";

/** 웹뷰가 렌더링할 수 있는 파일 아이콘 표현. */
export type FileIconView =
  | { kind: "image"; uri: string }
  | { kind: "glyph"; text: string; fontFamily: string; color?: string; size?: string }
  | { kind: "codicon"; codicon: string };

/** 웹뷰가 FontFace API 로 등록할 파일 아이콘 글꼴. */
export interface FileIconFontView {
  family: string;
  uri: string;
  weight?: string;
  style?: string;
}

/** 웹뷰로 전달하는 파일 아이콘 전체 payload. */
export interface FileIconPayload {
  icons: Record<string, FileIconView>;
  fonts: FileIconFontView[];
}

/** VS Code icon theme 기여 정보(package.json contributes.iconThemes 항목). */
interface IconThemeContribution {
  id?: string;
  path?: string;
}

/** icon theme JSON 의 아이콘 정의. */
interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
  sourceFilePath?: string;
}

/** icon theme JSON 의 글꼴 정의. */
interface FontDefinition {
  id?: string;
  src?: FontSource[];
  weight?: string;
  style?: string;
  size?: string;
  sourceFilePath?: string;
}

/** 글꼴 정의의 실제 파일 경로와 형식. */
interface FontSource {
  path?: string;
  format?: string;
}

/** 파일/폴더 연결 규칙. 필요한 파일 연결 규칙만 모델링한다. */
interface FileAssociations {
  file?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
}

/** icon theme JSON 중 파일 아이콘 해석에 필요한 필드. */
interface IconThemeDocument extends FileAssociations {
  extends?: string;
  iconDefinitions?: Record<string, IconDefinition>;
  fonts?: FontDefinition[];
  light?: FileAssociations;
  highContrast?: FileAssociations;
}

/** 파싱해 둔 icon theme 문서와 기준 경로. */
interface LoadedIconTheme {
  filePath: string;
  document: IconThemeDocument;
}

/** 특정 파일 경로가 사용할 이미지 기반 아이콘. */
interface ResolvedIcon {
  filePath: string;
  definition: IconDefinition;
}

/**
 * 현재 VS Code 파일 아이콘 테마를 읽어 파일별 웹뷰 아이콘을 만든다.
 * - 테마 파일/아이콘 파일은 캐시해 렌더 때 반복 IO 를 줄인다.
 * - 테마가 바뀌면 설정 id 또는 컬러 테마 kind 변경을 감지해 다시 로드한다.
 */
export class FileIconThemeResolver {
  private cacheKey = "";
  private theme?: LoadedIconTheme;
  private readonly imageCache = new Map<string, string>();
  private readonly fontCache = new Map<string, string>();
  private usedFonts = new Map<string, FileIconFontView>();

  /**
   * 여러 파일 경로에 대한 아이콘 payload 를 만든다.
   * @param paths 저장소 기준 상대 파일 경로 목록
   * @returns 경로별 아이콘 표현. 해석 실패한 경로는 codicon fallback 을 넣는다.
   */
  payloadFor(paths: string[]): FileIconPayload {
    this.ensureTheme();
    this.usedFonts = new Map();
    const out: Record<string, FileIconView> = {};
    const unique = new Set(paths);
    for (const filePath of unique) {
      const icon = this.iconFor(filePath);
      if (icon) {
        out[filePath] = icon;
      }
    }
    return { icons: out, fonts: [...this.usedFonts.values()] };
  }

  /** 현재 설정/색상 테마 기준으로 캐시가 유효한지 확인하고 필요하면 테마를 다시 읽는다. */
  private ensureTheme(): void {
    const id = currentIconThemeId();
    const key = `${id}:${vscode.window.activeColorTheme.kind}`;
    if (key === this.cacheKey) {
      return;
    }
    this.cacheKey = key;
    this.imageCache.clear();
    this.fontCache.clear();
    this.theme = id ? loadThemeById(id) : undefined;
  }

  /**
   * 파일 하나에 대한 아이콘을 해석한다.
   * @param resourcePath 저장소 기준 상대 파일 경로
   */
  private iconFor(resourcePath: string): FileIconView | undefined {
    if (!this.theme) {
      return undefined;
    }
    const resolved = resolveIcon(this.theme, resourcePath);
    if (!resolved?.definition.iconPath) {
      return this.glyphIconFor(resolved?.definition);
    }
    const iconPath = path.resolve(
      path.dirname(resolved.filePath),
      resolved.definition.iconPath
    );
    const uri = this.dataUriFor(iconPath);
    return uri ? { kind: "image", uri } : undefined;
  }

  /**
   * glyph 기반 icon definition 을 웹뷰용 글꼴+문자로 변환한다.
   * @param definition icon theme 의 glyph 정의
   */
  private glyphIconFor(definition: IconDefinition | undefined): FileIconView | undefined {
    if (!this.theme || !definition?.fontCharacter) {
      return undefined;
    }
    const font = fontForDefinition(this.theme.document, definition);
    if (!font) {
      return undefined;
    }
    const fontUri = this.fontUriFor(font);
    if (!fontUri) {
      return undefined;
    }
    const fontFamily = `gsc-file-icon-${hashText(
      `${font.sourceFilePath ?? ""}:${font.id ?? ""}`
    )}`;
    this.usedFonts.set(fontFamily, {
      family: fontFamily,
      uri: fontUri,
      weight: font.weight,
      style: font.style,
    });
    return {
      kind: "glyph",
      text: glyphText(definition.fontCharacter),
      fontFamily,
      color: definition.fontColor,
      size: definition.fontSize ?? font.size,
    };
  }

  /**
   * 이미지 파일을 data URI 로 읽는다.
   * @param iconPath icon theme JSON 기준으로 해석된 실제 이미지 경로
   */
  private dataUriFor(iconPath: string): string | undefined {
    const cached = this.imageCache.get(iconPath);
    if (cached !== undefined) {
      return cached || undefined;
    }
    try {
      const data = fs.readFileSync(iconPath);
      const mime = mimeFor(iconPath);
      const uri = `data:${mime};base64,${data.toString("base64")}`;
      this.imageCache.set(iconPath, uri);
      return uri;
    } catch {
      this.imageCache.set(iconPath, "");
      return undefined;
    }
  }

  /**
   * 글꼴 파일을 data URI 로 읽는다.
   * @param font icon theme 의 글꼴 정의
   */
  private fontUriFor(font: FontDefinition): string | undefined {
    const source = font.src?.find((item) => item.path);
    if (!source?.path || !font.sourceFilePath) {
      return undefined;
    }
    const fontPath = path.resolve(path.dirname(font.sourceFilePath), source.path);
    const cached = this.fontCache.get(fontPath);
    if (cached !== undefined) {
      return cached || undefined;
    }
    try {
      const data = fs.readFileSync(fontPath);
      const mime = fontMimeFor(fontPath, source.format);
      const uri = `data:${mime};base64,${data.toString("base64")}`;
      this.fontCache.set(fontPath, uri);
      return uri;
    } catch {
      this.fontCache.set(fontPath, "");
      return undefined;
    }
  }
}

/** 현재 사용 중인 VS Code 파일 아이콘 테마 id 를 읽는다. */
function currentIconThemeId(): string | undefined {
  const value = vscode.workspace
    .getConfiguration("workbench")
    .get<string>("iconTheme");
  return value || undefined;
}

/**
 * 확장 기여 목록에서 icon theme id 에 해당하는 JSON 파일을 찾아 읽는다.
 * @param id workbench.iconTheme 설정값
 */
function loadThemeById(id: string): LoadedIconTheme | undefined {
  for (const extension of vscode.extensions.all) {
    const contributions = iconThemeContributions(extension.packageJSON);
    const contribution = contributions.find((item) => item.id === id);
    if (!contribution?.path) {
      continue;
    }
    const themePath = path.resolve(extension.extensionPath, contribution.path);
    return loadTheme(themePath, new Set());
  }
  return undefined;
}

/**
 * package.json 에서 contributes.iconThemes 배열을 안전하게 뽑는다.
 * @param packageJson 확장 package.json 객체
 */
function iconThemeContributions(packageJson: unknown): IconThemeContribution[] {
  if (!isRecord(packageJson)) {
    return [];
  }
  const contributes = packageJson.contributes;
  if (!isRecord(contributes) || !Array.isArray(contributes.iconThemes)) {
    return [];
  }
  return contributes.iconThemes.filter(isRecord) as IconThemeContribution[];
}

/**
 * icon theme JSON 을 읽고 extends 체인이 있으면 부모 규칙 위에 병합한다.
 * @param themePath 읽을 icon theme JSON 경로
 * @param seen 순환 extends 방지용 방문 집합
 */
function loadTheme(themePath: string, seen: Set<string>): LoadedIconTheme | undefined {
  if (seen.has(themePath)) {
    return undefined;
  }
  seen.add(themePath);
  try {
    const raw = fs.readFileSync(themePath, "utf8");
    const document = JSON.parse(stripJsonc(raw)) as IconThemeDocument;
    stampDefinitions(document, themePath);
    if (document.extends) {
      const parentPath = path.resolve(path.dirname(themePath), document.extends);
      const parent = loadTheme(parentPath, seen);
      if (parent) {
        return {
          filePath: themePath,
          document: mergeThemes(parent.document, document),
        };
      }
    }
    return { filePath: themePath, document };
  } catch {
    return undefined;
  }
}

/**
 * icon definition 의 상대 경로 기준 theme 파일을 기록한다.
 * @param document 파싱된 icon theme 문서
 * @param themePath 이 문서가 읽힌 실제 파일 경로
 */
function stampDefinitions(document: IconThemeDocument, themePath: string): void {
  for (const definition of Object.values(document.iconDefinitions ?? {})) {
    definition.sourceFilePath = themePath;
  }
  for (const font of document.fonts ?? []) {
    font.sourceFilePath = themePath;
  }
}

/**
 * 부모 icon theme 위에 자식 icon theme 정의를 얹는다.
 * @param base 부모 테마
 * @param override 자식 테마
 */
function mergeThemes(base: IconThemeDocument, override: IconThemeDocument): IconThemeDocument {
  return {
    ...base,
    ...override,
    iconDefinitions: {
      ...(base.iconDefinitions ?? {}),
      ...(override.iconDefinitions ?? {}),
    },
    fonts: [...(base.fonts ?? []), ...(override.fonts ?? [])],
    fileExtensions: {
      ...(base.fileExtensions ?? {}),
      ...(override.fileExtensions ?? {}),
    },
    fileNames: {
      ...(base.fileNames ?? {}),
      ...(override.fileNames ?? {}),
    },
    languageIds: {
      ...(base.languageIds ?? {}),
      ...(override.languageIds ?? {}),
    },
    light: mergeAssociations(base.light, override.light),
    highContrast: mergeAssociations(base.highContrast, override.highContrast),
  };
}

/** 파일 연결 규칙 override 를 병합한다. */
function mergeAssociations(
  base: FileAssociations | undefined,
  override: FileAssociations | undefined
): FileAssociations | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...base,
    ...override,
    fileExtensions: {
      ...(base?.fileExtensions ?? {}),
      ...(override?.fileExtensions ?? {}),
    },
    fileNames: {
      ...(base?.fileNames ?? {}),
      ...(override?.fileNames ?? {}),
    },
    languageIds: {
      ...(base?.languageIds ?? {}),
      ...(override?.languageIds ?? {}),
    },
  };
}

/**
 * 파일 경로에 맞는 icon definition 을 찾는다.
 * @param theme 파싱된 icon theme
 * @param resourcePath 저장소 기준 상대 파일 경로
 */
function resolveIcon(theme: LoadedIconTheme, resourcePath: string): ResolvedIcon | undefined {
  const associations = effectiveAssociations(theme.document);
  const iconId = associationIconId(associations, resourcePath);
  const definition =
    iconId && theme.document.iconDefinitions
      ? theme.document.iconDefinitions[iconId]
      : undefined;
  return definition
    ? { filePath: definition.sourceFilePath ?? theme.filePath, definition }
    : undefined;
}

/**
 * icon definition 이 참조하는 글꼴을 찾는다. fontId 가 없으면 첫 번째 글꼴을 쓴다.
 * @param document 파싱된 icon theme 문서
 * @param definition glyph 기반 아이콘 정의
 */
function fontForDefinition(document: IconThemeDocument, definition: IconDefinition): FontDefinition | undefined {
  const fonts = document.fonts ?? [];
  if (!fonts.length) {
    return undefined;
  }
  return definition.fontId
    ? fonts.find((font) => font.id === definition.fontId)
    : fonts[0];
}

/** icon theme 의 "\\E001" 형태 glyph 값을 실제 문자로 바꾼다. */
function glyphText(value: string): string {
  const match = /^\\([0-9a-fA-F]+)$/.exec(value);
  if (!match) {
    return value;
  }
  return String.fromCodePoint(Number.parseInt(match[1], 16));
}

/** 현재 컬러 테마 종류에 맞는 파일 연결 규칙을 만든다. */
function effectiveAssociations(document: IconThemeDocument): FileAssociations {
  const kind = vscode.window.activeColorTheme.kind;
  const override =
    kind === vscode.ColorThemeKind.Light
      ? document.light
      : kind === vscode.ColorThemeKind.HighContrast ||
          kind === vscode.ColorThemeKind.HighContrastLight
        ? document.highContrast
        : undefined;
  return mergeAssociations(document, override) ?? document;
}

/**
 * 공식 우선순위에 맞춰 파일명/확장자 연결을 찾는다.
 * @param associations 파일 연결 규칙
 * @param resourcePath 저장소 기준 상대 파일 경로
 */
function associationIconId(associations: FileAssociations, resourcePath: string): string | undefined {
  const normalized = resourcePath.replace(/\\/g, "/").toLowerCase();
  const slash = normalized.lastIndexOf("/");
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const parent = slash >= 0 ? normalized.slice(0, slash).split("/").pop() : "";
  return (
    matchParentKey(associations.fileNames, parent, fileName) ??
    matchPlainKey(associations.fileNames, fileName) ??
    matchExtension(associations.fileExtensions, parent, fileName) ??
    matchLanguageId(associations.languageIds, fileName) ??
    associations.file
  );
}

/** 파일명/확장자로 추정한 VS Code language id 에 맞는 아이콘을 찾는다. */
function matchLanguageId(
  map: Record<string, string> | undefined,
  fileName: string
): string | undefined {
  const languageId = inferLanguageId(fileName);
  return languageId && map ? lookupAssociation(map, languageId) : undefined;
}

/** parent/name 형태의 fileNames 또는 fileExtensions 규칙을 먼저 찾는다. */
function matchParentKey(map: Record<string, string> | undefined, parent: string | undefined, key: string): string | undefined {
  if (!map || !parent) {
    return undefined;
  }
  return lookupAssociation(map, `${parent}/${key}`);
}

/** parent 없는 fileNames 규칙을 찾는다. */
function matchPlainKey(map: Record<string, string> | undefined, key: string): string | undefined {
  return map ? lookupAssociation(map, key) : undefined;
}

/** 다중 확장자 파일을 긴 확장자부터 검사한다. */
function matchExtension(map: Record<string, string> | undefined, parent: string | undefined, fileName: string): string | undefined {
  if (!map) {
    return undefined;
  }
  const extensions = extensionCandidates(fileName);
  for (const ext of extensions) {
    const parentMatch = matchParentKey(map, parent, ext);
    if (parentMatch) {
      return parentMatch;
    }
  }
  for (const ext of extensions) {
    const plainMatch = matchPlainKey(map, ext);
    if (plainMatch) {
      return plainMatch;
    }
  }
  return undefined;
}

/** icon theme 의 연결 키를 대소문자 구분 없이 찾는다. */
function lookupAssociation(map: Record<string, string>, key: string): string | undefined {
  const direct = map[key];
  if (direct) {
    return direct;
  }
  const wanted = key.toLowerCase();
  const match = Object.entries(map).find(
    ([candidate]) => candidate.toLowerCase() === wanted
  );
  return match ? match[1] : undefined;
}
