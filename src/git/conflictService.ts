// 머지/리베이스 충돌 해결에 필요한 git 작업을 모은 서비스 모듈.
// - 충돌 파일 조회, ours/theirs 수용, 해결 표시, 진행 중 작업(merge/rebase 등)의
//   상태 확인과 continue/abort 를 제공한다. git 접근은 runGit 만 사용한다(경계 분리).
import * as fs from "node:fs";
import * as path from "node:path";
import {
  describeFileSource,
  readConflictOperationContext,
  type ConflictOperationContext,
} from "./conflictContextService";
import {
  ConflictContentService,
  type ConflictContentKind,
  type ConflictResultState,
  type ConflictWorkingResult,
} from "./conflictContentService";
import { runGit } from "./gitExec";
import {
  cleanupRebaseMessageQueue,
  rebaseContinueEditorEnv,
} from "./rebaseMessageQueue";

/** 진행 중인 git 작업 종류(충돌이 발생할 수 있는 작업들) */
export type MergeOperation = "none" | "merge" | "rebase" | "cherry-pick" | "revert";

/** 충돌 한쪽 버전이 어느 ref/commit 에서 왔는지 설명하는 정보 */
export interface ConflictSource {
  label: string;
  ref: string;
  commit?: string;
  subject?: string;
  fileCommit?: string;
  fileSubject?: string;
}

export type { ConflictContentKind, ConflictResultState } from "./conflictContentService";

/** 충돌 편집기에 표시할 한쪽 버전 정보 */
export interface ConflictSide extends ConflictSource {
  stage: 1 | 2 | 3;
  exists: boolean;
  kind: ConflictContentKind;
  oid?: string;
  mode?: string;
  truncated?: boolean;
  content: string;
}

/** 충돌 양쪽 버전의 출처 정보 */
export interface ConflictSources {
  operation: MergeOperation;
  current: ConflictSource;
  incoming: ConflictSource;
}

/** 충돌 편집기에서 한 파일을 열 때 필요한 전체 데이터 */
export interface ConflictDocument {
  rel: string;
  operation: MergeOperation;
  context: ConflictOperationContext;
  base: ConflictSide;
  current: ConflictSide;
  incoming: ConflictSide;
  result: string;
  resultState: ConflictResultState;
  sourceVersion: string;
  resultVersion: string;
  both: string;
  bothAvailable: boolean;
}

/**
 * 진행 중인 git 작업 종류를 git 디렉터리의 마커 파일로 판별한다(공유 함수).
 * - ConflictService 와 RebaseService 가 함께 사용한다.
 * - REBASE_HEAD 는 완료/실패 직후 stale 파일로 남을 수 있으므로 rebase 진행 신호로 쓰지 않는다.
 * @param repoRoot 저장소 루트
 */
export async function detectOperation(
  repoRoot: string
): Promise<MergeOperation> {
  const gitDirRaw = (await runGit(["rev-parse", "--git-dir"], repoRoot)).trim();
  const gitDir = path.resolve(repoRoot, gitDirRaw);
  const has = (name: string): boolean => fs.existsSync(path.join(gitDir, name));

  if (has("rebase-merge") || has("rebase-apply")) {
    return "rebase";
  }
  if (has("MERGE_HEAD")) {
    return "merge";
  }
  if (has("CHERRY_PICK_HEAD")) {
    return "cherry-pick";
  }
  if (has("REVERT_HEAD")) {
    return "revert";
  }
  return "none";
}

/**
 * 한 저장소의 충돌 상태를 다루는 서비스(저장소 루트 1개에 대응).
 */
export class ConflictService {
  private readonly content: ConflictContentService;

  constructor(public readonly repoRoot: string) {
    this.content = new ConflictContentService(repoRoot);
  }

  /**
   * 현재 충돌(unmerged) 상태인 파일들의 저장소 상대 경로 목록을 반환한다.
   * - `--diff-filter=U` 로 unmerged 항목만, `-z` 로 경로를 안전하게 파싱한다.
   */
  async listConflicts(): Promise<string[]> {
    const out = await runGit(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      this.repoRoot
    );
    return out.split("\0").filter((p) => p.length > 0);
  }

