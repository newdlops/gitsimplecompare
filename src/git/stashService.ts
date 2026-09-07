// stash의 표시 번호와 실제 commit identity를 분리한다. 목록 변화가 다른 항목의 적용/삭제로 이어지지 않게 한다.
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { GitError, runGit } from "./gitExec";
import { parseNameStatusZ } from "./diffParse";
import type { FileChange, StashEntry } from "./gitTypes";
import { runStash, stashPushPaths } from "./stashExec";
import { logInfo } from "../ui/outputLog";

/** 화면에서 선택한 stash 번호와 변경되지 않는 전체 commit hash다. */
export interface StashTarget {
  ref: string;
  hash: string;
}

/** 기존 명령 호출자는 번호를 넘길 수 있지만 확인창 전에 resolve로 고정해야 한다. */
export type StashSelection = string | StashTarget;

const mutations = new Map<string, Promise<void>>();

/** 저장소별 stash 조회 및 선택한 hash에 고정된 변경 작업을 제공한다. */
export class StashService {
  constructor(private readonly repoRoot: string) {}

  /**
   * reflog를 읽어 번호, 메시지, hash를 함께 반환한다. stash가 없는 경우만 빈 목록이다.
   * @returns 현재 stash stack. Git 조회 오류는 호출자에게 전달한다.
   */
  async list(): Promise<StashEntry[]> {
    try {
      await runGit(["show-ref", "--verify", "--quiet", "refs/stash"], this.repoRoot);
    } catch (error) {
      if (error instanceof GitError && error.code === 1) return [];
      throw error;
    }
    const output = await runGit([
      "reflog", "show", "--max-count=10000",
      "--format=%gd%x1f%gs%x1f%cr%x1f%H%x1e", "refs/stash",
    ], this.repoRoot);
    const entries: StashEntry[] = [];
    for (const record of output.split("\x1e")) {
      const line = record.replace(/^\s+/, "");
      if (!line) continue;
      const [ref, subject, relativeDate, hash] = line.split("\x1f");
      const indexMatch = /(?:refs\/)?stash@\{(\d+)\}/.exec(ref);
      if (!indexMatch || !isHash(hash)) throw new Error("Git returned an invalid stash entry.");
      const index = Number(indexMatch[1]);
      const message = /^(?:WIP on|On) ([^:]+):\s?(.*)$/.exec(subject ?? "");
      entries.push({
        index, ref: `stash@{${index}}`, hash, relativeDate: relativeDate ?? "",
        branch: message?.[1] ?? "", message: message?.[2] || subject || "",
      });
    }
    return entries;
  }

  /**
   * 선택 당시 hash를 현재 목록과 대조한다. hash가 사라져도 같은 번호의 다른 항목으로 바꾸지 않는다.
   * @param selection 기존 번호/해시 문자열 또는 렌더 당시 ref/hash
   * @returns 선택한 항목의 현재 번호 및 metadata
   */
  async resolve(selection: StashSelection): Promise<StashEntry> {
    const entries = await this.list();
    const hash = typeof selection === "string" ? (isHash(selection) ? selection : undefined) : selection.hash;
    if (typeof selection !== "string" && !isHash(hash)) throw staleStash();
    const matches = entries.filter(entry => hash ? entry.hash === hash : entry.ref === selection);
    if (matches.length !== 1) throw staleStash();
    return matches[0];
  }

  /**
   * 이미 고정한 stash의 파일 목록을 읽는다. 실패한 조회는 빈 결과로 캐시하지 않는다.
   * @param ref stash 전체 hash 또는 기존 stash 번호
   * @returns stash에 포함된 추적/미추적 파일 변경 목록
   */
  async files(ref: string): Promise<FileChange[]> {
    const hash = isHash(ref) ? ref : (await this.resolve(ref)).hash;
    return parseNameStatusZ(await runStash([
      "show", "--include-untracked", "--name-status", "-z", hash,
    ], this.repoRoot));
  }

