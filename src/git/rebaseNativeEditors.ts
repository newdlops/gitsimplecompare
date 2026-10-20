// 번들 rebase sequence helper의 단순 todo 복사에서 Node 시작 비용을 줄인다.
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";

// 별도 editorScript의 동작/실패를 생략하지 않는다. 번들 helper가 바뀌면 seq 규약을 재검증하고 갱신한다.
const BUNDLED_EDITOR_SHA256 = "13d079f40c54a4b92643cce842ca22b263e096b5f5079b9cd945b8b806288ac2";

/** Git이 POSIX shell로 해석할 데이터 한 개를 인용한다. 경로의 $, backtick, 개행을 실행하지 않는다. */
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/**
 * 임의 스크립트가 아니라 같은 seq 규약을 가진 실제 번들과 실행 가능한 cp만 대체한다.
 * @param editorScript caller가 전달한 원본 helper 경로 @returns 내용과 플랫폼이 검증되면 true
 */
async function canCopy(editorScript: string): Promise<boolean> {
  if (process.platform !== "darwin" && process.platform !== "linux") return false;
  try {
    await fs.access("/bin/cp", constants.X_OK);
    return createHash("sha256").update(await fs.readFile(editorScript)).digest("hex") === BUNDLED_EDITOR_SHA256;
  } catch { return false; }
}

/**
 * todo 전체 복사에 Node를 새로 시작하지 않는다. 복사 실패는 같은 원본과 target으로 기존 helper에 위임한다.
 * @param todoFile 이 Start가 쓴 확정 todo @param editorScript 기존 seq helper @param nodePath Node/Electron 실행 파일
 * @param enabled 번들 helper임을 아는 조립 계층의 명시적 사용 허용
 * @returns Git sequence editor 명령과 OUTPUT용 실행 종류. Windows와 임의 helper의 기존 명령 형식은 유지한다.
 */
export async function rebaseSequenceEditor(todoFile: string, editorScript: string, nodePath = process.execPath, enabled = false) {
  const legacy = `"${nodePath}" "${editorScript}" seq`;
  if (!enabled || !await canCopy(editorScript)) return { command: legacy, kind: "node" };
  const fallback = `${quote(nodePath)} ${quote(editorScript)} seq "$1"`;
  // cp는 target directory를 성공으로 취급하므로 Git이 만든 일반 파일만 native로 복사한다.
  return { kind: "copy", command: `gsc_seq() { if [ -f "$1" ]; then /bin/cp ${quote(todoFile)} "$1" || ${fallback}; else ${fallback}; fi; }; gsc_seq` };
}
