import { WORKSPACE_TRANSFER_MAX_FILE_BYTES } from "@t3tools/contracts";

export interface DroppedWorkspaceEntry {
  path: string;
  file: File | null;
}
const MAX_ENTRIES = 10_000;
const MAX_BYTES = 10 * 1024 * 1024 * 1024;
/** Capture entries during drop; read every directory page (Chromium returns at most 100 at a time). */
export async function readWorkspaceDrop(data: DataTransfer): Promise<DroppedWorkspaceEntry[]> {
  const roots = Array.from(data.items)
    .filter((i) => i.kind === "file")
    .map((i) => ({ entry: i.webkitGetAsEntry?.() ?? null, file: i.getAsFile() }));
  const fallback = Array.from(data.files);
  const result: DroppedWorkspaceEntry[] = [];
  let bytes = 0;
  const add = (path: string, file: File | null) => {
    if (path.split("/").includes(".git"))
      throw new Error("Remove .git from the dropped folder before uploading it.");
    if (file && file.size > WORKSPACE_TRANSFER_MAX_FILE_BYTES)
      throw new Error(`${path} exceeds the 2 GB file limit.`);
    bytes += file?.size ?? 0;
    if (result.length >= MAX_ENTRIES || bytes > MAX_BYTES)
      throw new Error("Drop at most 10,000 entries and 10 GB at a time.");
    result.push({ path, file });
  };
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const name = prefix + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      add(name, file);
    } else if (entry.isDirectory) {
      add(name, null);
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const page = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!page.length) break;
        for (const child of page) await walk(child, name + "/");
      }
    }
  };
  if (roots.length) {
    for (const root of roots) {
      if (root.entry) await walk(root.entry, "");
      else if (root.file) add(root.file.name, root.file);
    }
  } else for (const file of fallback) add(file.name, file);
  return result;
}
export function workspaceDropDirectory(event: DragEvent): string {
  for (const node of event.composedPath())
    if (node instanceof Element && node.hasAttribute("data-item-path")) {
      const path = node.getAttribute("data-item-path")!.replace(/\/$/, "");
      return node.getAttribute("data-item-type") === "folder"
        ? path
        : path.split("/").slice(0, -1).join("/");
    }
  return "";
}