  /** 선택 경로 또는 전체 변경을 보존하며 같은 저장소의 다른 stash 액션과 겹치지 않게 한다. */
  async push(paths: string[], message?: string): Promise<void> {
    await this.exclusive(() => stashPushPaths(this.repoRoot, paths, message));
  }

  /**
   * 선택한 hash만 적용한다. pop은 적용 성공 뒤 이동한 번호를 다시 찾아 제거한다.
   * @param selection 확인 시점에 고정한 대상
   * @param pop 성공한 항목을 목록에서도 제거할지 여부
   */
  async apply(selection: StashSelection, pop = false): Promise<void> {
    const target = await this.resolve(selection);
    await this.exclusive(async () => {
      await this.resolve(target);
      await runStash(["apply", target.hash], this.repoRoot, { retryOnLock: false });
      if (pop) await this.dropResolved(target);
      logInfo(pop ? "selected stash popped" : "selected stash applied", { repoRoot: this.repoRoot, hash: target.hash });
    });
  }

  /** 확인한 hash가 현재 stack에서 가리키는 항목만 삭제한다. 사라진 선택은 실패로 처리한다. */
  async drop(selection: StashSelection): Promise<void> {
    const target = await this.resolve(selection);
    await this.exclusive(() => this.dropResolved(target));
  }

  /**
   * stash 생성 당시 commit에서 새 브랜치를 만들고 선택한 hash를 적용한다.
   * @param name 새 로컬 브랜치 이름
   * @param selection 이름 입력창 전에 고정한 stash
   */
  async branch(name: string, selection: StashSelection): Promise<void> {
    const target = await this.resolve(selection);
    await this.exclusive(async () => {
      await this.resolve(target);
      await runGit(["check-ref-format", "--branch", name], this.repoRoot);
      // hash로 branch를 실행하면 Git이 번호 기반 자동 drop을 하지 않으므로 성공 후 직접 검증한다.
      await runStash(["branch", name, target.hash], this.repoRoot, { retryOnLock: false });
      await this.dropResolved(target);
    });
  }

  /**
   * 삭제 직전에 최신 번호와 hash를 재검증한다. 외부 프로세스에 의한 번호 변경을 발견하면 중단한다.
   * @param target 처음 선택한 stash identity
   */
  private async dropResolved(target: StashTarget): Promise<void> {
    const current = await this.resolve(target);
    const actual = (await runGit(["rev-parse", "--verify", `${current.ref}^{commit}`], this.repoRoot)).trim();
    if (actual !== target.hash) throw staleStash();
    await runStash(["drop", current.ref], this.repoRoot, { retryOnLock: false });
    logInfo("selected stash dropped", { repoRoot: this.repoRoot, ref: current.ref, hash: target.hash });
  }

  /**
   * linked worktree가 공유하는 stash stack 단위로 확장의 stash 변경 명령을 직렬화한다.
   * @param action 번호 조회부터 적용/삭제 완료까지 잠글 작업
   * @returns 작업 결과. 이전 실패가 다음 작업을 막지 않도록 큐만 정상 종료시킨다.
   */
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const common = (await runGit(["rev-parse", "--git-common-dir"], this.repoRoot)).trim();
    const key = await realpath(path.resolve(this.repoRoot, common));
    const previous = mutations.get(key) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => undefined, () => undefined);
    mutations.set(key, tail);
    try { return await result; }
    finally { if (mutations.get(key) === tail) mutations.delete(key); }
  }
}

/** Git의 SHA-1/SHA-256 전체 OID만 허용해 ref 표현식을 hash로 오인하지 않게 한다. */
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

/** 사라졌거나 여러 항목과 겹치는 stash를 다른 번호로 대체하지 않고 중단한다. */
function staleStash(): Error {
  return new Error("The selected stash is no longer uniquely available. Refresh the stash list and select it again.");
}
