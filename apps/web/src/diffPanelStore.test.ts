import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const THREAD_KEY = scopedThreadKey(THREAD_REF);

const selection = () =>
  selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF);

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      openFileByThreadKey: {},
    }),
  );

  it("defaults each thread to all changes", () => {
    expect(selection()).toEqual({ kind: "branch" });
  });

  it("keeps the target branch when the scope changes", () => {
    const store = useDiffPanelStore.getState();
    store.selectBaseRef(THREAD_REF, " origin/main ");
    store.selectScope(THREAD_REF, { kind: "commit", sha: "abc1234" });
    store.selectScope(THREAD_REF, { kind: "branch" });

    expect(selection()).toEqual({ kind: "branch" });
    expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[THREAD_KEY]).toBe("origin/main");
  });

  it("opens a turn's file when one is given", () => {
    const turnId = TurnId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");

    expect(selection()).toEqual({ kind: "turn", turnId });
    expect(useDiffPanelStore.getState().openFileByThreadKey[THREAD_KEY]).toBe("src/app.ts");
  });

  it("reconciles a missing turn selection to the latest available turn", () => {
    const latestTurnId = TurnId.make("turn-latest");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, TurnId.make("turn-missing"));
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId]);

    expect(selection()).toEqual({ kind: "turn", turnId: latestTurnId });
  });
});
