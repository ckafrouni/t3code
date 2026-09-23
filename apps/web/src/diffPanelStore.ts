import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * What the diff panel compares. `branch` is every change on the thread's branch, committed and
 * not, against the target branch; `unstaged` is uncommitted work only.
 */
export type DiffPanelSelection =
  | { kind: "branch" }
  | { kind: "unstaged" }
  | { kind: "commit"; sha: string }
  | { kind: "turn"; turnId: TurnId };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch" };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  /** The comparison target per thread; null lets the server pick the base branch. */
  branchBaseRefByThreadKey: Record<string, string | null>;
  /** Session-only: the file open in the Diff panel; none opens the first file in the tree. */
  openFileByThreadKey: Record<string, string>;
  selectScope: (ref: ScopedThreadRef, selection: DiffPanelSelection) => void;
  selectBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: TurnId, filePath?: string) => void;
  openFile: (ref: ScopedThreadRef, filePath: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<TurnId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      openFileByThreadKey: {},
      selectScope: (ref, selection) =>
        set((state) => ({
          byThreadKey: { ...state.byThreadKey, [scopedThreadKey(ref)]: selection },
        })),
      selectBaseRef: (ref, baseRef) =>
        set((state) => ({
          branchBaseRefByThreadKey: {
            ...state.branchBaseRefByThreadKey,
            [scopedThreadKey(ref)]: normalizeBaseRef(baseRef),
          },
        })),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          return {
            byThreadKey: { ...state.byThreadKey, [threadKey]: { kind: "turn", turnId } },
            openFileByThreadKey: filePath
              ? { ...state.openFileByThreadKey, [threadKey]: filePath }
              : state.openFileByThreadKey,
          };
        }),
      openFile: (ref, filePath) =>
        set((state) => ({
          openFileByThreadKey: { ...state.openFileByThreadKey, [scopedThreadKey(ref)]: filePath },
        })),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "turn", turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          return {
            byThreadKey: withoutKey(state.byThreadKey, threadKey),
            branchBaseRefByThreadKey: withoutKey(state.branchBaseRefByThreadKey, threadKey),
            openFileByThreadKey: withoutKey(state.openFileByThreadKey, threadKey),
          };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_SELECTION;
}
