// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalTimers:off - Electron native drag adapter streams files and loads a Node-API addon.
import * as NodeModule from "node:module";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeStream from "node:stream";
import * as Schema from "effect/Schema";
import {
  WorkspaceExportManifest,
  type DesktopFileDragEvent,
  type DesktopFileDragInput,
  type DesktopFileDragResolveInput,
} from "@t3tools/contracts";

interface NativeEvent {
  type: "write" | "ended";
  sessionId: string;
  requestId?: string;
  index?: number;
  destination?: string;
  cancelled?: boolean;
}
interface NativeAddon {
  configure: (callback: (json: string) => void) => void;
  start: (handle: Buffer, id: string, items: string) => void;
  finish: (request: string, error: string) => void;
  dispose: (id: string) => void;
}
interface DragSession {
  items: typeof DesktopFileDragInput.Type.items;
  urls: Promise<readonly string[]>;
  resolve: (urls: readonly string[]) => void;
  reject: (error: Error) => void;
  controller: AbortController;
  completed: number;
  started: number;
  ended: boolean;
  timeout: ReturnType<typeof setTimeout>;
  send: (event: DesktopFileDragEvent) => void;
}
const decodeManifest = Schema.decodeUnknownSync(WorkspaceExportManifest);
const sessions = new Map<string, DragSession>();
let addon: NativeAddon | undefined;
function safeName(name: string) {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name))
    throw new Error("Invalid dragged filename.");
  return name;
}
function exportUrl(raw: string) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.pathname.startsWith("/api/workspace/export/") ||
    url.username ||
    url.password
  )
    throw new Error("Invalid file export URL.");
  return url;
}
function assetUrl(raw: string, base: URL) {
  const url = new URL(raw, base);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/assets/"))
    throw new Error("Invalid download URL in export manifest.");
  return url.href;
}
function relativePath(raw: string) {
  if (raw === "") return "";
  if (raw.split("/").some((p) => !p || p === "." || p === ".." || /[\\\0]/.test(p)))
    throw new Error("Invalid path in export manifest.");
  return raw;
}

