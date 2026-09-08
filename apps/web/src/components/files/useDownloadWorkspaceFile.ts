import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { toastManager } from "~/components/ui/toast";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

/** Streams the saved file through the browser's download manager, including across origins. */
export function useDownloadWorkspaceFile(threadRef: ScopedThreadRef) {
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const { environmentId, threadId } = threadRef;
  return useCallback(
    async (path: string) => {
      const progress = toastManager.add({ type: "loading", title: "Preparing download…" });
      try {
        const connection = readPreparedConnection(environmentId);
        if (!connection) throw new Error("Reconnect to this environment and try again.");
        const result = await createAssetUrl({
          environmentId,
          input: {
            resource: { _tag: "workspace-file", threadId, path, disposition: "attachment" },
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
        if (!url) throw new Error("The environment returned an invalid download URL.");
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = path.split(/[\\/]/).at(-1) ?? "download";
        anchor.rel = "noreferrer";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        toastManager.update(progress, { type: "success", title: "Download started" });
      } catch (error) {
        toastManager.update(progress, {
          type: "error",
          title: "Could not download file",
          description: error instanceof Error ? error.message : "The file is unavailable.",
        });
      }
    },
    [createAssetUrl, environmentId, threadId],
  );
}
