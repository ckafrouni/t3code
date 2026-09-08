import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  startWorkspaceTransfer,
  useWorkspaceTransfers,
  type TransferJob,
} from "./workspaceTransfers";
import type { WorkspaceUploadInput } from "@t3tools/contracts";

const saved: string[] = [];
let failPath = "";
class UploadRequest {
  upload = { onprogress: (_e: { loaded: number }) => {} };
  status = 200;
  responseText = "";
  url = "";
  onload = () => {};
  onerror = () => {};
  onabort = () => {};
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    queueMicrotask(() => {
      if (this.url === failPath) {
        this.onerror();
        return;
      }
      saved.push(this.url);
      this.responseText = JSON.stringify({ path: this.url });
      this.onload();
    });
  }
  abort() {
    this.onabort();
  }
}
function status(expected: TransferJob["status"]) {
  return new Promise<TransferJob>((resolve) => {
    const read = () => {
      const job = useWorkspaceTransfers.getState().jobs[0];
      if (job?.status === expected) {
        unsubscribe();
        resolve(job);
      }
    };
    const unsubscribe = useWorkspaceTransfers.subscribe(read);
    read();
  });
}
function start(
  prepare: (input: WorkspaceUploadInput) => Promise<unknown>,
  entries = [
    { path: "a.txt", file: new File(["a"], "a.txt") },
    { path: "b.txt", file: new File(["b"], "b.txt") },
  ] as { path: string; file: File | null }[],
) {
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  startWorkspaceTransfer({
    entries,
    cwd: "/workspace",
    directory: "",
    label: "Workspace",
    prepare: prepare as Parameters<typeof startWorkspaceTransfer>[0]["prepare"],
    resolveUrl: (url) => url,
    refresh: async () => {},
  });
}
afterEach(() => {
  useWorkspaceTransfers.setState({ jobs: [] });
  saved.length = 0;
  failPath = "";
  vi.unstubAllGlobals();
});
const ready = async (input: WorkspaceUploadInput) => ({
  _tag: "ready",
  relativeUrl: input.path,
  expiresAt: 999,
});
describe("workspace upload jobs", () => {
  it("retries the failed file without resending completed files", async () => {
    failPath = "b.txt";
    start(ready);
    const failed = await status("failed");
    expect(saved).toEqual(["a.txt"]);
    expect(failed.index).toBe(1);
    failPath = "";
    failed.retry();
    const done = await status("complete");
    expect(saved).toEqual(["a.txt", "b.txt"]);
    expect(done.entries).toEqual([]);
    expect(done.bytes).toBe(2);
  });
  it("skips a folder and every descendant when resolving a collision", async () => {
    start(
      async (input) =>
        input.path === "folder"
          ? {
              _tag: input.conflict === "ask" ? "conflict" : "skipped",
              path: "folder",
              kind: "file",
            }
          : ready(input),
      [
        { path: "folder", file: null },
        { path: "folder/child.txt", file: new File(["child"], "child.txt") },
        { path: "other.txt", file: new File(["ok"], "other.txt") },
      ],
    );
    (await status("conflict")).decide("skip", false);
    await status("complete");
    expect(saved).toEqual(["other.txt"]);
  });
  it("maps descendants into the kept-both folder and cancels a pending conflict", async () => {
    start(
      async (input) =>
        input.path === "folder"
          ? input.conflict === "ask"
            ? { _tag: "conflict", path: "folder", kind: "directory" }
            : { _tag: "ready", relativeUrl: "folder (1)", expiresAt: 999 }
          : ready(input),
      [
        { path: "folder", file: null },
        { path: "folder/nested.txt", file: new File(["x"], "nested.txt") },
      ],
    );
    (await status("conflict")).decide("keep-both", false);
    await status("complete");
    expect(saved).toEqual(["folder (1)", "folder (1)/nested.txt"]);
    useWorkspaceTransfers.setState({ jobs: [] });
    start(async (input) => ({ _tag: "conflict", path: input.path, kind: "file" }));
    (await status("conflict")).cancel();
    expect((await status("cancelled")).index).toBe(0);
  });
});
