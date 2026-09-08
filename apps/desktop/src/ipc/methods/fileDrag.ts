import {
  WorkspaceTransferError,
  DesktopFileDragInput,
  DesktopFileDragResolveInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  startNativeFileDrag,
  resolveNativeFileDrag,
  cancelNativeFileDrag,
} from "../../transfers/NativeFileDrag.ts";
export const startFileDrag = DesktopIpc.makeIpcMethod({
  channel: "desktop:files:start-drag",
  payload: DesktopFileDragInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.files.startDrag")(function* (input) {
    const env = yield* DesktopEnvironment.DesktopEnvironment,
      windows = yield* ElectronWindow.ElectronWindow,
      fs = yield* FileSystem.FileSystem;
    if (env.platform !== "darwin")
      return yield* Effect.fail(
        new WorkspaceTransferError({
          message:
            "Native file dragging is currently available on macOS. Use Download on this platform.",
        }),
      );
    const window = yield* windows.focusedMainOrFirst;
    if (Option.isNone(window))
      return yield* Effect.fail(
        new WorkspaceTransferError({ message: "No window is available for dragging." }),
      );
    const candidates = env.resolveResourcePathCandidates("file-promises/t3-file-promises.node");
    const available = yield* Effect.filter(candidates, (p) => fs.exists(p));
    const addonPath = available[0];
    if (!addonPath)
      return yield* Effect.fail(
        new WorkspaceTransferError({
          message: "The Mac file-dragging helper is missing. Rebuild the desktop app.",
        }),
      );
    yield* Effect.try(() =>
      startNativeFileDrag(addonPath, window.value.getNativeWindowHandle(), input, (event) => {
        if (!window.value.isDestroyed())
          window.value.webContents.send("desktop:files:drag-event", event);
      }),
    );
  }),
});
export const resolveFileDrag = DesktopIpc.makeIpcMethod({
  channel: "desktop:files:resolve-drag",
  payload: DesktopFileDragResolveInput,
  result: Schema.Void,
  handler: (input) => Effect.try(() => resolveNativeFileDrag(input)),
});
export const cancelFileDrag = DesktopIpc.makeIpcMethod({
  channel: "desktop:files:cancel-drag",
  payload: Schema.String,
  result: Schema.Void,
  handler: (id) => Effect.sync(() => cancelNativeFileDrag(id)),
});
