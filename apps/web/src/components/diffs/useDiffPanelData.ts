import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { useParams } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ReviewDiffPreviewSource } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { useTheme } from "~/hooks/useTheme";
import { useClientSettings } from "~/hooks/useSettings";
import { useTurnDiffSummaries } from "~/hooks/useTurnDiffSummaries";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { createGitDiffFileContentsLoader } from "~/lib/diffFileContents";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { useProject, useThread } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { resolveThreadRouteRef } from "~/threadRoutes";
import type { TurnDiffSummary } from "~/types";

export interface DiffPanelFile {
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly fileKey: string;
  readonly fileVersion: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface DiffPanelTurn {
  readonly summary: TurnDiffSummary;
  readonly turnCount: number | undefined;
}

function toDiffPanelFile(fileDiff: FileDiffMetadata): DiffPanelFile {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return {
    fileDiff,
    filePath: resolveFileDiffPath(fileDiff),
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
    additions,
    deletions,
  };
}

/**
 * Everything the Diff panel reads for the routed thread: the scope, the patch it resolves to, and
 * the commits and turns the scope menu offers.
 */
export function useDiffPanelData(input: { readonly workspaceMutationId: string | null }) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const ignoreWhitespace = settings.diffIgnoreWhitespace;
  const threadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const thread = useThread(threadRef);
  const environmentId = thread?.environmentId ?? null;
  const project = useProject(
    thread && thread.projectId
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : null,
  );
  const cwd = thread?.worktreePath ?? project?.workspaceRoot;
  const repositoryRoot = thread?.worktreePath ? undefined : project?.repositoryIdentity?.rootPath;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);

  const selection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, threadRef),
  );
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const selectedBaseRef = useDiffPanelStore((state) =>
    threadKey ? (state.branchBaseRefByThreadKey[threadKey] ?? null) : null,
  );

  const gitStatus = useEnvironmentQuery(
    environmentId && cwd ? vcsEnvironment.status({ environmentId, input: { cwd } }) : null,
  );
  const isGitRepo = gitStatus.data?.isRepo ?? true;
  const uncommittedFileCount = gitStatus.data?.workingTree.files.length ?? null;

  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } = useTurnDiffSummaries(thread);
  const turns = useMemo<ReadonlyArray<DiffPanelTurn>>(
    () =>
      turnDiffSummaries
        .map((summary) => ({
          summary,
          turnCount:
            summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
        }))
        .toSorted((left, right) => {
          const countDelta = (right.turnCount ?? 0) - (left.turnCount ?? 0);
          return countDelta !== 0
            ? countDelta
            : right.summary.completedAt.localeCompare(left.summary.completedAt);
        }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  useEffect(() => {
    if (!threadRef || selection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      threadRef,
      turns.map((turn) => turn.summary.turnId),
    );
  }, [selection, threadRef, turns]);

  const selectedTurn =
    selection.kind === "turn"
      ? (turns.find((turn) => turn.summary.turnId === selection.turnId) ?? turns[0])
      : undefined;
  const checkpointRange =
    typeof selectedTurn?.turnCount === "number"
      ? {
          fromTurnCount: Math.max(0, selectedTurn.turnCount - 1),
          toTurnCount: selectedTurn.turnCount,
        }
      : null;
  const checkpointDiff = useCheckpointDiff(
    {
      environmentId,
      threadId: threadRef?.threadId ?? null,
      fromTurnCount: checkpointRange?.fromTurnCount ?? null,
      toTurnCount: checkpointRange?.toTurnCount ?? null,
      ignoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.summary.turnId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );

  const isGitScope = selection.kind !== "turn";
  const requestedSource =
    selection.kind === "commit"
      ? { commit: selection.sha }
      : selection.kind === "unstaged"
        ? ("working-tree" as const)
        : ("all" as const);
  const previewInput = (previewCwd: string) => ({
    cwd: previewCwd,
    ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
    ignoreWhitespace,
    source: requestedSource,
  });
  const primaryPreview = useEnvironmentQuery(
    isGitScope && environmentId && cwd
      ? reviewEnvironment.diffPreview({ environmentId, input: previewInput(cwd) })
      : null,
  );
  // A thread whose worktree sits outside the server's workspace roots is read from the server
  // cwd instead, the same fallback the panel has always used.
  const retryAtServerCwd =
    isGitScope &&
    primaryPreview.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== cwd;
  const fallbackPreview = useEnvironmentQuery(
    retryAtServerCwd && environmentId && serverConfig
      ? reviewEnvironment.diffPreview({ environmentId, input: previewInput(serverConfig.cwd) })
      : null,
  );
  const preview = retryAtServerCwd ? fallbackPreview : primaryPreview;
  const previewCwd = preview.data?.cwd ?? cwd;

  const commitsQuery = useEnvironmentQuery(
    isGitRepo && environmentId && previewCwd
      ? reviewEnvironment.commits({
          environmentId,
          input: { cwd: previewCwd, ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}) },
        })
      : null,
  );
  const commits = commitsQuery.data?.commits ?? [];

  // Servers from before scoped previews answer with the legacy pair; the branch range is the
  // closest thing they have to "all changes".
  const gitSource: ReviewDiffPreviewSource | undefined = (() => {
    const sources = preview.data?.sources ?? [];
    switch (selection.kind) {
      case "branch":
        return (
          sources.find((source) => source.kind === "all") ??
          sources.find((source) => source.kind === "branch-range")
        );
      case "unstaged":
        return sources.find((source) => source.kind === "working-tree");
      case "commit":
        return sources.find((source) => source.kind === "commit");
      case "turn":
        return undefined;
    }
  })();
  const targetBaseRef =
    commitsQuery.data?.baseRef ??
    (gitSource?.kind === "branch-range" ? gitSource.baseRef : null) ??
    selectedBaseRef;

  const refreshPreview = preview.refresh;
  const refreshCommits = commitsQuery.refresh;
  const refresh = useCallback(() => {
    refreshPreview();
    refreshCommits();
  }, [refreshCommits, refreshPreview]);
  const canRefresh = isGitRepo && isGitScope && environmentId !== null && cwd != null;
  useEffect(() => {
    if (!canRefresh) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [canRefresh, refresh]);
  useWorkspaceMutationRefresh({
    enabled: canRefresh,
    mutationId: input.workspaceMutationId,
    refresh,
    resourceKey: `diff:${threadKey ?? ""}`,
  });

  const currentLoader = useMemo<FileDiffContentsLoader | undefined>(() => {
    if (!environmentId || !preview.data || !gitSource || !isGitScope) return undefined;
    return createGitDiffFileContentsLoader(getDiffFileContents, {
      environmentId,
      cwd: preview.data.cwd,
      sourceKind: gitSource.kind,
      baseRef: gitSource.baseRef,
      headRef: gitSource.headRef,
      cacheKey: gitSource.diffHash,
    });
  }, [environmentId, getDiffFileContents, gitSource, isGitScope, preview.data]);
  const loaderRef = useRef(currentLoader);
  useEffect(() => {
    loaderRef.current = currentLoader;
  }, [currentLoader]);
  // Stable identity so the viewer does not remount when a refresh swaps the source.
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(async (fileDiff) => {
    const loader = loaderRef.current;
    if (!loader) throw new Error("Diff file contents are unavailable for this selection.");
    return loader(fileDiff);
  }, []);

  const patch = selectedTurn ? checkpointDiff.data?.diff : gitSource?.diff;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(patch, `diff-panel:${resolvedTheme}`, {
        compactPartialHunkOffsets: selection.kind !== "turn",
      }),
    [patch, resolvedTheme, selection.kind],
  );
  const files = useMemo<ReadonlyArray<DiffPanelFile>>(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") return [];
    return renderablePatch.files.map(toDiffPanelFile).toSorted((left, right) =>
      left.filePath.localeCompare(right.filePath, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const lineStat = useMemo(() => getDiffLineStat(files.map((file) => file.fileDiff)), [files]);

  const sectionId =
    selection.kind === "turn"
      ? `turn:${selectedTurn?.summary.turnId ?? selection.turnId}`
      : selection.kind === "commit"
        ? `commit:${selection.sha}`
        : selection.kind;
  const scopeTitle =
    selection.kind === "turn"
      ? `Turn ${selectedTurn?.turnCount ?? "?"}`
      : selection.kind === "commit"
        ? (commits.find((commit) => commit.sha === selection.sha)?.subject ??
          selection.sha.slice(0, 7))
        : selection.kind === "unstaged"
          ? "Uncommitted changes"
          : "All changes";

  return {
    threadRef,
    thread,
    environmentId,
    cwd,
    repositoryRoot,
    availableEditors: serverConfig?.availableEditors ?? [],
    isGitRepo,
    selection,
    selectedBaseRef,
    targetBaseRef,
    previewCwd,
    /** The checked-out branch, which can never be its own comparison target. */
    headRef: gitStatus.data?.refName ?? null,
    uncommittedFileCount,
    commits,
    commitsTruncated: commitsQuery.data?.truncated ?? false,
    turns,
    selectedTurn,
    files,
    lineStat,
    renderablePatch,
    isLoading: selectedTurn ? checkpointDiff.isPending : preview.isPending,
    error: selectedTurn ? checkpointDiff.error : preview.error,
    truncated: gitSource?.truncated === true,
    loadDiffFiles: currentLoader ? loadDiffFiles : undefined,
    refresh,
    canRefresh,
    isRefreshing: preview.isPending,
    sectionId,
    scopeTitle,
  };
}

export type DiffPanelData = ReturnType<typeof useDiffPanelData>;
