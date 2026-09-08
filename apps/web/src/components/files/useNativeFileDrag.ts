import { useEffect, useRef, type RefObject } from "react";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { readPreparedConnection } from "~/state/session";
import { toastManager } from "~/components/ui/toast";
import { composerMentionFromTreePath } from "~/components/chat/composerMentionDrag";
import { setNativeFileDrag, clearNativeFileDrag } from "~/lib/nativeFileDragState";

const prepareExport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "workspace:prepare-export",
  tag: WS_METHODS.workspaceExportPrepare,
  scheduler: createAtomCommandScheduler(),
  concurrency: {
    mode: "serial",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd, input.path]),
  },
});
let nextDrag = 0;
export function useNativeFileDrag(input: {
  panelRef: RefObject<HTMLDivElement | null>;
  environmentId: EnvironmentId;
  cwd: string;
  getSelection: () => readonly string[];
  onDragEnd: () => void;
}) {
  const prepare = useAtomCommand(prepareExport, { reportFailure: false });
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });
  useEffect(() => {
    const panel = input.panelRef.current,
      bridge = window.desktopBridge;
    if (
      !panel ||
      bridge?.getClientPlatform?.() !== "darwin" ||
      !bridge.startFileDrag ||
      !bridge.resolveFileDrag
    )
      return;
    const start = bridge.startFileDrag,
      resolve = bridge.resolveFileDrag;
    const drag = (event: DragEvent) => {
      const row = event
        .composedPath()
        .find((n) => n instanceof Element && n.hasAttribute("data-item-path")) as
        | Element
        | undefined;
      const dragged = row?.getAttribute("data-item-path");
      if (!dragged) return;
      const current = latest.current,
        selected = current.getSelection();
      const paths = (selected.includes(dragged) ? selected : [dragged]).filter(
        (p, _, all) =>
          !all.some((parent) => parent !== p && parent.endsWith("/") && p.startsWith(parent)),
      );
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = `drag-${Date.now()}-${++nextDrag}`;
      setNativeFileDrag(id, paths.map(composerMentionFromTreePath).filter(Boolean).join(" "));
      const items = paths.map((p) => ({
        name: p.replace(/\/$/, "").split("/").at(-1)!,
        directory: p.endsWith("/"),
      }));
      let toast: ReturnType<typeof toastManager.add> | undefined;
      let completed = 0;
      const unsubscribe = bridge.onFileDragEvent?.((event) => {
        if (event.id !== id) return;
        if (event.type === "ended") {
          current.onDragEnd();
          setTimeout(() => clearNativeFileDrag(id), 1000);
          if (event.cancelled) unsubscribe?.();
        }
        if (event.type === "progress") {
          const value = {
            type: "loading" as const,
            title: `Downloading ${event.name ?? "files"}…`,
            description: `${Math.round((event.bytes ?? 0) / 1024).toLocaleString()} / ${Math.round((event.total ?? 0) / 1024).toLocaleString()} KB`,
            actionProps: {
              children: "Cancel",
              onClick: () => {
                void bridge.cancelFileDrag?.(id);
                if (toast)
                  toastManager.update(toast, { type: "info", title: "Download cancelled" });
                unsubscribe?.();
              },
            },
          };
          if (toast) toastManager.update(toast, value);
          else toast = toastManager.add(value);
        }
        if (event.type === "complete" || event.type === "error") {
          completed++;
          const value = {
            type: event.type === "complete" ? ("success" as const) : ("error" as const),
            title:
              event.type === "complete"
                ? `Downloaded ${event.name}`
                : `Could not download ${event.name}`,
            description: event.error,
          };
          if (toast) toastManager.update(toast, value);
          else toast = toastManager.add(value);
          if (completed >= items.length) unsubscribe?.();
        }
      });
      void start({ id, items })
        .then(async () => {
          const connection = readPreparedConnection(current.environmentId);
          if (!connection)
            throw new Error("Reconnect to this environment and drag the file again.");
          const urls = await Promise.all(
            paths.map(async (path) => {
              const result = await prepare({
                environmentId: current.environmentId,
                input: { cwd: current.cwd, path: path.replace(/\/$/, "") },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              return new URL(result.value.relativeUrl, connection.httpBaseUrl).href;
            }),
          );
          await resolve({ id, urls });
        })
        .catch((error) => {
          void resolve({
            id,
            urls: [],
            error: error instanceof Error ? error.message : "Could not prepare files.",
          });
          clearNativeFileDrag(id);
          current.onDragEnd();
          toastManager.add({
            type: "error",
            title: "Could not drag files",
            description:
              error instanceof Error ? error.message : "Try downloading the file instead.",
          });
          unsubscribe?.();
        });
    };
    panel.addEventListener("dragstart", drag, true);
    return () => panel.removeEventListener("dragstart", drag, true);
  }, [input.panelRef, prepare]);
}
