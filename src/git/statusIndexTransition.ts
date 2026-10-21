// Git 자신이 추적 경로와 UNTR 캐시를 함께 갱신하게 하는 전용 index 이행 경계.
import { readFile, writeFile } from "node:fs/promises";
import { runGitWithInput, withGitConfigOverrides } from "./gitExec";
import { isGitLifecycleError } from "./gitError";
import { isOwnedStatusIndex, PRIVATE_STATUS_INDEX_UPDATE_ARGS } from "./statusIndexOwnership";
import { planStatusIndexTransition, restoreStatusIndexMetadata, type StatusIndexSource } from "./statusIndexStagingIdentity";

type Logger = (event: string, fields: Record<string, unknown>) => void;

/**
 * 확장 소유 index의 작은 stage 차이를 Native로 반영하고 현재 stat을 다시 결합한다.
 * @param root 작업트리 루트 @param index registry에 등록한 전용 index 경로
 * @param source stat 전후 검증한 현재 실제 index 바이트 @param previousIdentity 이전 stage의 식별자
 * @param signal 현재 상태 조회의 수명 @param log OUTPUT 상태 전환 기록
 * @param warmed 동일한 이전 stage에서 완료된 optional warmup 사본. 없으면 현재 전용 파일을 읽는다.
 * @param inspection 같은 source 사본의 조회 범위 해석. 다른 Buffer나 변경된 바이트는 재사용하지 않는다.
 * @returns 현재 source와 stage/flags가 정확히 같은 새 사본. 미지원/일반 실패는 undefined로 전체 복사에 복구한다.
 * source와 실제 작업 파일은 쓰지 않으며 취소·시간 초과는 호출자에게 전파한다.
 */
export async function transitionStatusIndex(root: string, index: string, source: Buffer, previousIdentity: string,
  signal: AbortSignal, log: Logger, warmed?: Buffer, inspection?: StatusIndexSource): Promise<Buffer | undefined> {
  signal.throwIfAborted();
  if (!isOwnedStatusIndex(index)) return undefined;
  /** OUTPUT dispose 같은 관찰 실패는 검증된 Native 결과나 fallback 정책을 바꾸지 않는다. */
  const emit: Logger = (event, fields) => { try { log(event, fields); } catch { /* 상태 결과 유지 */ } };
  try {
    const cached = warmed ?? await readFile(index, { signal });
    if (inspection && !inspection.matches(source)) return undefined;
    const plan = inspection ? inspection.planTransition(cached, previousIdentity) : planStatusIndexTransition(cached, source, previousIdentity);
    if (!plan) return undefined;
    signal.throwIfAborted();
    if (warmed) await writeFile(index, warmed, { mode: 0o600, signal });
    await runGitWithInput([...PRIVATE_STATUS_INDEX_UPDATE_ARGS], root, plan.input, {
      signal, retryOnLock: false, privateIndexOnly: true, env: withGitConfigOverrides({ GIT_INDEX_FILE: index }, {
        "core.fsmonitor": "false", "core.splitIndex": "false", "core.untrackedCache": "true",
      }),
    });
    signal.throwIfAborted();
    const updated = await readFile(index, { signal });
    const restored = inspection ? inspection.restoreMetadata(updated) : restoreStatusIndexMetadata(updated, source);
    signal.throwIfAborted();
    if (!restored) throw new Error("Private status index transition did not match the source.");
    emit("private status index transitioned", { repoRoot: root, changedPaths: plan.changedPaths, sourceInspectionReused: !!inspection });
    return restored;
  } catch (error) {
    if (signal.aborted || isGitLifecycleError(error)) throw error;
    emit("private status index transition bypassed", { repoRoot: root, reason: error instanceof Error ? error.name : "transition-failed" });
    return undefined;
  }
}