  /**
   * 한 파일을 "우리쪽(--ours)" 버전으로 확정하고 스테이징한다.
   * - merge 에서는 현재 브랜치(HEAD), rebase 에서는 베이스 쪽을 뜻함에 주의.
   * @param rel 저장소 상대 경로
   * @returns 동시 편집 원본을 별도 보존했으면 recovery 경로
   */
  async takeOurs(
    rel: string,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<string | undefined> {
    return this.content.takeStage(rel, 2, expectedVersion, expectedSourceVersion);
  }

  /**
   * 한 파일을 "상대쪽(--theirs)" 버전으로 확정하고 스테이징한다.
   * - merge 에서는 병합 대상, rebase 에서는 재적용되는 커밋 쪽을 뜻함에 주의.
   * @param rel 저장소 상대 경로
   * @returns 동시 편집 원본을 별도 보존했으면 recovery 경로
   */
  async takeTheirs(
    rel: string,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<string | undefined> {
    return this.content.takeStage(rel, 3, expectedVersion, expectedSourceVersion);
  }

  /**
   * Current 쪽 내용을 충돌 결과로 확정한다.
   * - 편집기에서 전달한 내용이 있으면 그 내용을 결과 파일로 쓰고, 없으면 git stage 2(--ours)를 그대로 쓴다.
   * @param rel     저장소 상대 경로
   * @param content 사용자가 Current 패널에서 편집한 내용
   * @returns 동시 편집 원본을 별도 보존했으면 recovery 경로
   */
  async acceptCurrent(
    rel: string,
    content?: string,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<string | undefined> {
    if (content === undefined) {
      return this.takeOurs(rel, expectedVersion, expectedSourceVersion);
    }
    return this.writeResolvedContent(rel, content, true, expectedVersion, expectedSourceVersion);
  }

  /**
   * Incoming 쪽 내용을 충돌 결과로 확정한다.
   * - 편집기에서 전달한 내용이 있으면 그 내용을 결과 파일로 쓰고, 없으면 git stage 3(--theirs)를 그대로 쓴다.
   * @param rel     저장소 상대 경로
   * @param content 사용자가 Incoming 패널에서 편집한 내용
   * @returns 동시 편집 원본을 별도 보존했으면 recovery 경로
   */
  async acceptIncoming(
    rel: string,
    content?: string,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<string | undefined> {
    if (content === undefined) {
      return this.takeTheirs(rel, expectedVersion, expectedSourceVersion);
    }
    return this.writeResolvedContent(rel, content, true, expectedVersion, expectedSourceVersion);
  }

  /**
   * Current 와 Incoming 을 모두 보존하는 보편적인 Accept Both 결과를 만든 뒤 해결로 표시한다.
   * - 완전한 conflict marker 블록에서만 current 내용을 먼저, incoming 내용을 뒤에 둔다.
   * - marker가 없거나 불완전하면 파일 전체를 임의로 결합하지 않고 사용자가 직접 판별하도록 거부한다.
   * @param rel 저장소 상대 경로
   * @returns 동시 편집 원본을 별도 보존했으면 recovery 경로
   */
  async acceptBoth(
    rel: string,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<string | undefined> {
    return this.content.acceptBoth(rel, expectedVersion, expectedSourceVersion);
  }

  /**
   * 수동 편집으로 해결한 파일을 스테이징해 "해결됨"으로 표시한다.
   * - 사용자가 UI 에서 resolved 로 확정한 뒤에는 파일 본문 marker 를 다시 검사하지 않는다.
   *   Git 과 동일하게 index 의 unmerged entry 해소 여부를 resolved 기준으로 삼는다.
   * @param rel 저장소 상대 경로
   */
  async markResolved(
    rel: string,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<void> {
    await this.content.markResolved(rel, expectedVersion, expectedSourceVersion);
  }

  /**
   * 충돌 편집기에 필요한 Current/Incoming/Result 내용을 읽는다.
   * - Current/Incoming 은 git index stage 2/3 을 그대로 읽어 커밋 해시 라벨과 함께 보여준다.
   * - Result 는 실제 작업 파일이므로 사용자가 편집하고 Resolve Marked 로 스테이징할 대상이다.
   * @param rel 저장소 상대 경로
   */
  async getConflictDocument(
    rel: string,
    fullResult = false
  ): Promise<ConflictDocument> {
    const operation = await this.getOperation();
    const [sources, context, contents] = await Promise.all([
      this.getConflictSources(rel, operation),
      readConflictOperationContext(this.repoRoot, operation, rel),
      this.content.readDocument(rel, fullResult),
    ]);
    return {
      rel,
      operation,
      context,
      base: { label: "Base", ref: "index stage 1", ...contents.base },
      current: { ...sources.current, ...contents.current },
      incoming: { ...sources.incoming, ...contents.incoming },
      result: contents.result,
      resultState: contents.resultState,
      sourceVersion: contents.sourceVersion,
      resultVersion: contents.resultVersion,
      both: contents.both,
      bothAvailable: contents.bothAvailable,
    };
  }

  /**
   * 충돌 Current/Incoming 이 가리키는 ref, 커밋 해시, 커밋 제목을 반환한다.
   * - decoration/hover 처럼 파일 본문이 필요 없는 UI 에서 가볍게 재사용한다.
   */
  async getConflictSources(
    rel?: string,
    knownOperation?: MergeOperation
  ): Promise<ConflictSources> {
    const operation = knownOperation ?? await this.getOperation();
    const refs = await this.conflictRefs(operation);
    const [currentFile, incomingFile] = rel
      ? await Promise.all([
          describeFileSource(this.repoRoot, refs.current.fileRef, rel),
          refs.incoming.fileRef
            ? describeFileSource(this.repoRoot, refs.incoming.fileRef, rel)
            : Promise.resolve(undefined),
        ])
      : [];
    return {
      operation,
      current: {
        label: "Current",
        ref: refs.current.ref,
        commit: refs.current.commit,
        subject: refs.current.subject,
        fileCommit: currentFile?.commit,
        fileSubject: currentFile?.subject,
      },
      incoming: {
        label: "Incoming",
        ref: refs.incoming.ref,
        commit: refs.incoming.commit,
        subject: refs.incoming.subject,
        fileCommit: incomingFile?.commit,
        fileSubject: incomingFile?.subject,
      },
    };
  }

  /**
   * 사용자가 편집한 Result 내용을 작업 파일에 저장하고 필요하면 해결됨으로 표시한다.
   * @param rel          저장소 상대 경로
   * @param content      저장할 result 내용
   * @param markResolved true 면 저장 직후 git add 로 해결 처리한다
   * @returns 동시 편집 원본을 별도 보존했으면 recovery 경로
   */
  async writeResolvedContent(
    rel: string,
    content: string,
    markResolved = false,
    expectedVersion?: string,
    expectedSourceVersion?: string
  ): Promise<string | undefined> {
    return this.content.writeResolvedContent(
      rel,
      content,
      markResolved,
      expectedVersion,
      expectedSourceVersion
    );
  }

  /** 해결된 native virtual 문서의 내용을 index 변경 없이 no-follow CAS로 저장한다. */
  async writeWorkingContent(
    rel: string,
    content: string,
    expectedVersion?: string
  ): Promise<string | undefined> {
    return this.content.writeWorkingContent(rel, content, expectedVersion);
  }

  /** 패널 load 이후 작업트리 Result가 외부에서 바뀌었는지 비교할 version을 읽는다. */
  async getConflictResultVersion(rel: string): Promise<string> {
    return this.content.readUnresolvedResultVersion(rel);
  }

  /**
   * 해결 mutation 뒤 작업트리 Result의 실제 종류와 표시 내용을 다시 읽는다.
   * @param rel 저장소 상대 경로
   */
  async getWorkingResult(
    rel: string,
    fullResult = false
  ): Promise<ConflictWorkingResult> {
    return this.content.readResult(rel, fullResult);
  }

  /**
   * 진행 중인 git 작업 종류를 판별한다(공유 함수 detectOperation 에 위임).
   */
  getOperation(): Promise<MergeOperation> {
    return detectOperation(this.repoRoot);
  }

  /**
   * 진행 중인 작업을 이어서 진행한다(`git <op> --continue`).
   * - graph rebase 메시지 큐가 있으면 reword/squash 메시지를 적용하고, 없으면 editor 를 우회한다.
   * @param op 진행 중인 작업 종류
   */
  async continueOperation(op: MergeOperation): Promise<void> {
    if (op === "none") {
      return;
    }
    const env = await this.continueEnv(op);
    await runGit([op, "--continue"], this.repoRoot, env);
    await this.cleanupMessageQueueIfRebaseDone(op);
  }

  /**
   * 진행 중인 rebase/cherry-pick/revert 의 현재 항목을 건너뛴다(`git <op> --skip`).
   * - merge 에는 skip 개념이 없으므로 잘못 호출되면 명확한 오류를 던진다.
   * @param op 진행 중인 작업 종류
   */
  async skipOperation(op: MergeOperation): Promise<void> {
    if (op === "none") {
      return;
    }
    if (op === "merge") {
      throw new Error("Merge operation cannot be skipped.");
    }
    await runGit([op, "--skip"], this.repoRoot, await this.continueEnv(op));
    await this.cleanupMessageQueueIfRebaseDone(op);
  }

  /**
   * 진행 중인 작업을 취소한다(`git <op> --abort`).
   * @param op 진행 중인 작업 종류
   */
  async abortOperation(op: MergeOperation): Promise<void> {
    if (op === "none") {
      return;
    }
    await runGit([op, "--abort"], this.repoRoot);
    if (op === "rebase") {
      await cleanupRebaseMessageQueue(this.repoRoot);
    }
  }

  /**
   * 저장소 상대 경로를 절대 경로로 변환한다(파일 URI 생성용).
   * @param rel 저장소 상대 경로
   */
  absPath(rel: string): string {
    return this.content.absPath(rel);
  }

  /** continue/skip 에 사용할 editor 환경을 만든다. */
  private async continueEnv(op: MergeOperation): Promise<Record<string, string>> {
    if (op === "rebase") {
      const editorEnv = await rebaseContinueEditorEnv(this.repoRoot);
      if (editorEnv) {
        return editorEnv;
      }
    }
    return { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
  }

  /** rebase 가 끝났으면 graph 메시지 큐 상태를 정리한다. */
  private async cleanupMessageQueueIfRebaseDone(op: MergeOperation): Promise<void> {
    if (op === "rebase" && await detectOperation(this.repoRoot) !== "rebase") {
      await cleanupRebaseMessageQueue(this.repoRoot);
    }
  }

  /**
   * 진행 중 작업에 맞춰 Current/Incoming 의 ref 와 커밋 해시를 계산한다.
   * @param operation 현재 git 작업 종류
   */
  private async conflictRefs(operation: MergeOperation): Promise<{
    current: { ref: string; fileRef: string; commit?: string; subject?: string };
    incoming: { ref: string; fileRef?: string; commit?: string; subject?: string };
  }> {
    const [current, incoming] = await Promise.all([
      this.describeRef("HEAD"),
      this.incomingConflictRef(operation),
    ]);
    return {
      current: { ref: "HEAD", fileRef: "HEAD", ...current },
      incoming,
    };
  }

  /**
   * operation 안에서 실제 stage 3를 만든 활성 ref를 찾는다.
   * - rebase-merges의 merge todo나 exec가 시작한 nested Git 작업은 REBASE_HEAD보다
   *   MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD가 실제 Incoming 출처이므로 우선한다.
   */
  private async incomingConflictRef(operation: MergeOperation): Promise<{
    ref: string;
    fileRef?: string;
    commit?: string;
    subject?: string;
  }> {
    if (operation === "revert") {
      return { ref: "reverse side of REVERT_HEAD", ...await this.describeRef("REVERT_HEAD") };
    }
    if (operation !== "rebase") {
      const ref = operation === "merge"
        ? "MERGE_HEAD"
        : operation === "cherry-pick"
          ? "CHERRY_PICK_HEAD"
          : "theirs";
      return { ref, fileRef: ref, ...await this.describeRef(ref) };
    }
    const [merge, cherryPick, revert, replay] = await Promise.all([
      this.describeRef("MERGE_HEAD"),
      this.describeRef("CHERRY_PICK_HEAD"),
      this.describeRef("REVERT_HEAD"),
      this.describeRef("REBASE_HEAD"),
    ]);
    if (merge.commit) return { ref: "MERGE_HEAD", fileRef: "MERGE_HEAD", ...merge };
    if (cherryPick.commit) {
      return { ref: "CHERRY_PICK_HEAD", fileRef: "CHERRY_PICK_HEAD", ...cherryPick };
    }
    if (revert.commit) {
      return { ref: "reverse side of REVERT_HEAD", ...revert };
    }
    return { ref: "REBASE_HEAD", fileRef: "REBASE_HEAD", ...replay };
  }

  /**
   * ref 를 커밋 해시와 제목으로 해석한다. ref 가 없으면 undefined 값으로 UI 가 ref 이름만 보여주게 한다.
   * @param ref git ref 이름
   */
  private async describeRef(
    ref: string
  ): Promise<{ commit?: string; subject?: string }> {
    const commitOut = await runGit(["rev-parse", "--verify", ref], this.repoRoot).catch(
      () => ""
    );
    const commit = commitOut.split(/\r?\n/).find(Boolean);
    if (!commit) {
      return {};
    }
    const subject = (
      await runGit(["show", "-s", "--format=%s", commit], this.repoRoot).catch(
        () => ""
      )
    ).trim();
    return { commit, subject: subject || undefined };
  }

}
