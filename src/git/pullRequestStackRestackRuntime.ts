// PR stack restack의 재시작 가능 상태 파일과 operation ID 생성을 담당하는 런타임 유틸리티.
// - service의 계획/실행 정책과 common git dir의 상태 저장을 분리해 충돌 복구 경계를 명확히 한다.
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";

const STATE_RELATIVE_PATH = "gitsimplecompare/stack-restack-state.json";

/** backup ref/state 충돌을 피할 restack operation ID를 생성한다. */
export function makeRestackOperationId(): string {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/** common git dir 아래 restack pending state의 절대 경로를 계산한다. */
async function statePath(repoRoot: string): Promise<string> {
  const common = (await runGit(["rev-parse", "--git-common-dir"], repoRoot)).trim();
  return path.resolve(repoRoot, common, STATE_RELATIVE_PATH);
}

/** pending JSON을 읽는다. 손상되었거나 파일이 없으면 undefined를 반환한다. */
export async function readRestackState<T>(repoRoot: string): Promise<T | undefined> {
  const raw = await fs.readFile(await statePath(repoRoot), "utf8").catch(() => "");
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

/** pending state를 임시 파일과 rename으로 원자적으로 저장한다. */
export async function writeRestackState<T>(repoRoot: string, state: T): Promise<void> {
  const file = await statePath(repoRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

/** 완료 또는 Abort 뒤 pending state를 제거한다. */
export async function clearRestackState(repoRoot: string): Promise<void> {
  await fs.rm(await statePath(repoRoot), { force: true });
}
