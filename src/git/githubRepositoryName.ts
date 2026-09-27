// gh 가 현재 저장소로 해석하는 GitHub owner/name 을 원격 설정 기준으로 기억하는 모듈.
// - `gh repo view` 는 매번 네트워크 요청이지만 결과는 원격 URL 이 바뀌지 않는 한 같다.
//   PR 상세·변경 파일·검색·에디터 댓글이 각자 호출하던 것을 저장소당 한 번으로 줄인다.
import { runGit } from "./gitExec";
import type { GhExecute, GhRunnerOptions } from "./ghRunner";

interface CachedName {
  /** 원격 url/gh-resolved 설정 원문. 바뀌면 다시 조회한다. */
  key: string;
  value: Promise<string>;
}

const cache = new Map<string, CachedName>();

/**
 * 저장소의 GitHub `owner/name` 을 반환한다(원격 설정이 같으면 이전 결과를 재사용).
 * - 캐시 key 는 `remote.*.url` 과 gh 가 쓰는 `remote.*.gh-resolved` 설정이라, 원격을 바꾸면 자동으로 다시 조회한다.
 * - 실패하거나 빈 결과는 기억하지 않아 다음 호출이 다시 시도한다.
 * @param repoRoot 저장소 루트
 * @param runner gh 실행 함수
 * @param options 취소 신호와 관찰용 작업 이름
 * @returns `owner/name`. gh 가 알 수 없으면 빈 문자열
 */
export async function readGitHubRepositoryName(
  repoRoot: string,
  runner: GhExecute,
  options: GhRunnerOptions
): Promise<string> {
  const key = await runGit(
    ["config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"],
    repoRoot
  ).catch(() => "");
  const cached = cache.get(repoRoot);
  if (cached && cached.key === key) {
    return cached.value;
  }
  const value = runner(["repo", "view", "--json", "nameWithOwner"], repoRoot, options).then((out) => {
    const parsed = JSON.parse(out) as { nameWithOwner?: string };
    return parsed.nameWithOwner || "";
  });
  const entry = { key, value };
  cache.set(repoRoot, entry);
  value.then(
    (name) => { if (!name && cache.get(repoRoot) === entry) cache.delete(repoRoot); },
    () => { if (cache.get(repoRoot) === entry) cache.delete(repoRoot); }
  );
  return value;
}

/** 테스트와 인증 변경 뒤 기억한 저장소 이름을 비운다. */
export function clearGitHubRepositoryNameCache(): void {
  cache.clear();
}
