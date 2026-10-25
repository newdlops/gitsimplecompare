// 저장소 탐색을 공유해도 되는 표준 Native Git 실행 파일을 확인한다. 사용자 wrapper는 추측하지 않는다.
import { open, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * 설정에 절대 경로가 있어도 표준 배포 위치의 Native Git이면 기존 탐색 공유를 사용할 수 있다.
 * 완료 결과는 저장하지 않아 Git 업데이트나 wrapper 교체가 다음 요청에 반영된다.
 */
export class RepositoryDiscoveryExecutables {
  private pending = new Map<string, Promise<boolean>>();

  /** @param executable 설정에서 선택된 실행 값 @returns 기본 git 또는 확인된 표준 Native binary일 때만 true. */
  async canShare(executable: string): Promise<boolean> {
    if (executable === "git") return true;
    if (!path.isAbsolute(executable) || !standardPath(executable)) return false;
    const pending = this.pending, existing = pending.get(executable);
    if (existing) return existing;
    const result = verifyNative(executable);
    if (pending.size < 32) pending.set(executable, result);
    try { return await result; }
    finally { if (pending.get(executable) === result) pending.delete(executable); }
  }

  /** 설정/저장소 무효화 이전의 확인이 새 요청에 합류하지 않게 진행 map을 교체한다. */
  clear(): void { this.pending = new Map(); }
}

/** @param file 요청 경로나 symlink의 최종 경로 @returns 알려진 OS/Git 배포 위치인지 여부. 임의의 custom 경로는 제외한다. */
function standardPath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (process.platform === "win32") {
    return /^[a-z]:\/Program Files(?: \(x86\))?\/Git\/(?:cmd|bin|mingw(?:32|64)\/bin)\/git\.exe$/i.test(normalized);
  }
  return /^\/(?:usr\/(?:local\/)?bin|bin|opt\/homebrew\/bin)\/git$/.test(normalized)
    || /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/git\/[^/]+\/(?:bin|libexec\/git-core)\/git$/.test(normalized)
    || normalized === "/Library/Developer/CommandLineTools/usr/bin/git"
    || /^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer\/usr\/bin\/git$/.test(normalized);
}

/**
 * 알려진 경로라도 shell/node script는 허용하지 않고 Mach-O/ELF/PE 헤더를 확인한다.
 * @param executable 원래 설정 값 @returns 실제 파일과 최종 symlink 대상이 표준 Native Git이면 true. 오류는 Native fallback이다.
 */
async function verifyNative(executable: string): Promise<boolean> {
  try {
    const target = await realpath(executable);
    if (!standardPath(target)) return false;
    const file = await open(target, "r");
    try {
      const before = await file.stat();
      if (!before.isFile()) return false;
      const bytes = Buffer.alloc(64), read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead < 64) return false;
      const magic = bytes.subarray(0, 4).toString("hex");
      let native = ["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic);
      if (bytes.readUInt16LE(0) === 0x5a4d) {
        const offset = bytes.readUInt32LE(60), signature = Buffer.alloc(4);
        native = offset >= 64 && offset <= before.size - 4
          && (await file.read(signature, 0, 4, offset)).bytesRead === 4 && signature.equals(Buffer.from([0x50, 0x45, 0, 0]));
      }
      const after = await file.stat();
      return native && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
    } finally { await file.close(); }
  } catch { return false; }
}
