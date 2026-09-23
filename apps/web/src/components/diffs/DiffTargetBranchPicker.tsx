import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronsUpDownIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { buildBaseRefChoices, filterBaseRefChoices } from "~/lib/baseRefChoices";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const AUTOMATIC_BASE_REF = "__automatic_base_ref__";

/**
 * Picks the branch the diff compares against. "Automatic" hands the choice back to the server,
 * which resolves the thread branch's merge target; a ref present both locally and on the remote
 * gets a switch between the two.
 */
export function DiffTargetBranchPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** The explicit choice, or null while automatic. */
  readonly selectedBaseRef: string | null;
  /** What the comparison currently resolves to, shown on the trigger. */
  readonly resolvedBaseRef: string | null;
  readonly headRef: string | null;
  readonly onSelect: (baseRef: string | null) => void;
}) {
  const { environmentId, cwd, selectedBaseRef, onSelect } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const listInput = (refKind: "local" | "remote") => ({
    environmentId,
    input: {
      cwd,
      includeMatchingRemoteRefs: true,
      refKind,
      ...(trimmedQuery.length > 0 ? { query: trimmedQuery } : {}),
      limit: 100,
    },
  });
  // Only listed while the picker is open: refs are a large read the menu rarely needs.
  const localRefs = useEnvironmentQuery(open ? vcsEnvironment.listRefs(listInput("local")) : null);
  const remoteRefs = useEnvironmentQuery(
    open ? vcsEnvironment.listRefs(listInput("remote")) : null,
  );
  const choices = buildBaseRefChoices(
    localRefs.data?.refs.filter((ref) => ref.name !== props.headRef) ?? [],
    remoteRefs.data?.refs ?? [],
  );
  const valueForChoice = (choice: (typeof choices)[number]) =>
    selectedBaseRef && selectedBaseRef === choice.remote?.name
      ? selectedBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const items = [AUTOMATIC_BASE_REF, ...choices.map(valueForChoice)];
  const filteredItems = [
    ...(trimmedQuery.length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...filterBaseRefChoices(choices, query).map(valueForChoice),
  ];
  const label = props.resolvedBaseRef ?? selectedBaseRef ?? "Automatic";

  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
      onValueChange={(value) => {
        if (!value) return;
        onSelect(value === AUTOMATIC_BASE_REF ? null : value);
      }}
    >
      <ComboboxTrigger
        className="inline-flex min-w-0 max-w-48 items-center gap-1 overflow-hidden rounded-md px-1.5 py-1 text-sm text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Change target branch. Currently ${label}`}
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-60" />
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden">
        <div className="min-w-0 shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
            />
            <ComboboxInput
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent text-sm"
              placeholder="Search refs..."
              showTrigger={false}
              size="sm"
              unstyled
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
          <span aria-hidden="true" />
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
            <span>Branch</span>
            <span className="text-right">Remote</span>
          </div>
        </div>
        <ComboboxEmpty>No matching refs.</ComboboxEmpty>
        <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
          <ComboboxItem
            className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
            contentClassName="w-full min-w-0 overflow-hidden"
            value={AUTOMATIC_BASE_REF}
          >
            <span className="block min-w-0 truncate">Automatic</span>
          </ComboboxItem>
          {choices.map((choice) => {
            const item = valueForChoice(choice);
            const hasBoth = choice.local !== null && choice.remote !== null;
            const useRemote = choice.remote?.name === item;
            return (
              <ComboboxItem
                key={choice.id}
                className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                contentClassName="w-full min-w-0 overflow-hidden"
                value={item}
              >
                <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                  <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                  {hasBoth ? (
                    <div
                      className="flex justify-end"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <Switch
                        aria-label={`Use remote version of ${choice.label}`}
                        checked={useRemote}
                        className="[--thumb-size:--spacing(3)]"
                        onCheckedChange={(checked) => {
                          const nextRef = checked ? choice.remote?.name : choice.local?.name;
                          if (nextRef) onSelect(nextRef);
                        }}
                      />
                    </div>
                  ) : choice.remote ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="flex justify-end text-muted-foreground">
                            <CheckIcon role="img" aria-label="Remote only" className="size-3" />
                          </span>
                        }
                      />
                      <TooltipPopup side="top">Remote only</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
