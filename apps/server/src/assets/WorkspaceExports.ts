// @effect-diagnostics nodeBuiltinImport:off - filesystem adapter enumerates a bounded export manifest.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ThreadId, WorkspaceTransferError, type WorkspaceExportInput } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import { resolveUploadPath } from "./WorkspaceTransferStore.ts";
import { issueAssetUrl } from "./AssetAccess.ts";
export const WORKSPACE_EXPORT_ROUTE_PREFIX = "/api/workspace/export";
const Claims = Schema.Struct({
  kind: Schema.Literal("workspace-export"),
  cwd: Schema.String,
  path: Schema.String,
  expiresAt: Schema.Number,
});
const codec = Schema.fromJsonString(Claims),
  encode = Schema.encodeSync(codec),
  decode = Schema.decodeUnknownOption(codec);
const secret = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  return yield* store.getOrCreateRandom("workspace-export-signing-key", 32);
});
const failure = (cause: unknown) =>
  new WorkspaceTransferError({
    message: cause instanceof Error ? cause.message : "Could not prepare the files.",
  });
export const issueWorkspaceExport = Effect.fn("WorkspaceExports.issue")(function* (
  input: typeof WorkspaceExportInput.Type,
) {
  const resolved = yield* Effect.tryPromise({
    try: () => resolveUploadPath(input.cwd, input.path),
    catch: failure,
  });
  const info = yield* Effect.tryPromise({
    try: () => NodeFSP.stat(resolved.target),
    catch: failure,
  });
  if (!info.isFile() && !info.isDirectory())
    return yield* new WorkspaceTransferError({
      message: "Only regular files and folders can be dragged.",
    });
  const key = yield* secret.pipe(Effect.mapError(failure));
  const expiresAt = (yield* Clock.currentTimeMillis) + 30 * 60_000;
  const payload = base64UrlEncode(
    encode({ kind: "workspace-export", cwd: resolved.root, path: input.path, expiresAt }),
  );
  return {
    relativeUrl: `${WORKSPACE_EXPORT_ROUTE_PREFIX}/${payload}.${signPayload(payload, key)}`,
    expiresAt,
  };
});
export const readWorkspaceExport = Effect.fn("WorkspaceExports.read")(function* (token: string) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const key = yield* secret.pipe(Effect.mapError(failure));
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, key))) return null;
  let claims: typeof Claims.Type | null = null;
  try {
    claims = Option.getOrNull(decode(base64UrlDecodeUtf8(payload)));
  } catch {
    return null;
  }
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  const captured = claims;
  const entries = yield* Effect.tryPromise({
    try: async () => {
      const result: { path: string; kind: "file" | "directory"; sizeBytes: number }[] = [];
      let total = 0;
      async function walk(relative: string): Promise<void> {
        const resolved = await resolveUploadPath(captured.cwd, relative),
          stat = await NodeFSP.lstat(resolved.target);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
          throw new Error(
            "Remove symbolic links or special files from the folder before exporting it.",
          );
        total += stat.isFile() ? stat.size : 0;
        if (result.length >= 10_000 || total > 10 * 1024 * 1024 * 1024)
          throw new Error("Drag at most 10,000 entries and 10 GB at a time.");
        result.push({
          path: relative,
          kind: stat.isDirectory() ? "directory" : "file",
          sizeBytes: stat.isFile() ? stat.size : 0,
        });
        if (stat.isDirectory())
          for (const child of await NodeFSP.readdir(resolved.target))
            await walk(`${relative}/${child}`);
      }
      await walk(captured.path);
      return result;
    },
    catch: failure,
  });
  const signed = yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        const relative =
          entry.path === captured.path ? "" : entry.path.slice(captured.path.length + 1);
        if (entry.kind === "directory") return { ...entry, path: relative };
        const issued = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("workspace-export"),
            path: entry.path,
            disposition: "attachment",
          },
          workspaceRoot: captured.cwd,
        }).pipe(Effect.mapError(failure));
        return { ...entry, path: relative, url: issued.relativeUrl };
      }),
    { concurrency: 4 },
  );
  return { name: NodePath.basename(captured.path), kind: entries[0]!.kind, entries: signed };
});
