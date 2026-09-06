import * as Schema from "effect/Schema";

export function codeLanguageForPath(path: string) {
  if (/\.(?:[cm]?ts|tsx)$/i.test(path)) return "typescript";
  if (/\.(?:[cm]?js|jsx)$/i.test(path)) return "javascript";
  if (/\.rs$/i.test(path)) return "rust";
  if (/\.proto$/i.test(path)) return "protobuf";
  if (/\.jsonc$/i.test(path)) return "jsonc";
  if (/\.json$/i.test(path)) return "json";
  return undefined;
}

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const DocumentText = Schema.String.check(Schema.isMaxLength(1024 * 1024));

/** Editor and language-service positions are one-based UTF-16 coordinates. */
export const CodePosition = Schema.Struct({ line: PositiveInt, column: PositiveInt });
export const CodeRange = Schema.Struct({ start: CodePosition, end: CodePosition });
export const CodeLocation = Schema.Struct({
  path: Schema.String,
  range: CodeRange,
  preview: Schema.optional(Schema.String),
});
export type CodeLocation = typeof CodeLocation.Type;

export const LanguageRequest = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  cwd: Schema.String.check(Schema.isMinLength(1)),
  relativePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  operation: Schema.Literals([
    "completions",
    "hover",
    "definition",
    "references",
    "diagnostics",
    "refresh",
    "signature",
    "format",
    "close",
  ]),
  version: Offset,
  position: Schema.optional(CodePosition),
  update: Schema.optional(
    Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("open"), contents: DocumentText }),
      Schema.Struct({
        _tag: Schema.Literal("change"),
        baseVersion: Offset,
        start: Offset,
        deleteLength: Offset,
        text: DocumentText,
      }),
    ]),
  ),
});
export type LanguageRequest = typeof LanguageRequest.Type;

export const CodeDiagnostic = Schema.Struct({
  range: CodeRange,
  message: Schema.String,
  severity: Schema.Literals(["error", "warning", "suggestion", "message"]),
  code: Schema.Union([Schema.Number, Schema.String]),
  source: Schema.optional(Schema.String),
});
export type CodeDiagnostic = typeof CodeDiagnostic.Type;

export const LanguageResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("completions"),
    items: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        kind: Schema.String,
        sortText: Schema.String,
        insertText: Schema.String,
        range: Schema.optional(CodeRange),
      }),
    ),
  }),
  Schema.Struct({
    _tag: Schema.Literal("hover"),
    info: Schema.NullOr(
      Schema.Struct({
        range: CodeRange,
        display: Schema.String,
        documentation: Schema.String,
        markdown: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
  Schema.Struct({ _tag: Schema.Literal("locations"), items: Schema.Array(CodeLocation) }),
  Schema.Struct({ _tag: Schema.Literal("diagnostics"), items: Schema.Array(CodeDiagnostic) }),
  Schema.Struct({
    _tag: Schema.Literal("signature"),
    activeSignature: Offset,
    activeParameter: Offset,
    items: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        documentation: Schema.String,
        parameters: Schema.Array(
          Schema.Struct({ label: Schema.String, documentation: Schema.String }),
        ),
      }),
    ),
  }),
  Schema.Struct({
    _tag: Schema.Literal("format"),
    edits: Schema.Array(Schema.Struct({ range: CodeRange, text: Schema.String })),
  }),
  Schema.Struct({ _tag: Schema.Literal("closed") }),
]);
export type LanguageResult = typeof LanguageResult.Type;

export class LanguageServiceError extends Schema.TaggedErrorClass<LanguageServiceError>()(
  "LanguageServiceError",
  { message: Schema.String, resync: Schema.Boolean },
) {}
