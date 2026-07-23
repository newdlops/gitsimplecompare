// staged snapshot을 별도 index로 격리해 실제 커밋 전 차단 hook을 미리 실행한다.
// - Git 접근은 gitExec를 사용하고, UI 알림/OUTPUT 표현은 command 계층에 맡긴다.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { detectOperation, type MergeOperation } from "./conflictService";
import {
  cleanupCommitPlanIndex,
  commitPlanGitEnvironment,
  copyRealIndexToSibling,
} from "./aiCommitPlanIndexEntries";
import { readAiCommitPlanIndexFingerprint } from "./aiCommitPlanContext";
import {
  CommitHookService,
  type CommitHookName,
} from "./commitHookService";
import {
  GitError,
  runGit,
  runGitDetailed,
  type GitCommandOutput,
} from "./gitExec";

/** 사전 실행에서 실제 커밋 전에 호출할 수 있는 차단 hook 순서다. */
const PREFLIGHT_HOOK_ORDER = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
] as const satisfies readonly CommitHookName[];

/** 메시지 파일이 있어야 실제 `git commit -m`과 같은 인자를 만들 수 있는 hook이다. */
const MESSAGE_HOOKS = new Set<CommitHookName>([
  "prepare-commit-msg",
  "commit-msg",
]);

/** 사전 실행 실패를 command/UI 계층이 안정적으로 구분하기 위한 오류 코드다. */
export type CommitHookPreflightErrorCode =
  | "noStagedChanges"
  | "operationInProgress"
  | "unmergedIndex"
  | "hookFailed"
  | "stagedChangesChanged";

/** hook 한 건이 성공하며 남긴 두 출력 스트림과 실행 시간을 보관한다. */
export interface CommitHookPreflightExecution {
  /** Git이 실행한 표준 commit hook 이름 */
  hook: CommitHookName;
  /** 성공한 hook의 stdout 전체 */
  stdout: string;
  /** 성공한 hook의 stderr 전체 */
  stderr: string;
  /** 프로세스 실행에 걸린 밀리초 */
  durationMs: number;
}

/** 전체 staged 사전 실행이 성공했을 때 command/UI에 전달하는 불변 결과다. */
export interface CommitHookPreflightResult {
  /** 검사 시작 시 snapshot에 포함된 staged 경로 수 */
  stagedFileCount: number;
  /** 실제로 실행해 통과한 hook과 출력 목록 */
  executions: CommitHookPreflightExecution[];
  /** 설치됐지만 빈 메시지 때문에 실행하지 않은 메시지 hook 목록 */
  skippedHooks: CommitHookName[];
  /** OUTPUT 채널에 그대로 기록할 단계별 전체 원문 */
  transcript: string;
  /** 전체 준비/실행/최종 검증 시간 */
  durationMs: number;
}

/**
 * staged hook 사전 실행의 예상 가능한 차단 사유와 전체 transcript를 함께 보존한다.
 * - hook 실패에서는 stderr에 transcript를 노출해 기존 commit 진단 파서가 파일/행을 그대로 재사용한다.
 */
export class CommitHookPreflightError extends Error {
  /** 기존 commitFailureOutput이 전체 사전 실행 로그를 읽도록 제공하는 stderr 호환 필드다. */
  readonly stderr: string;
  /** GitError 모양과 맞추되 transcript는 stderr 한 곳에만 넣기 위한 빈 stdout이다. */
  readonly stdout = "";

  /**
   * @param code UI 분기에 사용할 안정적인 오류 코드
   * @param message 개발 로그와 fallback 알림에 쓸 설명
   * @param hookName 실패가 확인된 hook 이름
   * @param transcript 실패 전 단계와 원본 출력 전체
   * @param operation 실행을 차단한 merge/rebase 계열 작업
   * @param cause 원래 GitError 또는 파일 오류
   */
  constructor(
    readonly code: CommitHookPreflightErrorCode,
    message: string,
    readonly hookName?: CommitHookName,
    readonly transcript = "",
    readonly operation?: MergeOperation,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "CommitHookPreflightError";
    this.stderr = transcript || message;
  }
}

/**
 * 실제 index와 refs를 쓰지 않고 staged snapshot에 대해 commit 차단 hook을 실행하는 서비스다.
 * - 실제 index sibling 복사본을 `GIT_INDEX_FILE`로 상속하므로 hook 안의 일반 `git add`도 임시 index만 바꾼다.
 * - hook은 실제 작업트리에서 실행해 프로젝트 의존성과 설정을 그대로 찾을 수 있다.
 * - post-commit/post-rewrite는 커밋 이후 부작용이므로 사전 실행하지 않는다.
 */
