import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Columns2Icon,
  FileTextIcon,
  FolderTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useMemo, useState, type ReactNode } from "react";

import { type DraftId } from "~/composerDraftStore";
import { openDiffFilePrimaryAction } from "~/diffFileActions";
import { useDiffPanelStore } from "~/diffPanelStore";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName, resolveFileDiffPath } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DiffPanelShell, type DiffPanelMode } from "../DiffPanelShell";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { AnnotatableCodeView } from "./AnnotatableCodeView";
import { DiffChangesTree, type DiffChangesTreeFileActions } from "./DiffChangesTree";
import type { DiffPanelData, DiffPanelFile } from "./useDiffPanelData";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const EXPAND_UNCHANGED_STORAGE_KEY = "t3code.diffExpandUnchanged";
const FILE_TREE_OPEN_STORAGE_KEY = "t3code.diffPanelFileTreeOpen";
const FILE_TREE_WIDTH_STORAGE_KEY = "t3code.diffFileTreeWidth";
const FILE_TREE_DEFAULT_WIDTH = 272;
const FILE_TREE_MIN_WIDTH = 160;
const FILE_TREE_MAX_WIDTH = 480;

type DiffViewMode = "stacked" | "split" | "file";

interface DiffFileViewProps {
  readonly mode: DiffPanelMode;
  readonly data: DiffPanelData;
  /** The open file; always one of `data.files`. */
  readonly filePath: string;
  /** `data.files` in the tree's reading order, which previous and next follow. */
  readonly orderedFiles: ReadonlyArray<DiffPanelFile>;
  /** Scope menu, owned by the panel so the empty state can show it too. */
  readonly scopeControls: ReactNode;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
}

