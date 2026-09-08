import { create } from "zustand";
import type { WorkspaceUploadInput, WorkspaceUploadResult } from "@t3tools/contracts";
import type { DroppedWorkspaceEntry } from "./workspaceDropFiles";

type ConflictChoice = WorkspaceUploadInput["conflict"];
export interface TransferJob {
  id: string;
  destination: string;
  entries: DroppedWorkspaceEntry[];
  index: number;
  bytes: number;
  total: number;
  status: "uploading" | "conflict" | "failed" | "cancelled" | "complete";
  error?: string | undefined;
  conflictPath?: string | undefined;
  conflictKind?: "file" | "directory";
  cancel: () => void;
  retry: () => void;
  decide: (choice: ConflictChoice, all: boolean) => void;
}
export const useWorkspaceTransfers = create<{ jobs: TransferJob[] }>()(() => ({ jobs: [] }));
let nextTransferId = 0;
const update = (id: string, patch: Partial<TransferJob>) =>
  useWorkspaceTransfers.setState((s) => ({
    jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
  }));
export const dismissWorkspaceTransfer = (id: string) =>
  useWorkspaceTransfers.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));

function upload(
  url: string,
  file: File | null,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<{ path: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => progress(e.loaded);
    xhr.onload = () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(xhr.responseText || `Upload failed (${xhr.status}).`));
        return;
      }
      try {
        const response: unknown = JSON.parse(xhr.responseText);
        if (
          !response ||
          typeof response !== "object" ||
          !("path" in response) ||
          typeof response.path !== "string"
        )
          throw new Error("Invalid upload response.");
        resolve({ path: response.path });
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Connection lost. Reconnect and retry the transfer."));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Transfer cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      cleanup();
      reject(new DOMException("Transfer cancelled.", "AbortError"));
      return;
    }
    xhr.send(file ?? new Blob([]));
  });
}
/** Jobs retain their File handles across panel navigation; completed files are never re-uploaded on retry. */
export function startWorkspaceTransfer(input: {
  entries: DroppedWorkspaceEntry[];
  cwd: string;
  directory: string;
  label: string;
  prepare: (input: WorkspaceUploadInput) => Promise<typeof WorkspaceUploadResult.Type>;
  resolveUrl: (relative: string) => string;
  refresh: () => Promise<void>;
}) {
  const id = String(++nextTransferId);
  let index = 0,
    completedBytes = 0,
    defaultChoice: ConflictChoice = "ask";
  let controller = new AbortController();
  let resolveConflict: ((choice: ConflictChoice) => void) | undefined;
  const directoryMap = new Map<string, string>();
  const skippedDirectories: string[] = [];
  const targetPath = (entryPath: string) => {
    let best = "",
      replacement = "";
    for (const [original, target] of directoryMap)
      if (entryPath.startsWith(original + "/") && original.length > best.length) {
        best = original;
        replacement = target;
      }
    return best
      ? replacement + entryPath.slice(best.length)
      : [input.directory, entryPath].filter(Boolean).join("/");
  };
  const run = async () => {
    controller = new AbortController();
    update(id, { status: "uploading", error: undefined });
    try {
      for (; index < input.entries.length; index++) {
        controller.signal.throwIfAborted();
        const entry = input.entries[index]!;
        if (skippedDirectories.some((d) => entry.path.startsWith(d + "/"))) continue;
        update(id, { index, bytes: completedBytes });
        const request: WorkspaceUploadInput = {
          cwd: input.cwd,
          path: targetPath(entry.path),
          kind: entry.file ? "file" : "directory",
          sizeBytes: entry.file?.size ?? 0,
          conflict: defaultChoice,
        };
        let chosenConflict = request.conflict;
        let prepared = await input.prepare(request);
        controller.signal.throwIfAborted();
        if (prepared._tag === "conflict") {
          update(id, {
            status: "conflict",
            conflictPath: prepared.path,
            conflictKind: prepared.kind,
          });
          const choice = await new Promise<ConflictChoice>((resolve) => {
            resolveConflict = resolve;
          });
          resolveConflict = undefined;
          controller.signal.throwIfAborted();
          update(id, { status: "uploading", conflictPath: undefined });
          chosenConflict = choice;
          prepared = await input.prepare({ ...request, conflict: choice });
        }
        controller.signal.throwIfAborted();
        if (prepared._tag === "conflict")
          throw new Error("The destination changed. Retry to review the conflict.");
        if (prepared._tag === "ready") {
          const saved = await upload(
            input.resolveUrl(prepared.relativeUrl),
            entry.file,
            controller.signal,
            (bytes) => update(id, { bytes: completedBytes + bytes }),
          );
          if (!entry.file) directoryMap.set(entry.path, saved.path);
        } else if (!entry.file && chosenConflict === "skip") skippedDirectories.push(entry.path);
        completedBytes += entry.file?.size ?? 0;
      }
      await input.refresh();
      controller.signal.throwIfAborted();
      update(id, {
        status: "complete",
        index: input.entries.length,
        bytes: completedBytes,
        entries: [],
      });
      input.entries = [];
    } catch (error) {
      update(id, {
        status: controller.signal.aborted ? "cancelled" : "failed",
        error: controller.signal.aborted
          ? undefined
          : error instanceof Error
            ? error.message
            : "Transfer failed.",
      });
      void input.refresh().catch(() => {});
    }
  };
  const job: TransferJob = {
    id,
    destination: input.label,
    entries: input.entries,
    index: 0,
    bytes: 0,
    total: input.entries.reduce((n, e) => n + (e.file?.size ?? 0), 0),
    status: "uploading",
    cancel: () => {
      controller.abort();
      resolveConflict?.("skip");
    },
    retry: () => {
      void run();
    },
    decide: (choice, all) => {
      if (all) defaultChoice = choice;
      resolveConflict?.(choice);
    },
  };
  useWorkspaceTransfers.setState((s) => ({
    jobs: [...s.jobs.filter((j) => j.status !== "complete"), job],
  }));
  void run();
}
