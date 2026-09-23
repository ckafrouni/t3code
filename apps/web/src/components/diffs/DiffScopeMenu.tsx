import type { ReviewCommit } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { DiffPanelSelection } from "~/diffPanelStore";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel, formatShortTimestamp } from "~/timestampFormat";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DiffPanelTurn } from "./useDiffPanelData";

function ScopeOption(props: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selected}
      onClick={props.onSelect}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{props.title}</span>
        {props.detail ? (
          <span className="truncate text-xs text-muted-foreground">{props.detail}</span>
        ) : null}
      </span>
      {props.selected ? <CheckIcon className="size-4 shrink-0 text-foreground" /> : null}
    </button>
  );
}

function SectionLabel(props: { readonly children: ReactNode }) {
  return (
    <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
      {props.children}
    </div>
  );
}

/**
 * The diff panel's scope chooser: the comparison target, then every change on the branch, only
 * uncommitted work, one commit, or one agent turn.
 */
export function DiffScopeMenu(props: {
  readonly selection: DiffPanelSelection;
  /** What the trigger shows: the scope currently on screen. */
  readonly label: string;
  /** Full scope name, e.g. a commit subject, for the trigger's tooltip. */
  readonly title: string;
  readonly selectedTurnId: string | null;
  readonly uncommittedFileCount: number | null;
  readonly commits: ReadonlyArray<ReviewCommit>;
  readonly commitsTruncated: boolean;
  readonly turns: ReadonlyArray<DiffPanelTurn>;
  readonly targetBranchPicker: ReactNode;
  readonly onSelect: (selection: DiffPanelSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const { timestampFormat } = useClientSettings();
  const select = (selection: DiffPanelSelection) => {
    props.onSelect(selection);
    setOpen(false);
  };
  const uncommittedDetail =
    props.uncommittedFileCount === null
      ? null
      : props.uncommittedFileCount === 0
        ? "No uncommitted changes"
        : `${props.uncommittedFileCount} ${props.uncommittedFileCount === 1 ? "file" : "files"} changed`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`Showing ${props.title}. Choose which changes to show`}
                  className={cn(
                    "inline-flex h-6 min-w-0 max-w-44 shrink cursor-pointer items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring",
                    open && "bg-accent/80",
                  )}
                />
              }
            />
          }
        >
          <span
            className={cn("min-w-0 truncate", props.selection.kind === "commit" && "font-mono")}
          >
            {props.label}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
        </TooltipTrigger>
        <TooltipPopup side="top">{props.title}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" sideOffset={6} className="w-80 max-w-[calc(100vw-1rem)]">
        <div className="flex max-h-[min(32rem,70vh)] min-h-0 w-full flex-col overflow-y-auto p-1">
          <div className="flex items-center justify-between gap-2 py-0.5 ps-2.5">
            <span className="shrink-0 text-sm text-muted-foreground">Target branch</span>
            {props.targetBranchPicker}
          </div>
          <div className="-mx-1 my-1 h-px bg-border/70" />
          <div role="menu" aria-label="Changes to show">
            <ScopeOption
              selected={props.selection.kind === "branch"}
              onSelect={() => select({ kind: "branch" })}
              title="All changes"
            />
            <ScopeOption
              selected={props.selection.kind === "unstaged"}
              onSelect={() => select({ kind: "unstaged" })}
              title="Uncommitted changes"
              detail={uncommittedDetail}
            />
            {props.commits.length > 0 ? (
              <>
                <div className="-mx-1 my-1 h-px bg-border/70" />
                <SectionLabel>Commits</SectionLabel>
                {props.commits.map((commit) => (
                  <ScopeOption
                    key={commit.sha}
                    selected={
                      props.selection.kind === "commit" && props.selection.sha === commit.sha
                    }
                    onSelect={() => select({ kind: "commit", sha: commit.sha })}
                    title={commit.subject || commit.sha.slice(0, 7)}
                    detail={
                      <>
                        <span className="font-mono">{commit.sha.slice(0, 7)}</span>
                        {commit.authorName ? ` • ${commit.authorName}` : ""}
                        {commit.authoredAt
                          ? ` • ${formatRelativeTimeLabel(commit.authoredAt)}`
                          : ""}
                      </>
                    }
                  />
                ))}
                {props.commitsTruncated ? (
                  <p className="px-2.5 py-1 text-xs text-muted-foreground">
                    Showing the latest {props.commits.length} commits.
                  </p>
                ) : null}
              </>
            ) : null}
            {props.turns.length > 0 ? (
              <>
                <div className="-mx-1 my-1 h-px bg-border/70" />
                <SectionLabel>Agent turns</SectionLabel>
                {props.turns.map((turn) => (
                  <ScopeOption
                    key={turn.summary.turnId}
                    selected={props.selectedTurnId === turn.summary.turnId}
                    onSelect={() => select({ kind: "turn", turnId: turn.summary.turnId })}
                    title={`Turn ${turn.turnCount ?? "?"}`}
                    detail={`${turn.summary.files.length} ${turn.summary.files.length === 1 ? "file" : "files"} • ${formatShortTimestamp(turn.summary.completedAt, timestampFormat)}`}
                  />
                ))}
              </>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
