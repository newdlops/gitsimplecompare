// gh가 실제로 선택한 저장소 URL을 관찰하며 remote 문자열로 기본 저장소를 추측하지 않는다.
export interface GitHubRepositoryScope { readonly host: string; readonly name: string; readonly owner: string; readonly repository: string; }

/** 성공·문맥 검증이 끝난 repository payload만 bounded scope 캐시에 등록한다. */
export class GitHubRepositoryScopes {
  private readonly scopes = new Map<string, GitHubRepositoryScope>();

  /** 실행 루트와 관찰한 인증·Git 문맥이 같은 canonical 저장소만 반환한다. */
  get(root: string, context: string | undefined): GitHubRepositoryScope | undefined {
    if (context === undefined) return undefined;
    const key = JSON.stringify([root, context]), value = this.scopes.get(key);
    if (value) { this.scopes.delete(key); this.scopes.set(key, value); }
    return value;
  }

  /** URL의 host/path와 nameWithOwner가 일치하는 완전한 응답만 저장하며 부분·추측 값은 거절한다. */
  learn(root: string, context: string | undefined, repository: unknown): boolean {
    if (context === undefined || !repository || typeof repository !== "object") return false;
    const { nameWithOwner, url } = repository as { nameWithOwner?: unknown; url?: unknown };
    if (typeof nameWithOwner !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(nameWithOwner) || typeof url !== "string") return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
        || parsed.pathname.replace(/\/$/, "").toLowerCase() !== `/${nameWithOwner}`.toLowerCase()) return false;
      const [owner, name] = nameWithOwner.split("/");
      this.scopes.set(JSON.stringify([root, context]), Object.freeze({ host: parsed.hostname.toLowerCase(), name: nameWithOwner, owner, repository: name }));
      while (this.scopes.size > 128) this.scopes.delete(this.scopes.keys().next().value!);
      return true;
    } catch { return false; }
  }

  /** 인증·설정 변경 또는 소유 수명 종료 때 canonical 문맥을 버린다. */
  clear(): void { this.scopes.clear(); }
}

export const gitHubRepositoryScopes = new GitHubRepositoryScopes();
