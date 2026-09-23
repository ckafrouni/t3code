import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { GitCompareArrowsIcon } from "lucide-react";
import { useMemo } from "react";

import type { DraftId } from "../composerDraftStore";
import { useDiffPanelStore, type DiffPanelSelection } from "../diffPanelStore";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffFileView } from "./diffs/DiffFileView";
import { DiffScopeMenu } from "./diffs/DiffScopeMenu";
import { DiffTargetBranchPicker } from "./diffs/DiffTargetBranchPicker";
import { orderDiffChangesTreeFiles } from "./diffs/diffChangesTree.logic";
import { useDiffPanelData, type DiffPanelFile } from "./diffs/useDiffPanelData";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
}

const filePathOf = (file: DiffPanelFile) => file.filePath;

function emptyScopeMessage(selection: DiffPanelSelection): string {
  switch (selection.kind) {
    case "branch":
      return "No changes yet";
    case "unstaged":
      return "No uncommitted changes yet";
    case "commit":
      return "This commit has no file changes";
    case "turn":
      return "No changes in this turn";
  }
}

/**
 * The Diff surface: one changed file at a time beside the scope's file tree. The scope is every
 * change on the branch, uncommitted work, one commit, or one agent turn; the first file in the
 * tree opens until another is picked.
 */
export default function DiffPanel({
  mode = "embedded",
  composerDraftTarget,
  workspaceMutationId,
}: DiffPanelProps) {
  const data = useDiffPanelData({ workspaceMutationId });
  const { threadRef, selection, files } = data;
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const openFilePath = useDiffPanelStore((state) =>
    threadKey ? (state.openFileByThreadKey[threadKey] ?? null) : null,
  );
  const orderedFiles = useMemo(() => orderDiffChangesTreeFiles(files, filePathOf), [files]);
  // The picked file while it is still in scope, otherwise the first one the tree lists.
  const openFile =
    orderedFiles.find((file) => file.filePath === openFilePath) ?? orderedFiles[0] ?? null;

  const selectScope = (next: DiffPanelSelection) => {
    if (!threadRef) return;
    useDiffPanelStore.getState().selectScope(threadRef, next);
  };
  const scopeLabel =
    selection.kind === "branch"
      ? "All changes"
      : selection.kind === "unstaged"
        ? "Uncommitted"
        : selection.kind === "commit"
          ? selection.sha.slice(0, 7)
          : `Turn ${data.selectedTurn?.turnCount ?? "?"}`;

  const scopeControls = (
    <>
      {threadRef && data.environmentId && data.isGitRepo ? (
        <DiffScopeMenu
          selection={selection}
          label={scopeLabel}
          title={data.scopeTitle}
          selectedTurnId={data.selectedTurn?.summary.turnId ?? null}
          uncommittedFileCount={data.uncommittedFileCount}
          commits={data.commits}
          commitsTruncated={data.commitsTruncated}
          turns={data.turns}
          onSelect={selectScope}
          targetBranchPicker={
            data.previewCwd ? (
              <DiffTargetBranchPicker
                environmentId={data.environmentId}
                cwd={data.previewCwd}
                selectedBaseRef={data.selectedBaseRef}
                resolvedBaseRef={data.targetBaseRef}
                headRef={data.headRef}
                onSelect={(baseRef) =>
                  useDiffPanelStore.getState().selectBaseRef(threadRef, baseRef)
                }
              />
            ) : null
          }
        />
      ) : null}
    </>
  );

  if (openFile && data.renderablePatch?.kind === "files") {
    return (
      <DiffFileView
        mode={mode}
        data={data}
        filePath={openFile.filePath}
        orderedFiles={orderedFiles}
        scopeControls={scopeControls}
        composerDraftTarget={composerDraftTarget}
      />
    );
  }

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1 [-webkit-app-region:no-drag]">
        {scopeControls}
      </div>
      {data.canRefresh ? (
        <div className="flex shrink-0 items-center [-webkit-app-region:no-drag]">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={data.isRefreshing ? "Refreshing diff" : "Refresh diff"}
                  onClick={data.refresh}
                />
              }
            >
              <RefreshIcon className="size-3.5" refreshing={data.isRefreshing} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {data.isRefreshing ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </>
  );

  const body = (() => {
    if (!data.thread) {
      return (
        <p className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect its changes.
        </p>
      );
    }
    if (!data.isGitRepo) {
      return (
        <p className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Diffs are unavailable because this project is not a Git repository.
        </p>
      );
    }
    if (!data.renderablePatch && data.isLoading) {
      return <DiffPanelLoadingState label="Loading changes..." />;
    }
    if (data.error && !data.renderablePatch) {
      return <p className="px-4 py-3 text-xs text-error/80">{data.error}</p>;
    }
    if (data.renderablePatch?.kind === "raw") {
      return (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <p className="mb-2 text-[11px] text-muted-foreground/75">{data.renderablePatch.reason}</p>
          <pre className="overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
            {data.renderablePatch.text}
          </pre>
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-5 text-center">
        <GitCompareArrowsIcon className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
        <p className="text-sm text-muted-foreground">{emptyScopeMessage(selection)}</p>
      </div>
    );
  })();

  return (
    <DiffPanelShell mode={mode} header={header}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {body}
      </div>
    </DiffPanelShell>
  );
}
