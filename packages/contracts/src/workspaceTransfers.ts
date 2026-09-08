import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WORKSPACE_TRANSFER_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const WorkspaceUploadInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "directory"]),
  sizeBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(WORKSPACE_TRANSFER_MAX_FILE_BYTES),
  ),
  conflict: Schema.Literals(["ask", "replace", "keep-both", "skip"]),
});
export type WorkspaceUploadInput = typeof WorkspaceUploadInput.Type;
export const WorkspaceUploadResult = Schema.Union([
  Schema.TaggedStruct("ready", { relativeUrl: Schema.String, expiresAt: Schema.Number }),
  Schema.TaggedStruct("conflict", {
    path: Schema.String,
    kind: Schema.Literals(["file", "directory"]),
  }),
  Schema.TaggedStruct("skipped", {}),
]);
export class WorkspaceTransferError extends Schema.TaggedError<WorkspaceTransferError>()(
  "WorkspaceTransferError",
  { message: Schema.String },
) {}

export const WorkspaceExportInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export const WorkspaceExportResult = Schema.Struct({
  relativeUrl: Schema.String,
  expiresAt: Schema.Number,
});
export const WorkspaceExportManifest = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  entries: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["file", "directory"]),
      url: Schema.optionalKey(Schema.String),
      sizeBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});

export const DesktopFileDragInput = Schema.Struct({
  id: Schema.String,
  items: Schema.Array(Schema.Struct({ name: Schema.String, directory: Schema.Boolean })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
});
export const DesktopFileDragResolveInput = Schema.Struct({
  id: Schema.String,
  urls: Schema.Array(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export interface DesktopFileDragEvent {
  id: string;
  type: "ended" | "progress" | "complete" | "error";
  name?: string;
  bytes?: number;
  total?: number;
  error?: string;
  cancelled?: boolean;
}
