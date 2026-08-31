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

  // redo 必须把当前场景压回 past，否则「redo 之后再 undo」会静默失灵——而这条
  // 路径只有折返才可观测：用例 2 是 undo 到底再 redo 回顶的单向走法，抓不到。
  it("keeps undo working after a redo", () => {
    usePrevizStore.getState().applyScene(sceneWithDuration(200));
    usePrevizStore.getState().applyScene(sceneWithDuration(300));

    usePrevizStore.getState().undo();
    usePrevizStore.getState().undo();
    usePrevizStore.getState().redo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(200);

    usePrevizStore.getState().undo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(120);
  });

  // markSaved 只该动 dirty。历史一起清掉的实现能通过其余所有用例，但用户一保存
  // 就丢光 undo 历史。
  it("markSaved clears only the dirty flag", () => {
    usePrevizStore.getState().applyScene(sceneWithDuration(200));
    const before = usePrevizStore.getState();

    usePrevizStore.getState().markSaved();

    const after = usePrevizStore.getState();
    expect(after.dirty).toBe(false);
    expect(after.scene).toBe(before.scene);
    expect(after.past).toBe(before.past);
    expect(after.future).toBe(before.future);

    usePrevizStore.getState().undo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(120);
  });

  // undo / redo 无条件置脏是刻意的保守选择（宁可多存不可少存），必须有测试钉住，
  // 否则被误删没人发现，将来真要改成与保存点比对时也没有红线提示边界在哪。
  it("marks the scene dirty again when undo or redo moves it", () => {
    usePrevizStore.getState().applyScene(sceneWithDuration(200));
    usePrevizStore.getState().markSaved();
    expect(usePrevizStore.getState().dirty).toBe(false);

    usePrevizStore.getState().undo();
    expect(usePrevizStore.getState().dirty).toBe(true);

    usePrevizStore.getState().markSaved();
    usePrevizStore.getState().redo();
    expect(usePrevizStore.getState().dirty).toBe(true);
  });
});
