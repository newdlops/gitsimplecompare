import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { findRebaseMarkerFiles, MAX_REBASE_MARKER_SCAN_BYTES as MAX_BYTES } from "../src/git/rebaseMarkerScanner";

const MARKERS = "<<<<<<< current\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> incoming\r\n";

/** Git 명령 없이도 검사할 수 있는 소유 임시 작업트리와 외부 경로를 만들고 모두 정리한다. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "gsc-rebase-marker-"));
  const root = join(directory, "repo"), outside = join(directory, "outside");
  await mkdir(root); await mkdir(outside);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root, outside };
}

test("marker scans preserve literal paths, input order, CRLF and the existing NUL classification", async t => {
  const { root } = await fixture(t);
  const literal = process.platform === "win32" ? "literal[1].txt" : "literal[?]*\n.txt";
  const files = ["later.txt", "clean.txt", literal, "quoted.txt", "nul-tail.bin", "invalid-utf8.txt", "directory", "missing.txt"];
  await writeFile(join(root, files[0]), MARKERS);
  await writeFile(join(root, files[1]), "ordinary text\n");
  await writeFile(join(root, literal), "한글🙂\n=======\n");
  await writeFile(join(root, "quoted.txt"), 'const marker = "<<<<<<<";\n');
  await writeFile(join(root, "nul-tail.bin"), Buffer.concat([Buffer.from(MARKERS), Buffer.alloc(9000, 97), Buffer.from([0])]));
  await writeFile(join(root, "invalid-utf8.txt"), Buffer.concat([Buffer.from(MARKERS), Buffer.from([0xff])]));
  await mkdir(join(root, "directory"));
  assert.deepEqual(await findRebaseMarkerFiles(root, [...files, files[0]]), [files[0], literal, "invalid-utf8.txt"]);
});

test("the exact two-MiB boundary is included while oversized files and a late NUL are excluded", async t => {
  const { root } = await fixture(t);
  const exact = Buffer.alloc(MAX_BYTES, 97);
  exact.write("\n=======\n", exact.length - 9);
  await writeFile(join(root, "exact.txt"), exact);
  const binary = Buffer.from(exact); binary[binary.length - 1] = 0;
  await writeFile(join(root, "late-nul.txt"), binary);
  await writeFile(join(root, "large.txt"), Buffer.concat([exact, Buffer.from("x")]));
  const open = fs.promises.open;
  const opened: string[] = [];
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => { opened.push(String(args[0])); return open(...args); });
  assert.deepEqual(await findRebaseMarkerFiles(root, ["late-nul.txt", "large.txt", "exact.txt"]), ["exact.txt"]);
  assert.equal(opened.includes(join(root, "large.txt")), false, "Known oversized files must not be opened");
});

test("leaf and parent symlinks never contribute markers from an external file", { skip: process.platform === "win32" }, async t => {
  const { directory, root, outside } = await fixture(t);
  await writeFile(join(root, "safe.txt"), MARKERS);
  await writeFile(join(outside, "secret.txt"), MARKERS);
  await symlink(join(outside, "secret.txt"), join(root, "leaf.txt"));
  await symlink(outside, join(root, "parent"), "dir");
  const open = fs.promises.open;
  const opened: string[] = [];
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => { opened.push(String(args[0])); return open(...args); });
  assert.deepEqual(await findRebaseMarkerFiles(root, ["leaf.txt", "safe.txt", "parent/secret.txt"]), ["safe.txt"]);
  assert.deepEqual(opened, [join(root, "safe.txt")]);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), MARKERS);
  const alias = join(directory, "repo-alias"); await symlink(root, alias, "dir");
  assert.deepEqual(await findRebaseMarkerFiles(alias, ["safe.txt"]), ["safe.txt"], "A symlink repository root remains supported");
});

test("growth after the FD size check cannot cause more than the scan ceiling to be read", async t => {
  const { root } = await fixture(t);
  const file = join(root, "growing.txt"); await writeFile(file, MARKERS);
  const open = fs.promises.open;
  let bytes = 0, closes = 0;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]) !== file) return handle;
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    let first = true;
    t.mock.method(handle, "read", (async (...values: any[]) => {
      if (first) { first = false; await appendFile(file, Buffer.alloc(MAX_BYTES + 128, 97)); }
      const result = await (read as Function)(...values); bytes += result.bytesRead; return result;
    }) as typeof read);
    t.mock.method(handle, "close", async () => { closes++; await close(); });
    return handle;
  });
  assert.deepEqual(await findRebaseMarkerFiles(root, ["growing.txt"]), []);
  assert.equal(bytes, MAX_BYTES + 1);
  assert.equal(closes, 1);
});

test("smaller growth reads through EOF and still rejects binary data after the visible marker", async t => {
  const { root } = await fixture(t);
  const names = ["text.txt", "binary.txt"];
  for (const name of names) await writeFile(join(root, name), MARKERS);
  const open = fs.promises.open;
  const closed = new Set<string>();
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args), file = String(args[0]);
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    let first = true;
    t.mock.method(handle, "read", (async (...values: any[]) => {
      if (first) {
        first = false;
        await appendFile(file, Buffer.concat([Buffer.alloc(20_000, 97), Buffer.from(file.endsWith("binary.txt") ? [0] : [10])]));
      }
      return (read as Function)(...values);
    }) as typeof read);
    t.mock.method(handle, "close", async () => { closed.add(file); await close(); });
    return handle;
  });
  assert.deepEqual(await findRebaseMarkerFiles(root, names), ["text.txt"]);
  assert.equal(closed.size, names.length);
});

test("one failed file read closes its FD and does not suppress successful siblings", async t => {
  const { root } = await fixture(t);
  for (const name of ["failed.txt", "valid.txt"]) await writeFile(join(root, name), MARKERS);
  const open = fs.promises.open;
  let failedClosed = false;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]) === join(root, "failed.txt")) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, "read", async () => { throw Object.assign(new Error("read failed"), { code: "EIO" }); });
      t.mock.method(handle, "close", async () => { failedClosed = true; await close(); });
    }
    return handle;
  });
  assert.deepEqual(await findRebaseMarkerFiles(root, ["failed.txt", "valid.txt"]), ["valid.txt"]);
  assert.equal(failedClosed, true);
});

test("a regular leaf replaced with a symlink before open cannot read an external target", { skip: process.platform === "win32" }, async t => {
  const { root, outside } = await fixture(t);
  const file = join(root, "changed.txt"), secret = join(outside, "secret.txt");
  await writeFile(file, "ordinary text\n"); await writeFile(secret, MARKERS);
  const open = fs.promises.open;
  let replaced = false;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    if (String(args[0]) === file && !replaced) {
      replaced = true; await rename(file, join(root, "original.txt")); await symlink(secret, file);
    }
    return open(...args);
  });
  assert.deepEqual(await findRebaseMarkerFiles(root, ["changed.txt"]), []);
  assert.equal(await readFile(secret, "utf8"), MARKERS);
});

test("unsafe, empty and missing candidates require no file opens", async t => {
  const { root } = await fixture(t);
  const open = fs.promises.open;
  let calls = 0;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => { calls++; return open(...args); });
  assert.deepEqual(await findRebaseMarkerFiles("/missing/repository", []), []);
  assert.deepEqual(await findRebaseMarkerFiles(root, ["../escape.txt", "", "bad\0name.txt", "missing.txt"]), []);
  assert.equal(calls, 0);
});
