// GitHub 저장소 식별자 관련 순수 유틸.
// - gh/GitHub GraphQL 호출 전 owner/name 검증을 한곳에서 처리한다.

/**
 * owner/name 형태의 저장소명을 GraphQL 변수로 나눈다.
 * @param repository gh repo view 가 반환한 nameWithOwner 문자열
 * @returns owner 와 repository name tuple
 */
export function splitRepositoryName(repository: string): [string, string] {
  const [owner, name] = repository.split("/");
  if (!owner || !name) {
    throw new Error("GitHub repository name is not available.");
  }
  return [owner, name];
}
