// untracked 파일 때문에 checkout 이 막힌 경우를 사용자가 편집 가능한 marker 파일로 변환한다.
// - Git 은 untracked overwrite 를 native unmerged index 로 만들지 않으므로, current/incoming 내용을
//   한 파일에 conflict marker 로 써서 VS Code editor 에서 직접 해결할 수 있게 한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GitError, runGit } from "./gitExec";

/** marker 파일로 만든 untracked checkout 충돌 정보 */
export interface UntrackedCheckoutConflictFile {
  path: string;
  backupPath: string;
}

interface PendingUntrackedConflict {
  rel: string;
  abs: string;
  backupAbs: string;
  current: string;
  incoming: string;
}

/**
 * git checkout/switch 오류에서 untracked overwrite 경로를 추출한다.
 * @param err git switch/checkout 실패 오류
 * @returns 오류 메시지에 들어 있던 저장소 상대 경로 목록
 */
export function untrackedCheckoutPaths(err: unknown): string[] {
  const text = errorFullText(err);
  const paths = new Set<string>();
  for (const match of text.matchAll(/untracked working tree file '([^']+)' would be overwritten/gi)) {
    paths.add(match[1]);
  }
  const lines = text.split(/\r?\n/);
  let collecting = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/untracked working tree files? would be (overwritten|removed)/i.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) {
      continue;
    }
    if (!line || /^(Please|Aborting|error:|hint:)/i.test(line)) {
      collecting = false;
      continue;
    }
    paths.add(line);
  }
  return Array.from(paths).filter(Boolean);
}

/**
 * checkout 실패가 untracked overwrite 때문인지 확인한다.
 * @param err git switch/checkout 실패 오류
 */
export function isUntrackedCheckoutBlocker(err: unknown): boolean {
  return untrackedCheckoutPaths(err).length > 0;
}

/**
 * untracked 파일을 임시 백업한 뒤 checkout 을 실행하고, checkout 후 같은 경로에 current/incoming marker 파일을 쓴다.
 * @param repoRoot  저장소 루트
 * @param targetRef checkout 대상 ref. incoming 내용을 읽는 기준으로 쓴다.
 * @param paths     untracked overwrite 경로 목록
 * @param checkout  untracked 파일을 치운 뒤 실행할 실제 checkout 함수
 * @returns marker 파일로 변환된 경로와 백업 위치
 */
export async function materializeUntrackedCheckoutConflicts(
  repoRoot: string,
  targetRef: string,
  paths: string[],
  checkout: () => Promise<void>
): Promise<UntrackedCheckoutConflictFile[]> {
  const pending = await buildPendingConflicts(repoRoot, targetRef, paths);
  await moveUntrackedFiles(pending);
  try {
    await checkout();
  } catch (err) {
    await restoreMovedFiles(pending);
    throw err;
  }
  await writeMarkerFiles(targetRef, pending);
  return pending.map((item) => ({
    path: item.rel,
    backupPath: item.backupAbs,
  }));
}

/**
 * current/incoming 내용을 미리 읽고 checkout 중 이동할 백업 위치를 계산한다.
 * @param repoRoot  저장소 루트
 * @param targetRef incoming 파일을 읽을 ref
 * @param paths     git 오류에서 추출한 경로 목록
 */
async function buildPendingConflicts(
  repoRoot: string,
  targetRef: string,
  paths: string[]
): Promise<PendingUntrackedConflict[]> {
  const backupRoot = await backupRootFor(repoRoot);
  const unique = Array.from(new Set(paths.map(normalizeRelPath))).filter(Boolean);
  return Promise.all(unique.map(async (rel) => {
    const abs = safeJoin(repoRoot, rel);
    const backupAbs = safeJoin(backupRoot, rel);
    const [current, incoming] = await Promise.all([
      fs.readFile(abs, "utf8"),
      runGit(["show", `${targetRef}:${rel}`], repoRoot).catch(() => ""),
    ]);
    return { rel, abs, backupAbs, current, incoming };
  }));
}

/**
 * git 내부 백업 디렉터리를 만든다.
 * @param repoRoot 저장소 루트
 */
async function backupRootFor(repoRoot: string): Promise<string> {
  const raw = (await runGit(
    ["rev-parse", "--git-path", `gsc-untracked-checkout/${Date.now()}`],
    repoRoot
  )).trim();
  return path.resolve(repoRoot, raw);
}

/**
 * checkout 전에 untracked 파일을 안전한 백업 위치로 옮긴다.
 * @param pending 이동할 파일 목록
 */
async function moveUntrackedFiles(
  pending: PendingUntrackedConflict[]
): Promise<void> {
  for (const item of pending) {
    await fs.mkdir(path.dirname(item.backupAbs), { recursive: true });
    await fs.rename(item.abs, item.backupAbs);
  }
}

/**
 * checkout 재시도가 실패했을 때 백업한 untracked 파일을 원위치한다.
 * @param pending 이동했던 파일 목록
 */
async function restoreMovedFiles(
  pending: PendingUntrackedConflict[]
): Promise<void> {
  for (const item of [...pending].reverse()) {
    await fs.mkdir(path.dirname(item.abs), { recursive: true });
    await fs.rename(item.backupAbs, item.abs).catch(() => undefined);
  }
}

/**
 * checkout 완료 후 실제 작업 파일에 current/incoming marker 를 쓴다.
 * @param targetRef incoming 라벨에 표시할 ref
 * @param pending   marker 로 변환할 파일 목록
 */
async function writeMarkerFiles(
  targetRef: string,
  pending: PendingUntrackedConflict[]
): Promise<void> {
  for (const item of pending) {
    await fs.mkdir(path.dirname(item.abs), { recursive: true });
    await fs.writeFile(
      item.abs,
      conflictMarkerText(item.current, item.incoming, targetRef),
      "utf8"
    );
  }
}

/**
 * current/incoming 내용을 표준 conflict marker 형식으로 합친다.
 * @param current  checkout 전 untracked 파일 내용
 * @param incoming checkout 대상 ref 의 파일 내용
 * @param targetRef incoming 라벨
 */
function conflictMarkerText(
  current: string,
  incoming: string,
  targetRef: string
): string {
  return [
    "<<<<<<< current (untracked before checkout)\n",
    ensureLine(current),
    "=======\n",
    ensureLine(incoming),
    `>>>>>>> incoming (${targetRef})\n`,
  ].join("");
}

/**
 * marker 경계가 파일 내용과 붙지 않도록 마지막 줄바꿈을 보강한다.
 * @param text 파일 내용
 */
function ensureLine(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * 저장소 상대 경로 문자열을 비교적 안전한 POSIX 스타일로 정규화한다.
 * @param rel git 오류 메시지에서 나온 경로
 */
function normalizeRelPath(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\/+/, "");
}

/**
 * 상대 경로가 기준 디렉터리 밖으로 탈출하지 않도록 검사하며 결합한다.
 * @param base 기준 디렉터리
 * @param rel  상대 경로
 */
function safeJoin(base: string, rel: string): string {
  const resolved = path.resolve(base, rel);
  const normalizedBase = path.resolve(base);
  if (resolved !== normalizedBase && !resolved.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new Error(`Unsafe checkout conflict path: ${rel}`);
  }
  return resolved;
}

/** stderr 까지 포함해 git 오류 메시지를 파싱용 문자열로 만든다. */
function errorFullText(err: unknown): string {
  return err instanceof GitError
    ? `${err.message}\n${err.stderr}`
    : err instanceof Error
      ? err.message
      : String(err);
}