export class CommitHookPreflightService {
  /**
   * @param repoRoot 검사할 Git 작업트리 루트
   */
  constructor(readonly repoRoot: string) {}

  /**
   * 현재 staged snapshot과 선택적 커밋 메시지에 대해 실행 가능한 차단 hook을 순서대로 실행한다.
   * @param commitMessage Changes 입력창의 커밋 메시지. 비어 있으면 메시지 hook은 건너뛴다.
   * @returns 실행 출력, 건너뛴 hook, staged 파일 수와 전체 transcript
   */
  async run(commitMessage = ""): Promise<CommitHookPreflightResult> {
    const startedAt = Date.now();
    const normalizedMessage = commitMessage.trim();
    const preparation = await this.prepare();
    const transcript: string[] = [
      "Staged commit hook preflight",
      `Staged files: ${preparation.stagedFileCount}`,
      normalizedMessage
        ? "Commit message hooks: enabled"
        : "Commit message hooks: skipped because the message is empty",
      "The real Git index is isolated through a temporary GIT_INDEX_FILE.",
    ];
    let indexPath: string | undefined;
    let temporaryDirectory: string | undefined;
    try {
      indexPath = await copyRealIndexToSibling(this.repoRoot);
      temporaryDirectory = await mkdtemp(
        path.join(tmpdir(), "gsc-hook-preflight-")
      );
      const messageFile = path.join(temporaryDirectory, "COMMIT_EDITMSG");
      await writeFile(messageFile, `${normalizedMessage}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const env = commitPlanGitEnvironment({
        GIT_INDEX_FILE: indexPath,
        GIT_SIMPLE_COMPARE_HOOK_PREFLIGHT: "1",
      });
      const executions: CommitHookPreflightExecution[] = [];
      const skippedHooks: CommitHookName[] = [];
      for (const hook of preparation.enabledHooks) {
        if (!normalizedMessage && MESSAGE_HOOKS.has(hook)) {
          skippedHooks.push(hook);
          transcript.push(`[${hook}] SKIPPED: commit message is empty`);
          continue;
        }
        executions.push(
          await this.runHook(hook, messageFile, env, transcript)
        );
      }
      const finalFingerprint = await readAiCommitPlanIndexFingerprint(
        this.repoRoot
      );
      if (finalFingerprint !== preparation.indexFingerprint) {
        transcript.push(
          "[staged snapshot] CHANGED: run the checks again for the current index"
        );
        throw new CommitHookPreflightError(
          "stagedChangesChanged",
          "Staged changes changed while commit hooks were running.",
          undefined,
          joinTranscript(transcript)
        );
      }
      transcript.push("RESULT: PASSED");
      return {
        stagedFileCount: preparation.stagedFileCount,
        executions,
        skippedHooks,
        transcript: joinTranscript(transcript),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (indexPath) {
        cleanupCommitPlanIndex(indexPath);
      }
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  /**
   * 실행 전에 active operation, 충돌, staged 존재 여부, 활성 hook과 index identity를 한 번 고정한다.
   * @returns 실행 전체가 공유할 staged 파일 수, hook 목록, index fingerprint
   */
  private async prepare(): Promise<{
    stagedFileCount: number;
    enabledHooks: CommitHookName[];
    indexFingerprint: string;
  }> {
    const [operation, unmerged, stagedRaw, enabledHooks, indexFingerprint] =
      await Promise.all([
        detectOperation(this.repoRoot),
        runGit(["ls-files", "--unmerged", "-z"], this.repoRoot),
        runGit(
          ["diff", "--cached", "--name-only", "-z", "--"],
          this.repoRoot
        ),
        new CommitHookService(this.repoRoot).enabledEntrypoints(),
        readAiCommitPlanIndexFingerprint(this.repoRoot),
      ]);
    if (operation !== "none") {
      throw new CommitHookPreflightError(
        "operationInProgress",
        `Finish or abort the active ${operation} operation before previewing commit hooks.`,
        undefined,
        "",
        operation
      );
    }
    if (unmerged) {
      throw new CommitHookPreflightError(
        "unmergedIndex",
        "Resolve merge conflicts before previewing commit hooks."
      );
    }
    const stagedFileCount = stagedRaw.split("\0").filter(Boolean).length;
    if (stagedFileCount === 0) {
      throw new CommitHookPreflightError(
        "noStagedChanges",
        "There are no staged changes to check."
      );
    }
    const enabled = new Set(enabledHooks);
    return {
      stagedFileCount,
      enabledHooks: PREFLIGHT_HOOK_ORDER.filter((hook) => enabled.has(hook)),
      indexFingerprint,
    };
  }

  /**
   * 표준 hook 한 건을 `git hook run`으로 실행해 Git의 hooksPath/환경 처리를 그대로 사용한다.
   * @param hook 실행할 차단 hook 이름
   * @param messageFile prepare-commit-msg/commit-msg에 전달할 임시 메시지 파일
   * @param env 실제 index 대신 sibling index를 가리키는 상속 환경
   * @param transcript 성공/실패 출력을 누적할 전체 로그 행
   * @returns 성공한 hook의 출력과 실행 시간
   */
  private async runHook(
    hook: CommitHookName,
    messageFile: string,
    env: Record<string, string>,
    transcript: string[]
  ): Promise<CommitHookPreflightExecution> {
    const startedAt = Date.now();
    transcript.push(`[${hook}] STARTED`);
    try {
      const output = await runGitDetailed(
        hookRunArguments(hook, messageFile),
        this.repoRoot,
        { env, retryOnLock: false }
      );
      appendHookOutput(transcript, hook, output);
      const durationMs = Date.now() - startedAt;
      transcript.push(`[${hook}] PASSED (${durationMs} ms)`);
      return { hook, ...output, durationMs };
    } catch (error) {
      const output = gitErrorOutput(error);
      appendHookOutput(transcript, hook, output);
      transcript.push(`[${hook}] FAILED (${Date.now() - startedAt} ms)`);
      throw new CommitHookPreflightError(
        "hookFailed",
        `${hook} rejected the staged changes.`,
        hook,
        joinTranscript(transcript),
        undefined,
        error
      );
    }
  }
}

/**
 * hook별 실제 Git 인자 규약을 한곳에서 만든다.
 * @param hook 실행할 차단 hook
 * @param messageFile 메시지 hook이 읽고 수정할 임시 파일
 * @returns `runGitDetailed`에 전달할 인자 배열
 */
function hookRunArguments(
  hook: CommitHookName,
  messageFile: string
): string[] {
  if (hook === "prepare-commit-msg") {
    return [
      "hook",
      "run",
      "--ignore-missing",
      hook,
      "--",
      messageFile,
      "message",
    ];
  }
  if (hook === "commit-msg") {
    return [
      "hook",
      "run",
      "--ignore-missing",
      hook,
      "--",
      messageFile,
    ];
  }
  return ["hook", "run", "--ignore-missing", hook];
}

/**
 * 한 hook의 stdout/stderr를 stream 구분 marker와 함께 전체 transcript에 추가한다.
 * @param transcript 전체 실행 로그 행
 * @param hook 현재 hook 이름
 * @param output 성공 또는 실패 프로세스의 두 출력 스트림
 */
function appendHookOutput(
  transcript: string[],
  hook: CommitHookName,
  output: GitCommandOutput
): void {
  if (output.stdout) {
    transcript.push(
      `[${hook}] stdout`,
      withoutSingleTerminalNewline(output.stdout)
    );
  }
  if (output.stderr) {
    transcript.push(
      `[${hook}] stderr`,
      withoutSingleTerminalNewline(output.stderr)
    );
  }
}

/**
 * transcript 행 join이 원본 끝 개행을 하나 더 만들지 않도록 terminal newline 한 개만 제거한다.
 * - 나머지 공백과 여러 빈 줄은 hook 원문 그대로 보존한다.
 * @param output hook stdout 또는 stderr 전체 문자열
 * @returns 끝의 LF/CRLF 한 개만 제외한 문자열
 */
function withoutSingleTerminalNewline(output: string): string {
  return output.replace(/\r?\n$/, "");
}

/**
 * 알 수 없는 hook 오류에서 GitError의 두 출력 스트림을 안전하게 꺼낸다.
 * @param error runGitDetailed이 던진 오류
 * @returns transcript 누적에 사용할 stdout/stderr
 */
function gitErrorOutput(error: unknown): GitCommandOutput {
  if (error instanceof GitError) {
    return { stdout: error.stdout, stderr: error.stderr };
  }
  return {
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  };
}

/**
 * 로그 행 목록을 OUTPUT 블록에 적합한 끝 개행 포함 문자열로 만든다.
 * @param lines 단계 marker와 원본 출력 행
 * @returns 비어 있지 않은 단일 transcript
 */
function joinTranscript(lines: readonly string[]): string {
  return `${lines.filter((line) => line.length > 0).join("\n")}\n`;
}
