import { WorkspaceUploadInput, WorkspaceTransferError } from "@t3tools/contracts";
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
import { prepareUpload } from "./WorkspaceTransferStore.ts";

export const WORKSPACE_UPLOAD_ROUTE_PREFIX = "/api/workspace/upload";
const Claims = Schema.Struct({
  kind: Schema.Literal("workspace-upload"),
  target: Schema.Struct({
    ...WorkspaceUploadInput.fields,
    fingerprint: Schema.NullOr(Schema.String),
  }),
  expiresAt: Schema.Number,
});
const encodeClaims = Schema.encodeSync(Schema.fromJsonString(Claims));
const codec = Schema.fromJsonString(Claims);
const secret = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  return yield* store.getOrCreateRandom("workspace-upload-signing-key", 32);
});
export const issueWorkspaceUpload = Effect.fn("WorkspaceUploads.issue")(function* (
  input: typeof WorkspaceUploadInput.Type,
) {
  const prepared = yield* Effect.tryPromise({
    try: () => prepareUpload(input),
    catch: (cause) =>
      new WorkspaceTransferError({
        message: cause instanceof Error ? cause.message : "Could not prepare upload.",
      }),
  });
  if (prepared._tag !== "target") return prepared;
  const key = yield* secret.pipe(
    Effect.mapError(
      () => new WorkspaceTransferError({ message: "Could not prepare upload credentials." }),
    ),
  );
  const expiresAt = (yield* Clock.currentTimeMillis) + 15 * 60_000;
  const payload = base64UrlEncode(
    encodeClaims({ kind: "workspace-upload", target: prepared.target, expiresAt }),
  );
  return {
    _tag: "ready" as const,
    relativeUrl: `${WORKSPACE_UPLOAD_ROUTE_PREFIX}/${payload}.${signPayload(payload, key)}`,
    expiresAt,
  };
});
export const validateWorkspaceUpload = Effect.fn("WorkspaceUploads.validate")(function* (
  token: string,
) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const key = yield* secret.pipe(Effect.orElseSucceed(() => null));
  if (!key || !timingSafeEqualBase64Url(signature, signPayload(payload, key))) return null;
  const now = yield* Clock.currentTimeMillis;
  try {
    const claims = Option.getOrNull(
      Schema.decodeUnknownOption(codec)(base64UrlDecodeUtf8(payload)),
    );
    return claims && claims.expiresAt > now ? claims : null;
  } catch {
    return null;
  }
});
