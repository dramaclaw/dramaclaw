// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { createDefaultScene, type PrevizScene } from "@/features/previz/domain/scene";
import { PREVIZ_HISTORY_LIMIT, usePrevizStore } from "@/features/previz/store";

function sceneWithDuration(frames: number): PrevizScene {
  const scene = createDefaultScene();
  scene.settings.durationFrames = frames;
  return scene;
}

describe("previz store", () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  it("marks the scene dirty on apply and clean on save", () => {
    expect(usePrevizStore.getState().dirty).toBe(false);

    usePrevizStore.getState().applyScene(sceneWithDuration(200));
    expect(usePrevizStore.getState().dirty).toBe(true);

    usePrevizStore.getState().markSaved();
    expect(usePrevizStore.getState().dirty).toBe(false);
  });

  it("undoes and redoes scene edits", () => {
    usePrevizStore.getState().applyScene(sceneWithDuration(200));
    usePrevizStore.getState().applyScene(sceneWithDuration(300));

    usePrevizStore.getState().undo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(200);

    usePrevizStore.getState().undo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(120);

    usePrevizStore.getState().redo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(200);

    usePrevizStore.getState().redo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(300);
  });

  it("ignores undo and redo when there is nothing to move to", () => {
    usePrevizStore.getState().undo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(120);

    usePrevizStore.getState().redo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(120);
  });

  it("drops the redo stack after a new edit", () => {
    usePrevizStore.getState().applyScene(sceneWithDuration(200));
    usePrevizStore.getState().undo();
    usePrevizStore.getState().applyScene(sceneWithDuration(300));

    expect(usePrevizStore.getState().future).toEqual([]);
  });

  it("loading a scene resets history and the dirty flag", () => {
    usePrevizStore.getState().applyScene(sceneWithDuration(200));
    usePrevizStore.getState().loadScene(sceneWithDuration(360));

    const state = usePrevizStore.getState();
    expect(state.scene.settings.durationFrames).toBe(360);
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(state.dirty).toBe(false);
  });

  it("caps the undo stack and keeps the most recent entries", () => {
    for (let index = 0; index < PREVIZ_HISTORY_LIMIT + 10; index += 1) {
      usePrevizStore.getState().applyScene(sceneWithDuration(1 + index));
    }

    // History records the scene *before* each edit, so the pushes are
    // [120, 1, 2, ... 59] and the cap must drop the oldest 10, not the newest.
    const past = usePrevizStore.getState().past;
    expect(past).toHaveLength(PREVIZ_HISTORY_LIMIT);
    expect(past.map((scene) => scene.settings.durationFrames)).toEqual(
      Array.from({ length: PREVIZ_HISTORY_LIMIT }, (_, index) => index + 10),
    );

    usePrevizStore.getState().undo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(59);
  });
});
