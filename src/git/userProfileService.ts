// git user profile 설정 서비스.
// - user.name/user.email 을 global 또는 repository-local config 로 읽고 쓴다.
// - UI/명령 레이어가 git config 인자 조합을 직접 알 필요 없도록 캡슐화한다.
import { GitError, runGit } from "./gitExec";

export type GitUserProfileScope = "global" | "local";

/** git 커밋 작성자 정보로 쓰이는 user.name/user.email 값 */
export interface GitUserProfile {
  name: string;
  email: string;
}

/**
 * git user profile 을 읽고 쓰는 저장소 독립 서비스.
 * - global 설정도 git 명령 실행에는 cwd 가 필요하므로 생성 시 실행 디렉터리를 받는다.
 * - local 설정은 반드시 대상 저장소 루트를 cwd 로 넘겨야 한다.
 */
export class GitUserProfileService {
  constructor(private readonly cwd: string) {}

  /**
   * 지정 범위의 user.name/user.email 값을 읽는다.
   * - 값이 설정되지 않은 경우 git config 는 exit code 1 을 반환하므로 빈 문자열로 정규화한다.
   * @param scope global 설정 또는 현재 저장소 local 설정
   * @returns 현재 설정된 프로필 값. 없는 항목은 빈 문자열
   */
  async readProfile(scope: GitUserProfileScope): Promise<GitUserProfile> {
    const [name, email] = await Promise.all([
      this.readValue(scope, "user.name"),
      this.readValue(scope, "user.email"),
    ]);
    return { name, email };
  }

  /**
   * 지정 범위의 user.name/user.email 값을 저장한다.
   * - 입력값이 빈 문자열이면 해당 key 를 unset 해서 상위 범위(global 등)에 맡길 수 있게 한다.
   * @param scope global 설정 또는 현재 저장소 local 설정
   * @param profile 저장할 프로필 값
   */
  async writeProfile(
    scope: GitUserProfileScope,
    profile: GitUserProfile
  ): Promise<void> {
    await this.writeValue(scope, "user.name", profile.name.trim());
    await this.writeValue(scope, "user.email", profile.email.trim());
  }

  /**
   * git config key 하나를 읽는다.
   * - key 미설정은 정상 상태로 보고 빈 문자열을 반환한다.
   * @param scope 설정 범위
   * @param key 읽을 git config key
   */
  private async readValue(
    scope: GitUserProfileScope,
    key: "user.name" | "user.email"
  ): Promise<string> {
    try {
      const out = await runGit(["config", scopeFlag(scope), "--get", key], this.cwd);
      return out.trim();
    } catch (error) {
      if (isUnsetConfigValue(error)) {
        return "";
      }
      throw error;
    }
  }

  /**
   * git config key 하나를 저장하거나 제거한다.
   * - 빈 값은 `git config --unset` 으로 제거하고, 이미 없는 key 제거는 성공으로 간주한다.
   * @param scope 설정 범위
   * @param key 저장할 git config key
   * @param value 저장할 값. 빈 문자열이면 key 제거
   */
  private async writeValue(
    scope: GitUserProfileScope,
    key: "user.name" | "user.email",
    value: string
  ): Promise<void> {
    const flag = scopeFlag(scope);
    const args = value
      ? ["config", flag, "--replace-all", key, value]
      : ["config", flag, "--unset-all", key];
    try {
      await runGit(args, this.cwd);
    } catch (error) {
      if (!value && isUnsetConfigValue(error)) {
        return;
      }
      throw error;
    }
  }
}

/**
 * 서비스의 scope 값을 git config CLI 플래그로 바꾼다.
 * @param scope 설정 범위
 */
function scopeFlag(scope: GitUserProfileScope): "--global" | "--local" {
  return scope === "global" ? "--global" : "--local";
}

/**
 * git config key 가 설정되지 않아 발생한 실패인지 판별한다.
 * - 현재 GitError 는 exit code 를 보관하지 않으므로, stderr/stdout 이 모두 비고 spawn 오류가
 *   아닌 git config 실패만 "값 없음"으로 취급한다.
 * @param error git 실행 중 발생한 오류
 */
function isUnsetConfigValue(error: unknown): boolean {
  if (!(error instanceof GitError)) {
    return false;
  }
  return (
    !error.stderr.trim() &&
    !error.stdout.trim() &&
    !/spawn|ENOENT|EACCES/i.test(error.message)
  );
}
