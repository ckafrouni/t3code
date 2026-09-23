import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

/** A full or abbreviated commit id. Kept to hex so it can never be read as a git option. */
export const ReviewCommitSha = TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{4,64}$/i));

/**
 * Narrows a preview to one source. `all` is committed plus uncommitted work against the merge
 * base, `working-tree` is uncommitted work only, and `{ commit }` is one commit against its first
 * parent. Omitted keeps the legacy pair (working tree and branch range) for older clients.
 */
export const ReviewDiffPreviewSourceRequest = Schema.Union([
  Schema.Literals(["all", "working-tree"]),
  Schema.Struct({ commit: ReviewCommitSha }),
]);
export type ReviewDiffPreviewSourceRequest = typeof ReviewDiffPreviewSourceRequest.Type;

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  source: Schema.optionalKey(ReviewDiffPreviewSourceRequest),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals([
  "working-tree",
  "branch-range",
  "all",
  "commit",
]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

export const ReviewListCommitsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
});
export type ReviewListCommitsInput = typeof ReviewListCommitsInput.Type;

export const ReviewCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  subject: Schema.String,
  authorName: Schema.String,
  authoredAt: Schema.String,
});
export type ReviewCommit = typeof ReviewCommit.Type;

export const ReviewListCommitsResult = Schema.Struct({
  /** The comparison target the commits were read against, resolved when the input left it out. */
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  /** Commits on HEAD that are not on `baseRef`, newest first. */
  commits: Schema.Array(ReviewCommit),
  truncated: Schema.Boolean,
});
export type ReviewListCommitsResult = typeof ReviewListCommitsResult.Type;
