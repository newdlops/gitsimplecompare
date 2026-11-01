// 읽기 전용 API 계약과 기존 gh 인자를 함께 만들어 전송 선택과 서비스 의미를 분리한다.
import { parse } from "graphql/language/parser";
import type { OperationDefinitionNode } from "graphql/language/ast";
import { Kind } from "graphql/language/kinds";

export type GitHubVariables = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
export interface GitHubGraphQLRequest {
  readonly kind: "graphql";
  readonly query: string;
  readonly variables: GitHubVariables;
  readonly operationName?: string;
}
export interface GitHubRestRequest {
  readonly kind: "rest";
  readonly path: string;
  readonly accept: string;
}
export type GitHubReadRequest = GitHubGraphQLRequest | GitHubRestRequest;
interface GraphQLOptions {
  operationName?: string;
  cliVariables?: GitHubVariables;
  /** 기존 서비스가 관찰하는 인자 순서·-F/-f 구분을 그대로 보존한다. 해석하지 않는다. */
  cliArgs?: readonly string[];
}

/**
 * AST로 선택 query를 검증하고 HTTP descriptor와 호환 gh 인자를 함께 만든다.
 * @param query GraphQL 문서, variables 타입을 보존할 변수, options 명시적 operation과 CLI 호환 인자
 * @returns 읽기 전용 descriptor와 CLI fallback 인자. 문서 원문은 오류에 넣지 않는다.
 */
export function graphqlRead(query: string, variables: GitHubVariables = {}, options: GraphQLOptions = {}) {
  try {
    const document = parse(query, { noLocation: true, maxTokens: 50_000 });
    const operations = document.definitions.filter((node): node is OperationDefinitionNode => node.kind === Kind.OPERATION_DEFINITION);
    const selected = options.operationName
      ? operations.filter(node => node.name?.value === options.operationName)
      : operations;
    if (selected.length !== 1 || selected[0].operation !== "query") throw new Error();
    // 선택되지 않은 write도 실수로 operationName이 유실될 때 실행되지 않게 차단한다.
    if (operations.some(node => node.operation !== "query")) throw new Error();
  } catch { throw new Error("GitHub read requires an unambiguous GraphQL query."); }
  const args = options.cliArgs ?? ["api", "graphql", ...Object.entries(options.cliVariables ?? variables).flatMap(([key, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap(item => [typeof item === "string" && !/^\{(?:owner|repo)\}$/.test(item) ? "-f" : "-F",
      `${key}${Array.isArray(value) ? "[]" : ""}=${item}`]);
  }), ...(options.operationName ? ["-f", `operationName=${options.operationName}`] : []), "-f", `query=${query}`];
  const request: GitHubGraphQLRequest = Object.freeze({ kind: "graphql", query,
    variables: Object.freeze(Object.fromEntries(Object.entries(variables).map(([key, value]) =>
      [key, Array.isArray(value) ? Object.freeze([...value]) : value]))), operationName: options.operationName });
  return { args, request };
}

/** 같은 API origin의 GET 경로만 허용하며 절대 URL·경로 탈출·헤더 문자를 거부한다. */
export function restRead(path: string, accept = "application/vnd.github+json", cliArgs?: readonly string[]) {
  const url = new URL(path, "https://api.github.com");
  if (!path.startsWith("/") || path.startsWith("//") || url.origin !== "https://api.github.com"
    || /[\r\n\\#]/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) || /[\r\n]/.test(accept)) {
    throw new Error("GitHub REST read requires a safe API path.");
  }
  const request: GitHubRestRequest = Object.freeze({ kind: "rest", path, accept });
  return { args: cliArgs ?? ["api", path.replace(/^\//, "")], request };
}
