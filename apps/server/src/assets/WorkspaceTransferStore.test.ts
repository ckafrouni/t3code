// @effect-diagnostics nodeBuiltinImport:off - tests exercise the native filesystem adapter.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { prepareUpload, receiveUpload } from "./WorkspaceTransferStore.ts";
const roots: string[] = [];
async function root() {
  const value = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-transfer-test-"));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => NodeFSP.rm(r, { recursive: true, force: true })));
});
async function target(
  cwd: string,
  name: string,
  conflict: "ask" | "replace" | "keep-both" | "skip" = "ask",
  kind: "file" | "directory" = "file",
) {
  const result = await prepareUpload({
    cwd,
    path: name,
    sizeBytes: kind === "file" ? 3 : 0,
    kind,
    conflict,
  });
  if (result._tag !== "target") throw new Error(result._tag);
  return result.target;
}
async function* bytes() {
  yield new Uint8Array([0, 255, 42]);
}
describe("workspace transfers", () => {
  it("publishes binary files and nested or empty directories", async () => {
    const cwd = await root();
    const claim = await target(cwd, "nested/report.docx");
    await receiveUpload(claim, bytes());
    expect([...(await NodeFSP.readFile(NodePath.join(cwd, "nested/report.docx")))]).toEqual([
      0, 255, 42,
    ]);
    await receiveUpload(await target(cwd, "empty", "ask", "directory"), (async function* () {})());
    expect((await NodeFSP.stat(NodePath.join(cwd, "empty"))).isDirectory()).toBe(true);
    expect(await NodeFSP.readdir(NodePath.join(cwd, "nested"))).toEqual(["report.docx"]);
  });
  it("reports collisions, keeps both atomically and replaces only the unchanged original", async () => {
    const cwd = await root();
    await NodeFSP.writeFile(NodePath.join(cwd, "report.docx"), "old");
    expect(
      (
        await prepareUpload({
          cwd,
          path: "report.docx",
          kind: "file",
          sizeBytes: 3,
          conflict: "ask",
        })
      )._tag,
    ).toBe("conflict");
    const keep = await target(cwd, "report.docx", "keep-both");
    const saved = await Promise.all([receiveUpload(keep, bytes()), receiveUpload(keep, bytes())]);
    expect(saved.map((r) => r.path).sort()).toEqual(["report (1).docx", "report (2).docx"]);
    expect(await NodeFSP.readFile(NodePath.join(cwd, "report.docx"), "utf8")).toBe("old");
    await receiveUpload(await target(cwd, "report.docx", "replace"), bytes());
    const changed = await target(cwd, "report.docx", "replace");
    await NodeFSP.writeFile(NodePath.join(cwd, "report.docx"), "changed");
    await expect(receiveUpload(changed, bytes())).rejects.toThrow("destination changed");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "report.docx"), "utf8")).toBe("changed");
  });
  it("cleans up aborted, short and oversized uploads without touching originals", async () => {
    const cwd = await root();
    await NodeFSP.writeFile(NodePath.join(cwd, "report.docx"), "old");
    const claim = await target(cwd, "report.docx", "replace");
    for (const size of [1, 4])
      await expect(
        receiveUpload(
          claim,
          (async function* () {
            yield new Uint8Array(size);
          })(),
        ),
      ).rejects.toThrow();
    const controller = new AbortController();
    async function* aborted() {
      yield new Uint8Array([1]);
      controller.abort();
      controller.signal.throwIfAborted();
    }
    await expect(receiveUpload(claim, aborted(), controller.signal)).rejects.toThrow();
    expect(await NodeFSP.readdir(cwd)).toEqual(["report.docx"]);
    expect(await NodeFSP.readFile(NodePath.join(cwd, "report.docx"), "utf8")).toBe("old");
  });
  it("rejects traversal, symlinks and repository metadata", async () => {
    const cwd = await root(),
      outside = await root();
    await NodeFSP.symlink(outside, NodePath.join(cwd, "link"));
    for (const name of [
      "../escape",
      "/absolute",
      "link/file.txt",
      ".git/config",
      "nested/../file",
      "C:\\file",
    ])
      await expect(target(cwd, name)).rejects.toThrow();
  });
  it("does not overwrite a file that appears while an upload is in flight", async () => {
    const cwd = await root();
    const claim = await target(cwd, "report.docx");
    await NodeFSP.writeFile(NodePath.join(cwd, "report.docx"), "new");
    await expect(receiveUpload(claim, bytes())).rejects.toThrow("destination changed");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "report.docx"), "utf8")).toBe("new");
  });
});