function IconToggle(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onPressedChange: (pressed: boolean) => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={props.label}
            variant="ghost"
            size="sm"
            pressed={props.pressed}
            onPressedChange={(pressed) => props.onPressedChange(Boolean(pressed))}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One file's diff inside the Diff panel, with the scope's changed-files tree beside it to move
 * between files. The tree can be resized and hidden.
 */
export function DiffFileView({
  mode,
  data,
  filePath,
  orderedFiles,
  scopeControls,
  composerDraftTarget,
}: DiffFileViewProps) {
  const { threadRef, files, selection } = data;
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const updateClientSettings = useUpdateClientSettings();
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [expandUnchanged, setExpandUnchanged] = useLocalStorage(
    EXPAND_UNCHANGED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    FILE_TREE_OPEN_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const { width: treeWidth, handlers: treeResizeHandlers } = useResizableWidth({
    storageKey: FILE_TREE_WIDTH_STORAGE_KEY,
    defaultWidth: FILE_TREE_DEFAULT_WIDTH,
    minWidth: FILE_TREE_MIN_WIDTH,
    maxWidth: FILE_TREE_MAX_WIDTH,
    edge: "left",
  });
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const selectFile = (filePath: string) => {
    if (threadRef) useDiffPanelStore.getState().openFile(threadRef, filePath);
  };
  const openInPreferredEditor = useOpenInPreferredEditor(data.environmentId, data.availableEditors);
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => toastManager.add({ type: "success", title: "Path copied" }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Failed to copy path", description: error.message }),
  });
  const openInFiles = (path: string) =>
    openDiffFilePrimaryAction({
      threadRef,
      filePath: path,
      activeCwd: data.cwd,
      repositoryRoot: data.repositoryRoot,
      openInEditor: (targetPath) => {
        void (async () => {
          const result = await openInPreferredEditor(targetPath);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            console.warn("Failed to open diff file in editor.", {
              operation: "open-diff-file",
              ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
            });
          }
        })();
      },
    });
  const actions: DiffChangesTreeFileActions = {
    onOpenFile: selectFile,
    onOpenInFiles: openInFiles,
    onCopyPath: (path) => copyToClipboard(path, undefined),
  };

  const canExpandUnchanged = data.loadDiffFiles !== undefined;
  const viewMode: DiffViewMode =
    expandUnchanged && canExpandUnchanged ? "file" : settings.diffLayout;
  const setViewMode = (next: DiffViewMode) => {
    if (next === "file") {
      setExpandUnchanged(true);
      return;
    }
    setExpandUnchanged(false);
    updateClientSettings({ diffLayout: next });
  };

  const selectedIndex = Math.max(
    0,
    orderedFiles.findIndex((file) => file.filePath === filePath),
  );
  const selectedFile = orderedFiles[selectedIndex];
  const stepFile = (delta: -1 | 1) => {
    const next = orderedFiles[selectedIndex + delta];
    if (next) selectFile(next.filePath);
  };
  const codeViewFiles = useMemo(
    () =>
      selectedFile
        ? [
            {
              fileDiff: selectedFile.fileDiff,
              filePath: selectedFile.filePath,
              fileKey: selectedFile.fileKey,
              fileVersion: selectedFile.fileVersion,
              collapsed: false,
            },
          ]
        : [],
    [selectedFile],
  );
  // Each file mounts its own viewer, so switching files always lands at the top of the new one.
  const codeViewKey = `${threadKey ?? ""}:${data.sectionId}:${selectedFile?.fileKey ?? ""}`;

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1 [-webkit-app-region:no-drag]">
        <div className="me-1 flex min-w-0 shrink items-center">{scopeControls}</div>
        {orderedFiles.length > 0 ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Previous file"
                    disabled={selectedIndex === 0}
                    onClick={() => stepFile(-1)}
                  />
                }
              >
                <ChevronUpIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Previous file</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Next file"
                    disabled={selectedIndex >= orderedFiles.length - 1}
                    onClick={() => stepFile(1)}
                  />
                }
              >
                <ChevronDownIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Next file</TooltipPopup>
            </Tooltip>
            <span className="ms-1 shrink-0 text-xs tabular-nums text-muted-foreground">
              {selectedIndex + 1} / {orderedFiles.length}
            </span>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {data.canRefresh ? (
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
        ) : null}
        <ToggleGroup
          aria-label="Diff view"
          className="shrink-0"
          variant="segmented"
          value={[viewMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split" || next === "file") setViewMode(next);
          }}
        >
          <Toggle aria-label="Unified diff" value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff" value="split">
            <Columns2Icon className="size-3.5" />
          </Toggle>
          <Tooltip>
            <TooltipTrigger
              render={<Toggle aria-label="Full file" value="file" disabled={!canExpandUnchanged} />}
            >
              <FileTextIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {canExpandUnchanged ? "Full file" : "Full files are unavailable for turn diffs"}
            </TooltipPopup>
          </Tooltip>
        </ToggleGroup>
        <IconToggle
          label={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          pressed={wordWrap}
          onPressedChange={setWordWrap}
        >
          <TextWrapIcon className="size-3.5" />
        </IconToggle>
        <IconToggle
          label={
            settings.diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
          }
          pressed={settings.diffIgnoreWhitespace}
          onPressedChange={(pressed) => updateClientSettings({ diffIgnoreWhitespace: pressed })}
        >
          <PilcrowIcon className="size-3.5" />
        </IconToggle>
        <IconToggle
          label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
          pressed={fileTreeOpen}
          onPressedChange={setFileTreeOpen}
        >
          <FolderTreeIcon className="size-3.5" />
        </IconToggle>
      </div>
    </>
  );

  const fileView = (() => {
    return (
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        onClickCapture={(event) => {
          const composedPath = event.nativeEvent.composedPath?.() ?? [];
          // Header controls keep their own actions.
          if (
            composedPath.some(
              (node) => node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement,
            )
          ) {
            return;
          }
          const title = composedPath.find(
            (node): node is HTMLElement =>
              node instanceof HTMLElement && node.hasAttribute("data-title"),
          );
          const titlePath = title?.textContent?.trim();
          // The filename is the "open file" affordance.
          if (titlePath) openInFiles(titlePath);
        }}
      >
        {data.truncated ? (
          <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            This diff exceeded the preview limit, so some files are missing.
          </p>
        ) : null}
        {selectedFile ? (
          <AnnotatableCodeView
            key={codeViewKey}
            codeViewKey={codeViewKey}
            className="min-h-0 flex-1 overflow-auto"
            files={codeViewFiles}
            sectionId={data.sectionId}
            sectionTitle={data.scopeTitle}
            composerDraftTarget={composerDraftTarget}
            renderHeaderFilenameSuffix={(fileDiff) => (
              <DiffFilePathCopyButton filePath={resolveFileDiffPath(fileDiff)} />
            )}
            renderHeaderPrefix={() => null}
            options={{
              diffStyle: viewMode === "split" ? "split" : "unified",
              lineDiffType: "none",
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: resolvedTheme,
              stickyHeaders: true,
              expandUnchanged: viewMode === "file",
              ...(data.loadDiffFiles ? { loadDiffFiles: data.loadDiffFiles } : {}),
            }}
          />
        ) : (
          <p className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            No files in this selection.
          </p>
        )}
      </div>
    );
  })();

  return (
    <DiffPanelShell
      mode={mode}
      header={header}
      headerClassName="in-data-[preview-panel-mode=inline]:mb-0 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-border/60"
    >
      <div
        className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
        data-diff-scope={selection.kind}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{fileView}</div>
        {fileTreeOpen && files.length > 0 ? (
          <aside
            className="relative flex min-w-0 shrink-0 flex-col border-l border-border/60"
            style={{ width: treeWidth }}
          >
            <RightPanelResizeHandle handlers={treeResizeHandlers} />
            <div className="flex h-8 shrink-0 items-center gap-2 px-2.5">
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {files.length} {files.length === 1 ? "file" : "files"}
              </span>
              <DiffStatLabel
                additions={data.lineStat.additions}
                deletions={data.lineStat.deletions}
                layout="inline"
                className="shrink-0 text-[11px]"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <DiffChangesTree
                files={files}
                selectedPath={selectedFile?.filePath ?? null}
                actions={actions}
                ariaLabel={`${data.scopeTitle} files`}
              />
            </div>
          </aside>
        ) : null}
      </div>
    </DiffPanelShell>
  );
}
