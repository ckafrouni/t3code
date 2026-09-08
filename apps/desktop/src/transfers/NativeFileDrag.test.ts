// @effect-diagnostics nodeBuiltinImport:off - native transfer tests use a loopback streaming server and disposable directories.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import { materializeWorkspaceExport } from "./NativeFileDrag.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).toReversed()) await clean();
});
async function fixture(
  entries: { path: string; kind: "file" | "directory"; sizeBytes: number; url?: string }[],
  bytes = Buffer.from([0, 255, 42]),
  directory = false,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-drag-test-"));
  cleanup.push(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const server = NodeHttp.createServer((req, res) => {
    if (req.url === "/api/workspace/export/test") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: "report", kind: directory ? "directory" : "file", entries }));
    } else res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server");
  const url = `http://127.0.0.1:${address.port}/api/workspace/export/test`;
  return { root, url, destination: NodePath.join(root, "report") };
}
const fileEntry = { path: "", kind: "file" as const, sizeBytes: 3, url: "/api/assets/test/report" };
describe("native file promise materialization", () => {
  it("streams exact binary bytes, publishes atomically and never overwrites existing files", async () => {
    const f = await fixture([fileEntry]);
    await materializeWorkspaceExport(
      f.url,
      f.destination,
      false,
      new AbortController().signal,
      () => {},
    );
    expect(await NodeFSP.readFile(f.destination)).toEqual(Buffer.from([0, 255, 42]));
    await expect(
      materializeWorkspaceExport(
        f.url,
        f.destination,
        false,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow();
    expect(await NodeFSP.readdir(f.root)).toEqual(["report"]);
    expect(await NodeFSP.readFile(f.destination)).toEqual(Buffer.from([0, 255, 42]));
  });
  it("preserves nested files and empty directories", async () => {
    const f = await fixture(
      [
        { path: "", kind: "directory", sizeBytes: 0 },
        { path: "empty", kind: "directory", sizeBytes: 0 },
        { ...fileEntry, path: "nested/report.docx" },
      ],
      undefined,
      true,
    );
    await materializeWorkspaceExport(
      f.url,
      f.destination,
      true,
      new AbortController().signal,
      () => {},
    );
    expect(await NodeFSP.readdir(NodePath.join(f.destination, "empty"))).toEqual([]);
    expect(await NodeFSP.readFile(NodePath.join(f.destination, "nested/report.docx"))).toEqual(
      Buffer.from([0, 255, 42]),
    );
    await expect(
      materializeWorkspaceExport(
        f.url,
        f.destination,
        true,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow();
    expect(await NodeFSP.readdir(f.root)).toEqual(["report"]);
  });
  it("removes partial data after cancellation or a changed remote size", async () => {
    const f = await fixture([fileEntry], Buffer.alloc(1024 * 1024));
    await expect(
      materializeWorkspaceExport(
        f.url,
        f.destination,
        false,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("changed");
    expect(await NodeFSP.readdir(f.root)).toEqual([]);
    const controller = new AbortController();
    const g = await fixture([{ ...fileEntry, sizeBytes: 1024 * 1024 }], Buffer.alloc(1024 * 1024));
    await expect(
      materializeWorkspaceExport(g.url, g.destination, false, controller.signal, () =>
        controller.abort(),
      ),
    ).rejects.toThrow();
    expect(await NodeFSP.readdir(g.root)).toEqual([]);
  });
  it.each(["../escape", "/absolute", "nested/../../escape", "nested\\escape"])(
    "rejects unsafe manifest path %s",
    async (unsafe) => {
      const f = await fixture([{ ...fileEntry, path: unsafe }], undefined, true);
      await expect(
        materializeWorkspaceExport(
          f.url,
          f.destination,
          true,
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow("Invalid path");
      expect(await NodeFSP.readdir(f.root)).toEqual([]);
    },
  );
  it("rejects download URLs outside the exporting server", async () => {
    const f = await fixture([{ ...fileEntry, url: "http://localhost:1/api/assets/private" }]);
    await expect(
      materializeWorkspaceExport(
        f.url,
        f.destination,
        false,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("Invalid download URL");
    expect(await NodeFSP.readdir(f.root)).toEqual([]);
  });
});
