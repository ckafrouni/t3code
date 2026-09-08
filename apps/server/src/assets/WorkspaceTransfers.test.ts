import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { issueWorkspaceUpload, validateWorkspaceUpload } from "./WorkspaceUploads.ts";
import { issueWorkspaceExport, readWorkspaceExport } from "./WorkspaceExports.ts";

const config = ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-transfers-test-" });
const layer = Layer.mergeAll(
  config,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(config)),
).pipe(Layer.provideMerge(NodeServices.layer));
const token = (url: string) => url.slice(url.lastIndexOf("/") + 1);

describe("workspace transfer capabilities", () => {
  it.effect(
    "binds uploads to the destination, size and conflict policy, rejects tampering and expiration",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped();
        const result = yield* issueWorkspaceUpload({
          cwd,
          path: "notes.txt",
          kind: "file",
          sizeBytes: 4,
          conflict: "ask",
        });
        expect(result._tag).toBe("ready");
        if (result._tag !== "ready") return;
        const key = token(result.relativeUrl);
        expect((yield* validateWorkspaceUpload(key))?.target).toMatchObject({
          path: "notes.txt",
          sizeBytes: 4,
          conflict: "ask",
          fingerprint: null,
        });
        expect(yield* validateWorkspaceUpload(key + "x")).toBeNull();
        expect(yield* readWorkspaceExport(key)).toBeNull();
        yield* TestClock.adjust("16 minutes");
        expect(yield* validateWorkspaceUpload(key)).toBeNull();
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "exports binary files and nested folders with empty directories and expiring download URLs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${cwd}/folder/empty`, { recursive: true });
        yield* fs.writeFile(`${cwd}/folder/report.docx`, new Uint8Array([0, 255, 1]));
        const issued = yield* issueWorkspaceExport({ cwd, path: "folder" });
        const key = token(issued.relativeUrl);
        const result = yield* readWorkspaceExport(key);
        expect(result).toMatchObject({ name: "folder", kind: "directory" });
        expect(result?.entries).toEqual([
          { path: "", kind: "directory", sizeBytes: 0 },
          { path: "empty", kind: "directory", sizeBytes: 0 },
          {
            path: "report.docx",
            kind: "file",
            sizeBytes: 3,
            url: expect.stringContaining("/api/assets/"),
          },
        ]);
        const file = yield* issueWorkspaceExport({ cwd, path: "folder/report.docx" });
        expect((yield* readWorkspaceExport(token(file.relativeUrl)))?.entries).toMatchObject([
          { path: "", kind: "file", sizeBytes: 3 },
        ]);
        expect(yield* readWorkspaceExport(key + "x")).toBeNull();
        yield* TestClock.adjust("31 minutes");
        expect(yield* readWorkspaceExport(key)).toBeNull();
      }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects traversal and a folder changed to contain a symlink after preparing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${cwd}/folder`);
      const issued = yield* issueWorkspaceExport({ cwd, path: "folder" });
      yield* fs.symlink(cwd, `${cwd}/folder/link`);
      expect((yield* readWorkspaceExport(token(issued.relativeUrl)).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      for (const path of ["../outside", ".git/config", "/etc/passwd"]) {
        expect((yield* issueWorkspaceExport({ cwd, path }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }
    }).pipe(Effect.provide(layer)),
  );
});
