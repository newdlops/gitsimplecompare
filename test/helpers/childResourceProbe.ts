// 실행 구간 계측만 사용하는 작은 POSIX 모듈을 소유 임시 디렉터리에 빌드한다.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

export interface ChildResourceCounters { userCpuMs: number; systemCpuMs: number; minorFaults: number; majorFaults: number }

/**
 * Node와 같은 설치본의 헤더로 계측 모듈을 빌드하고 동기 counter 함수를 반환한다.
 * @param directory caller가 정리할 작업트리 밖 소유 디렉터리 @returns 종료·wait된 자식의 누적 카운터
 */
export async function loadChildResourceProbe(directory: string): Promise<() => ChildResourceCounters> {
  assert.notEqual(process.platform, "win32", "Child resource profiling requires POSIX getrusage");
  const headers = path.resolve(path.dirname(process.execPath), "..", "include", "node");
  await access(path.join(headers, "node_api.h"));
  const source = path.join(process.cwd(), "scripts/child-resource-probe.c"), output = path.join(directory, "child-resource-probe.node");
  await promisify(execFile)("/usr/bin/cc", ["-std=c11", "-O2", "-shared", "-fPIC", "-I", headers,
    ...(process.platform === "darwin" ? ["-undefined", "dynamic_lookup"] : []), source, "-o", output], { maxBuffer: 1024 * 1024 });
  const probe = createRequire(path.join(process.cwd(), "package.json"))(output) as { capture: () => ChildResourceCounters };
  assert.equal(typeof probe.capture, "function");
  return probe.capture;
}
