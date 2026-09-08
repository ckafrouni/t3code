import { useEffect, useState, useRef, type RefObject } from "react";
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
import { readNativeFileDrag } from "~/lib/nativeFileDragState";
import { readWorkspaceDrop, workspaceDropDirectory } from "./workspaceDropFiles";
import { startWorkspaceTransfer } from "./workspaceTransfers";

const prepareUpload = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "workspace:prepare-upload",
  tag: WS_METHODS.workspaceUploadPrepare,
  scheduler: createAtomCommandScheduler(),
  concurrency: {
    mode: "serial",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd, input.path]),
  },
});
const refreshUploads = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "workspace:refresh-uploads",
  tag: WS_METHODS.workspaceUploadRefresh,
  scheduler: createAtomCommandScheduler(),
  concurrency: {
    mode: "serial",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
  },
});
export function useWorkspaceFileDrop(input: {
  panelRef: RefObject<HTMLDivElement | null>;
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  refresh: () => void;
}) {
  const refreshRef = useRef(input.refresh);
  useEffect(() => {
    refreshRef.current = input.refresh;
  });
  const prepare = useAtomCommand(prepareUpload, { reportFailure: false });
  const refresh = useAtomCommand(refreshUploads, { reportFailure: false });
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    const panel = input.panelRef.current;
    if (!panel) return;
    let highlighted: HTMLElement | null = null;
    const clear = () => {
      highlighted?.style.removeProperty("outline");
      highlighted = null;
      setTarget(null);
    };
    const external = (e: DragEvent) =>
      !readNativeFileDrag() &&
      e.dataTransfer?.types.includes("Files") &&
      !e.dataTransfer.types.includes("application/x-t3code-composer-mention");
    const over = (e: DragEvent) => {
      if (!external(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = "copy";
      const path = workspaceDropDirectory(e);
      setTarget(path);
      const node = e
        .composedPath()
        .find((n) => n instanceof HTMLElement && n.getAttribute("data-item-type") === "folder") as
        | HTMLElement
        | undefined;
      if (highlighted !== node) {
        highlighted?.style.removeProperty("outline");
        highlighted = node ?? null;
        highlighted?.style.setProperty("outline", "1px solid var(--trees-fg)");
      }
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget instanceof Node && panel.contains(e.relatedTarget)) return;
      clear();
    };
    const drop = (e: DragEvent) => {
      if (!external(e) || !e.dataTransfer) return;
      e.preventDefault();
      e.stopPropagation();
      const directory = workspaceDropDirectory(e);
      clear();
      const entries = readWorkspaceDrop(e.dataTransfer);
      void entries
        .then((entries) => {
          if (!entries.length) throw new Error("No readable files were dropped.");
          const connection = readPreparedConnection(input.environmentId);
          if (!connection) throw new Error("Reconnect to this environment before uploading files.");
          startWorkspaceTransfer({
            entries,
            cwd: input.cwd,
            directory,
            label: [input.projectName, directory].filter(Boolean).join("/"),
            prepare: async (request) => {
              const result = await prepare({ environmentId: input.environmentId, input: request });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              return result.value;
            },
            resolveUrl: (relative) => new URL(relative, connection.httpBaseUrl).href,
            refresh: async () => {
              const result = await refresh({
                environmentId: input.environmentId,
                input: { cwd: input.cwd },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              refreshRef.current();
            },
          });
        })
        .catch((error) =>
          toastManager.add({
            type: "error",
            title: "Could not upload files",
            description:
              error instanceof Error ? error.message : "The dropped files could not be read.",
          }),
        );
    };
    panel.addEventListener("dragover", over);
    panel.addEventListener("dragleave", leave);
    panel.addEventListener("drop", drop);
    return () => {
      highlighted?.style.removeProperty("outline");
      panel.removeEventListener("dragover", over);
      panel.removeEventListener("dragleave", leave);
      panel.removeEventListener("drop", drop);
    };
  }, [input.panelRef, input.environmentId, input.cwd, input.projectName, prepare, refresh]);
  return target;
}
