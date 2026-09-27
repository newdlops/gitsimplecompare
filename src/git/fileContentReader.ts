// diff/가상 문서가 쓰는 파일 내용(특정 ref, index, staged 를 뺀 작업본)을 읽는 모듈.
// - GitService 가 위임하는 읽기 전용 경계이며, 대용량 파일을 확장 호스트 메모리에 올리지 않도록 크기 상한을 적용한다.
// - vscode API 에 의존하지 않는다.
import * as path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { GitError, runGit } from "./gitExec";
import { FileTooLargeError } from "./largeChangeSet";
import { buildWorkingContentWithoutStaged } from "./unstagedView";

/** 파일 내용 읽기 옵션(diff 미리보기용 크기 상한). */
export interface ContentReadOptions {
  /** 버전 하나당 읽을 최대 byte 수. 넘으면 FileTooLargeError 를 던진다. */
  maxBytes?: number;
}

/**
 * 특정 ref 시점의 파일 내용을 문자열로 반환한다.
 * - `git show <ref>:<상대경로>` 사용. ref 가 `:0` 이면 index 의 stage 0 버전을 읽는다.
 * - 해당 ref 에 파일이 없으면(추가/삭제된 경우) 빈 문자열을 반환해 diff 에서 "빈 쪽"으로 보이게 한다.
 *   Git 실행 실패는 빈 파일로 바꾸지 않고, tree/index 에서 부재가 확인될 때만 빈 문자열을 허용한다.
 * - maxBytes 를 주면 그보다 큰 내용은 읽다가 git 을 멈추고 FileTooLargeError 를 던진다.
 * @param repoRoot 저장소 루트
 * @param ref git 참조(브랜치/커밋/`:0`)
 * @param rel 저장소 상대 경로(POSIX 구분자)
 * @param options maxBytes: 미리보기로 읽을 최대 byte 수(생략하면 git 출력 버퍼 기본 상한)
 * @returns 파일 내용(UTF-8 문자열)
 */
export async function readFileAtRef(
  repoRoot: string,
  ref: string,
  rel: string,
  options: ContentReadOptions = {}
): Promise<string> {
  const run = (args: string[]) => runGit(args, repoRoot);
  try {
    const spec = ref === ":0" ? `:0:${rel}` : `${ref}:${rel}`;
    return await runGit(
      ["show", spec],
      repoRoot,
      options.maxBytes === undefined ? undefined : { maxBuffer: options.maxBytes }
    );
  } catch (err) {
    if (
      options.maxBytes !== undefined &&
      err instanceof GitError &&
      err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ) {
      throw new FileTooLargeError(rel, options.maxBytes);
    }
    if (err instanceof GitError && err.code === 128) {
      const args = ref === ":0"
        ? ["ls-files", "--stage", "-z", "--", rel]
        : ["ls-tree", "-z", "--full-name", ref, "--", rel];
      const entries = await run(["--literal-pathspecs", ...args]).catch(() => undefined);
      if (entries === "") return "";
      if (ref === "HEAD") {
        // 첫 커밋 전의 유효한 unborn 브랜치만 빈 기준으로 허용한다. 잘못된 ref/손상된 객체는 오류다.
        const branch = await run(["symbolic-ref", "--quiet", "HEAD"]).catch(() => undefined);
        if (branch && await run(["for-each-ref", "--format=%(objectname)", branch.trim()]) === "") return "";
      }
    }
    throw err;
  }
}

/**
 * 작업트리에서 staged 변경만 제거한 가상 파일 내용을 만든다.
 * - 부분 stage 뒤 남은 unstaged 변경만 HEAD 와 비교할 때 사용한다.
 * - 실제 작업트리나 index 는 수정하지 않고 HEAD/index/working 세 버전을 라인 단위로 합성한다.
 * - maxBytes 를 주면 작업트리 파일은 읽기 전에 크기로, HEAD/index 는 읽는 중 상한으로 막아
 *   대용량 파일 세 벌을 확장 호스트 메모리에 올리지 않는다(FileTooLargeError).
 * @param repoRoot 저장소 루트
 * @param rel 저장소 상대 경로(POSIX 구분자)
 * @param options maxBytes: 버전 하나당 읽을 최대 byte 수
 * @returns staged 변경을 뺀 작업트리 내용. 작업트리 파일이 없으면 빈 문자열
 */
export async function readWorkingContentWithoutStaged(
  repoRoot: string,
  rel: string,
  options: ContentReadOptions = {}
): Promise<string> {
  const workingPath = path.join(repoRoot, rel);
  if (options.maxBytes !== undefined) {
    const size = await stat(workingPath).then((info) => info.size, () => undefined);
    if (size !== undefined && size > options.maxBytes) {
      throw new FileTooLargeError(rel, options.maxBytes, size);
    }
  }
  let content = "";
  try {
    content = await readFile(workingPath, "utf8");
  } catch {
    return "";
  }
  const [head, index] = await Promise.all([
    readFileAtRef(repoRoot, "HEAD", rel, options),
    readFileAtRef(repoRoot, ":0", rel, options),
  ]);
  return buildWorkingContentWithoutStaged(head, index, content);
}
