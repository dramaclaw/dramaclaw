// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { PREVIZ_OBJECT_LIMITS } from "@/features/previz/domain/limits";
import {
  PREVIZ_DEFAULT_HEIGHT_CM,
  PREVIZ_MAX_HEIGHT_CM,
  PREVIZ_OBJECT_BASE_NAME,
  createPrevizObject,
} from "@/features/previz/domain/objects";
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

  // 栈空时必须是「引用恒等的真空操作」：不止场景没变，dirty / past / future 也
  // 一个都不许动。只断言 durationFrames 的话，`set({ dirty: true })` 后再 return
  // 的实现照样全绿——用例名也就名不副实了。
  it("ignores undo and redo when there is nothing to move to", () => {
    const before = usePrevizStore.getState();

    usePrevizStore.getState().undo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(120);

    usePrevizStore.getState().redo();
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(120);

    expect(usePrevizStore.getState()).toBe(before);
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

describe("previz store object editing", () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  it("adds an object, selects it, and returns its id", () => {
    const id = usePrevizStore.getState().addObject("character");

    const state = usePrevizStore.getState();
    expect(id).not.toBeNull();
    expect(state.scene.objects).toHaveLength(1);
    expect(state.selectedObjectId).toBe(id);
    expect(state.dirty).toBe(true);
    // 每次新建都进历史：撤销一次应该恰好退掉这一个对象。
    expect(state.past).toHaveLength(1);
  });

  it("refuses to add past the per-kind limit and leaves the scene untouched", () => {
    const store = usePrevizStore.getState();
    for (let index = 0; index < PREVIZ_OBJECT_LIMITS.light; index += 1) {
      expect(store.addObject("light")).not.toBeNull();
    }

    const before = usePrevizStore.getState().scene;
    expect(usePrevizStore.getState().addObject("light")).toBeNull();
    // 同一个引用：越界那次连一份新场景都不该建出来，否则 undo 栈里多一步空操作。
    expect(usePrevizStore.getState().scene).toBe(before);
  });

  it("patches only the addressed object", () => {
    const first = usePrevizStore.getState().addObject("camera")!;
    const second = usePrevizStore.getState().addObject("camera")!;

    usePrevizStore.getState().updateObject(first, { focalMm: 85, name: "主机位" });

    const objects = usePrevizStore.getState().scene.objects;
    const patched = objects.find((object) => object.id === first);
    const untouched = objects.find((object) => object.id === second);
    expect(patched?.name).toBe("主机位");
    expect(patched?.kind === "camera" && patched.focalMm).toBe(85);
    expect(untouched?.kind === "camera" && untouched.focalMm).toBe(50);
  });

  // 未改动的对象要保持引用不变：场景图同步（Task 6）按引用跳过没动过的条目，
  // 每次编辑都把整份 objects 重建一遍等于让那条快路径永远不生效。
  it("keeps untouched objects referentially stable across a patch", () => {
    const first = usePrevizStore.getState().addObject("camera")!;
    const second = usePrevizStore.getState().addObject("camera")!;
    const before = usePrevizStore
      .getState()
      .scene.objects.find((object) => object.id === second);

    usePrevizStore.getState().updateObject(first, { focalMm: 85 });

    const after = usePrevizStore.getState().scene.objects.find((object) => object.id === second);
    expect(after).toBe(before);
  });

  // 属性面板的数字输入框会送来清空后的 NaN 与随手敲出的越界值。原样落进场景的话，
  // three 的 PerspectiveCamera 静默接受 NaN 焦距，画面全黑而故障点在几个文件之外。
  it("clamps out-of-range and non-finite numbers in a patch", () => {
    const id = usePrevizStore.getState().addObject("character")!;

    usePrevizStore.getState().updateObject(id, { heightCm: 9999 });
    const clamped = usePrevizStore.getState().scene.objects[0];
    expect(clamped.kind === "character" && clamped.heightCm).toBe(PREVIZ_MAX_HEIGHT_CM);

    usePrevizStore.getState().updateObject(id, { heightCm: Number.NaN });
    const restored = usePrevizStore.getState().scene.objects[0];
    expect(restored.kind === "character" && restored.heightCm).toBe(PREVIZ_DEFAULT_HEIGHT_CM);
  });

  // PrevizObjectPatch 是四个 kind 的 Partial 求交，所以往人物身上写 focalMm 编译期
  // 拦不住。落进场景的对象必须仍然只带自己 kind 的字段，否则 node.data 里会攒下
  // 一堆没人读、也过不了下一次 parseScene 的垃圾字段。
  it("drops fields that do not belong to the patched object's kind", () => {
    const id = usePrevizStore.getState().addObject("character")!;

    usePrevizStore.getState().updateObject(id, { focalMm: 85 });

    const patched = usePrevizStore.getState().scene.objects[0];
    expect(patched.id).toBe(id);
    expect("focalMm" in patched).toBe(false);
  });

  // 名字清空后落回类型基名，而不是留一个空串：图层面板按名字列条目，空串就是一行
  // 看不见的东西。这条与 parseScene 读盘时的兜底是同一个答案，不是 store 另立的规矩。
  it("falls back to the kind base name when a rename blanks it out", () => {
    const id = usePrevizStore.getState().addObject("light")!;

    usePrevizStore.getState().updateObject(id, { name: "   " });

    expect(usePrevizStore.getState().scene.objects[0].name).toBe(PREVIZ_OBJECT_BASE_NAME.light);
  });

  it("ignores a patch for an unknown id", () => {
    const before = usePrevizStore.getState().scene;
    usePrevizStore.getState().updateObject("nope", { name: "x" });
    expect(usePrevizStore.getState().scene).toBe(before);
  });

  it("removes an object together with its timeline track and selection", () => {
    const id = usePrevizStore.getState().addObject("prop")!;
    usePrevizStore.getState().applyScene({
      ...usePrevizStore.getState().scene,
      timeline: { tracks: [{ id: "t1", objectId: id, clips: [] }] },
    });

    usePrevizStore.getState().removeObject(id);

    const state = usePrevizStore.getState();
    expect(state.scene.objects).toHaveLength(0);
    // 留着轨道等于留一个悬空引用，P3 的求值器会撞上它。
    expect(state.scene.timeline.tracks).toHaveLength(0);
    expect(state.selectedObjectId).toBeNull();
  });

  it("keeps tracks that point at surviving objects", () => {
    const removed = usePrevizStore.getState().addObject("prop")!;
    const kept = usePrevizStore.getState().addObject("prop")!;
    usePrevizStore.getState().applyScene({
      ...usePrevizStore.getState().scene,
      timeline: {
        tracks: [
          { id: "t1", objectId: removed, clips: [] },
          { id: "t2", objectId: kept, clips: [] },
        ],
      },
    });

    usePrevizStore.getState().removeObject(removed);

    expect(usePrevizStore.getState().scene.timeline.tracks.map((track) => track.id)).toEqual([
      "t2",
    ]);
  });

  it("ignores a removal for an unknown id", () => {
    const before = usePrevizStore.getState().scene;
    usePrevizStore.getState().removeObject("nope");
    expect(usePrevizStore.getState().scene).toBe(before);
  });

  it("clears the active camera when that camera is removed", () => {
    const id = usePrevizStore.getState().addObject("camera")!;
    usePrevizStore.getState().setActiveCamera(id);

    usePrevizStore.getState().removeObject(id);

    expect(usePrevizStore.getState().activeCameraId).toBeNull();
  });

  // 删掉的不是当前选中项 / 不是监看机位时，两者都不许被顺手清掉。
  it("leaves the selection and active camera alone when another object is removed", () => {
    const camera = usePrevizStore.getState().addObject("camera")!;
    const doomed = usePrevizStore.getState().addObject("prop")!;
    usePrevizStore.getState().setActiveCamera(camera);
    usePrevizStore.getState().selectObject(camera);

    usePrevizStore.getState().removeObject(doomed);

    const state = usePrevizStore.getState();
    expect(state.selectedObjectId).toBe(camera);
    expect(state.activeCameraId).toBe(camera);
  });

  it("keeps selection out of the undo stack", () => {
    const id = usePrevizStore.getState().addObject("light")!;
    const before = usePrevizStore.getState();
    usePrevizStore.getState().markSaved();

    usePrevizStore.getState().selectObject(null);
    usePrevizStore.getState().selectObject(id);

    // 选中态是会话态：既不进历史，也不算一次未落盘的场景改动。
    const state = usePrevizStore.getState();
    expect(state.past).toHaveLength(before.past.length);
    expect(state.future).toBe(before.future);
    expect(state.scene).toBe(before.scene);
    expect(state.dirty).toBe(false);
    expect(state.selectedObjectId).toBe(id);
  });

  // 撤销一次删除该把对象撤回来，而不是顺带换掉用户当前选的东西。
  it("keeps the selection when undo brings a deleted object back", () => {
    const kept = usePrevizStore.getState().addObject("light")!;
    const doomed = usePrevizStore.getState().addObject("light")!;
    usePrevizStore.getState().selectObject(kept);

    usePrevizStore.getState().removeObject(doomed);
    expect(usePrevizStore.getState().selectedObjectId).toBe(kept);

    usePrevizStore.getState().undo();

    const state = usePrevizStore.getState();
    expect(state.scene.objects).toHaveLength(2);
    expect(state.selectedObjectId).toBe(kept);
  });

  it("routes settings changes through the history too", () => {
    usePrevizStore.getState().setDisplayMode("clay");
    usePrevizStore.getState().setOutputAspect("9:16");

    const state = usePrevizStore.getState();
    expect(state.scene.settings.displayMode).toBe("clay");
    expect(state.scene.settings.outputAspect).toBe("9:16");
    expect(state.past).toHaveLength(2);

    state.undo();
    expect(usePrevizStore.getState().scene.settings.outputAspect).toBe("16:9");
  });

  it("drops the selection when a fresh scene is loaded", () => {
    usePrevizStore.getState().addObject("character");
    usePrevizStore.getState().setActiveCamera("whatever");
    usePrevizStore.getState().loadScene(createDefaultScene());

    expect(usePrevizStore.getState().selectedObjectId).toBeNull();
    expect(usePrevizStore.getState().activeCameraId).toBeNull();
  });

  it("adds an object carrying overrides", () => {
    const id = usePrevizStore
      .getState()
      .addObject("prop", { assetUrl: "/static/x.glb", assetFormat: "glb" })!;

    const created = usePrevizStore.getState().scene.objects.find((object) => object.id === id);
    expect(created?.kind === "prop" && created.assetUrl).toBe("/static/x.glb");
    // 工厂本身仍要被用到：名字编号不该因为带了 overrides 就丢。
    expect(created?.name).toBe(createPrevizObject("prop", []).name);
  });

  // overrides 按 kind 收窄，写错 kind 的字段要在编译期就红——store 的 addObject 是
  // createPrevizObject 那次泛型收窄唯一的生产调用点，这里放宽等于那次收窄白做。
  // 这条断言由 `tsc -p tsconfig.app.json` 执行：错误不再出现时 tsc 会报
  // 「Unused '@ts-expect-error' directive」。
  it("rejects overrides belonging to another kind at compile time", () => {
    // @ts-expect-error assetUrl 是物件字段，写不到人物身上。
    const id = usePrevizStore.getState().addObject("character", { assetUrl: "/x.glb" });

    const created = usePrevizStore.getState().scene.objects.find((object) => object.id === id);
    // 类型挡不住的 JS 调用方也不该把它留在场景里。
    expect("assetUrl" in created!).toBe(false);
  });

  // 导入路径也会把脏数值带进 overrides，新建这一步同样要收敛。
  it("clamps overrides passed to a new object", () => {
    const id = usePrevizStore.getState().addObject("character", { heightCm: 9999 })!;

    const created = usePrevizStore.getState().scene.objects.find((object) => object.id === id);
    expect(created?.kind === "character" && created.heightCm).toBe(PREVIZ_MAX_HEIGHT_CM);
  });
});
