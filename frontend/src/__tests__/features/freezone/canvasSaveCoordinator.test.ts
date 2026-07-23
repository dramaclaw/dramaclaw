// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  createCanvasSaveSession,
  type CanvasSaveSession,
} from "@/features/freezone/canvasSaveCoordinator";

/** A `runSave` whose completions the test drives by hand. */
function controllable() {
  const calls: number[] = [];
  const releases: Array<(persisted: boolean) => void> = [];
  let active = 0;
  let maxActive = 0;
  const runSave = (version: number) => {
    calls.push(version);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<boolean>((resolve) => {
      releases.push((persisted: boolean) => {
        active -= 1;
        resolve(persisted);
      });
    });
  };
  return {
    runSave,
    calls,
    releases,
    maxActive: () => maxActive,
  };
}

function session(runSave: CanvasSaveSessionOptionsRunSave): CanvasSaveSession {
  return createCanvasSaveSession({
    canvasKey: "project-a:canvas-a",
    generation: 1,
    runSave,
  });
}

type CanvasSaveSessionOptionsRunSave = (
  version: number,
  self: CanvasSaveSession,
) => Promise<boolean>;

/** Let queued microtasks drain. */
const tick = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

describe("createCanvasSaveSession", () => {
  it("keeps at most one request on the wire", async () => {
    const gate = controllable();
    const s = session(gate.runSave);

    void s.requestSave();
    void s.requestSave();
    void s.requestSave();
    await tick();

    expect(gate.calls).toHaveLength(1);
    expect(gate.maxActive()).toBe(1);

    gate.releases[0](true);
    await tick();

    // Three requests collapse into two sends: the one on the wire, plus a
    // single follow-up carrying whatever the store holds by then.
    expect(gate.calls).toHaveLength(2);
    expect(gate.maxActive()).toBe(1);
  });

  it("coalesces every edit made during a request into one follow-up", async () => {
    const gate = controllable();
    const s = session(gate.runSave);

    void s.requestSave(); // version 1 -> sent
    await tick();
    void s.requestSave(); // version 2 -> queued
    void s.requestSave(); // version 3 -> supersedes 2
    void s.requestSave(); // version 4 -> supersedes 3
    gate.releases[0](true);
    await tick();

    expect(gate.calls).toEqual([1, 4]);
  });

  it("releases a waiter only once a request covering its version lands", async () => {
    const gate = controllable();
    const s = session(gate.runSave);

    const first = s.requestSave();
    await tick();
    const second = s.requestSave();

    let firstDone = false;
    let secondDone = false;
    void first.then(() => {
      firstDone = true;
    });
    void second.then(() => {
      secondDone = true;
    });

    gate.releases[0](true);
    await tick();
    // The first save landed; the second's content is only now being sent.
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(false);

    gate.releases[1](true);
    await tick();
    expect(secondDone).toBe(true);
    expect(await second).toBe(true);
    expect(s.savedVersion()).toBe(2);
  });

  it("reports failure to every waiter and stops the pump", async () => {
    const gate = controllable();
    const s = session(gate.runSave);

    const first = s.requestSave();
    await tick();
    const second = s.requestSave();

    gate.releases[0](false);
    await tick();

    expect(await first).toBe(false);
    expect(await second).toBe(false);
    // No retry storm: a terminal failure parks the pump until a real edit.
    expect(gate.calls).toEqual([1]);
    expect(s.isSaving()).toBe(false);

    // A fresh edit restarts it.
    void s.requestSave();
    await tick();
    expect(gate.calls).toEqual([1, 3]);
  });

  it("reports newer unsaved content so the draft is not dropped early", async () => {
    const gate = controllable();
    const s = session(gate.runSave);

    void s.requestSave();
    await tick();
    // Nothing newer yet — the save on the wire covers everything.
    expect(s.hasUnsavedContentBeyond(1)).toBe(false);

    void s.requestSave();
    // Now version 2 is queued and exists only in the draft.
    expect(s.hasUnsavedContentBeyond(1)).toBe(true);

    gate.releases[0](true);
    await tick();
    // Version 2 is the one on the wire now; nothing newer behind it.
    expect(s.hasUnsavedContentBeyond(2)).toBe(false);
  });

  it("releases waiters and drops queued work when disposed", async () => {
    const gate = controllable();
    const s = session(gate.runSave);

    void s.requestSave();
    await tick();
    const queued = s.requestSave();

    s.dispose();
    expect(await queued).toBe(false);
    expect(s.isDisposed()).toBe(true);

    // The request already on the wire is left to finish server-side, but its
    // completion must not drain the queue of a session nobody is watching.
    gate.releases[0](true);
    await tick();
    expect(gate.calls).toEqual([1]);

    // And a disposed session accepts no further work.
    expect(await s.requestSave()).toBe(false);
    expect(gate.calls).toEqual([1]);
  });

  it("keeps two canvases' save lifecycles independent", async () => {
    const a = controllable();
    const b = controllable();
    const sessionA = createCanvasSaveSession({
      canvasKey: "project-a:canvas-a",
      generation: 1,
      runSave: a.runSave,
    });
    const sessionB = createCanvasSaveSession({
      canvasKey: "project-a:canvas-b",
      generation: 2,
      runSave: b.runSave,
    });

    void sessionA.requestSave();
    await tick();
    expect(a.calls).toHaveLength(1);

    // Canvas A is still on the wire; canvas B must not queue behind it.
    const bSaved = sessionB.requestSave();
    await tick();
    expect(b.calls).toHaveLength(1);

    b.releases[0](true);
    await tick();
    expect(await bSaved).toBe(true);
    // Canvas B landing says nothing about canvas A.
    expect(sessionA.savedVersion()).toBe(0);
    expect(sessionB.savedVersion()).toBe(1);
  });

  it("restarts the pump when a waiter schedules another save as it resolves", async () => {
    const gate = controllable();
    const s = session(gate.runSave);

    // The hook does exactly this shape: code resumes from `await requestSave()`
    // and immediately saves again. That resumption happens in a microtask *after*
    // the pump has seen an empty queue but *before* it has cleared its running
    // flag, so the new request lands in the blind spot between the two.
    const followUps: Array<Promise<boolean>> = [];
    void s.requestSave().then(() => {
      followUps.push(s.requestSave());
    });
    await tick();
    expect(gate.calls).toEqual([1]);

    gate.releases[0](true);
    await tick();

    // Without a re-check on the way out, version 2 would sit in the queue
    // forever and its promise would never settle.
    expect(gate.calls).toEqual([1, 2]);

    gate.releases[1](true);
    await tick();
    expect(await followUps[0]).toBe(true);
    expect(s.savedVersion()).toBe(2);
  });

  it("does not let a rejected runSave escape as an unhandled rejection", async () => {
    const s = createCanvasSaveSession({
      canvasKey: "project-a:canvas-a",
      generation: 1,
      runSave: () => Promise.reject(new Error("network down")),
    });

    expect(await s.requestSave()).toBe(false);
  });
});