/** File promises call this only after Finder has supplied the user's destination. */
export async function materializeWorkspaceExport(
  rawUrl: string,
  destination: string,
  directory: boolean,
  signal: AbortSignal,
  progress: (bytes: number, total: number) => void,
) {
  const url = exportUrl(rawUrl);
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok)
    throw new Error(
      (await response.text()).slice(0, 500) || `Could not read files (${response.status}).`,
    );
  const manifest = decodeManifest(await response.json());
  if ((manifest.kind === "directory") !== directory || manifest.entries.length > 10000)
    throw new Error("The selected item changed. Drag it again.");
  const total = manifest.entries.reduce((n, e) => n + e.sizeBytes, 0);
  if (total > 10 * 1024 * 1024 * 1024) throw new Error("Drag at most 10 GB at a time.");
  const staging = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(destination), ".t3-download-"),
  );
  const staged = NodePath.join(staging, "content");
  let completed = 0;
  try {
    if (directory) await NodeFSP.mkdir(staged);
    for (const entry of manifest.entries) {
      signal.throwIfAborted();
      const relative = relativePath(entry.path);
      if (!directory && relative !== "") throw new Error("Invalid single-file export.");
      const output = relative ? NodePath.join(staged, relative) : staged;
      if (entry.kind === "directory") {
        if (!directory) throw new Error("Invalid single-file export.");
        await NodeFSP.mkdir(output, { recursive: true });
        continue;
      }
      if (!entry.url) throw new Error("File download is missing from the manifest.");
      await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
      const file = await fetch(assetUrl(entry.url, url), { signal, redirect: "error" });
      if (!file.ok || !file.body)
        throw new Error(`Could not download ${entry.path || manifest.name} (${file.status}).`);
      let received = 0,
        lastProgress = 0;
      async function* counted() {
        for await (const chunk of NodeStream.Readable.fromWeb(
          file.body! as import("node:stream/web").ReadableStream<Uint8Array>,
        )) {
          const bytes = chunk as Buffer;
          received += bytes.length;
          if (received > entry.sizeBytes)
            throw new Error("The remote file changed during download. Drag it again.");
          if (Date.now() - lastProgress > 100) {
            lastProgress = Date.now();
            progress(completed + received, total);
          }
          yield bytes;
        }
        if (received !== entry.sizeBytes)
          throw new Error("The download was incomplete. Drag the file again.");
      }
      await NodeStreamPromises.pipeline(
        NodeStream.Readable.from(counted()),
        NodeFS.createWriteStream(output, { flags: "wx" }),
        {
          signal,
        },
      );
      completed += received;
      progress(completed, total);
    }
    signal.throwIfAborted();
    if (directory) {
      await NodeFSP.mkdir(destination);
      try {
        await NodeFSP.rename(staged, destination);
      } catch (error) {
        await NodeFSP.rmdir(destination).catch(() => {});
        throw error;
      }
    } else await NodeFSP.link(staged, destination);
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}
export function cancelNativeFileDrag(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  session.send({ id, type: "ended", cancelled: true });
  session.controller.abort();
  session.reject(new Error("Transfer cancelled."));
  clearTimeout(session.timeout);
  addon?.dispose(id);
  sessions.delete(id);
}
function handleEvent(event: NativeEvent) {
  const session = sessions.get(event.sessionId);
  if (!session) return;
  if (event.type === "ended") {
    session.ended = true;
    session.send({ id: event.sessionId, type: "ended", cancelled: event.cancelled ?? false });
    if (event.cancelled) {
      cancelNativeFileDrag(event.sessionId);
      return;
    }
    // An in-app drop consumes the mention, not the file promise.
    setTimeout(() => {
      if (session.started === 0) cancelNativeFileDrag(event.sessionId);
    }, 5000).unref();
    return;
  }
  const request = event.requestId,
    index = event.index,
    destination = event.destination;
  if (request === undefined || index === undefined || !destination || !session.items[index]) return;
  session.started++;
  const item = session.items[index]!;
  void (async () => {
    try {
      const urls = await session.urls;
      const url = urls[index];
      if (!url) throw new Error("No download was prepared for this file.");
      await materializeWorkspaceExport(
        url,
        destination,
        item.directory,
        session.controller.signal,
        (bytes, total) =>
          session.send({ id: event.sessionId, type: "progress", name: item.name, bytes, total }),
      );
      addon?.finish(request, "");
      session.send({ id: event.sessionId, type: "complete", name: item.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Download failed.";
      addon?.finish(request, message);
      session.send({ id: event.sessionId, type: "error", name: item.name, error: message });
    } finally {
      session.completed++;
      if (session.completed === session.items.length) {
        clearTimeout(session.timeout);
        addon?.dispose(event.sessionId);
        sessions.delete(event.sessionId);
      }
    }
  })();
}
export function startNativeFileDrag(
  addonPath: string,
  handle: Buffer,
  input: typeof DesktopFileDragInput.Type,
  send: DragSession["send"],
) {
  if (sessions.has(input.id) || sessions.size >= 8)
    throw new Error("Finish the current transfers before starting another.");
  for (const item of input.items) safeName(item.name);
  if (!addon) {
    addon = NodeModule.createRequire(addonPath)(addonPath) as NativeAddon;
    addon.configure((json) => handleEvent(JSON.parse(json) as NativeEvent));
  }
  let resolve!: (urls: readonly string[]) => void, reject!: (error: Error) => void;
  const urls = new Promise<readonly string[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void urls.catch(() => {});
  const timeout = setTimeout(() => cancelNativeFileDrag(input.id), 30 * 60_000);
  timeout.unref();
  sessions.set(input.id, {
    items: input.items,
    urls,
    resolve,
    reject,
    controller: new AbortController(),
    completed: 0,
    started: 0,
    ended: false,
    timeout,
    send,
  });
  try {
    addon.start(handle, input.id, JSON.stringify(input.items));
  } catch (error) {
    cancelNativeFileDrag(input.id);
    throw error;
  }
}
export function resolveNativeFileDrag(input: typeof DesktopFileDragResolveInput.Type) {
  const session = sessions.get(input.id);
  if (!session) return;
  if (input.error) {
    session.reject(new Error(input.error));
    return;
  }
  if (input.urls.length !== session.items.length) throw new Error("The dragged file list changed.");
  input.urls.forEach(exportUrl);
  session.resolve(input.urls);
}
