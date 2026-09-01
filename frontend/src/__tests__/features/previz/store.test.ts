// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { PREVIZ_OBJECT_LIMITS } from "@/features/previz/domain/limits";
import {
  PREVIZ_DEFAULT_HEIGHT_CM,
  PREVIZ_MAX_HEIGHT_CM,
  createPrevizObject,
} from "@/features/previz/domain/objects";
import {
  createDefaultScene,
  type PrevizPathClip,
  type PrevizScene,
} from "@/features/previz/domain/scene";
import {
  PREVIZ_HISTORY_LIMIT,
  PREVIZ_PLAYBACK_RATES,
  usePrevizStore,
} from "@/features/previz/store";

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

  // 未改动的对象要保持引用不变：一次属性编辑只重建被改的那一条，不把整份 objects
  // 翻新。（这不是给哪个消费者的前置条件——`PrevizSceneGraph.sync()` 是可以每帧调的
  // 全量重写，不做引用比较——而是「谁被改了」在 store 之外仍然看得出来。）
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
  //
  // 期望值写字面量而不是 `PREVIZ_OBJECT_BASE_NAME.light`：后者两边同源，改了那张表
  // 断言跟着一起动，永远不会红。实测过——把 `PREVIZ_OBJECT_BASE_NAME.prop` 从「物件」
  // 改成「道具」，整个 `__tests__/features/previz/` 目录零新增失败。这三处
  // （本条与下面新建编号那条）是那张表在测试里仅有的锚点。
  it("falls back to the kind base name when a rename blanks it out", () => {
    const id = usePrevizStore.getState().addObject("light")!;

    usePrevizStore.getState().updateObject(id, { name: "   " });

    expect(usePrevizStore.getState().scene.objects[0].name).toBe("灯光");
  });

  // 属性面板的 patch 是「有就带上」拼出来的，`{ name: maybeName }`（string | undefined）
  // 在 exactOptionalPropertyTypes 关着时照样过类型检查。原样合并的话 undefined 会盖掉
  // 已有的值，接着被 normalizeObject 「修」成字段默认值——一次这样的补丁就能把用户改过的
  // 名字抹回基名、把隐藏的对象重新显示出来、把锁定的解锁、把身高和变换清回默认。
  it("treats undefined patch fields as absent instead of resetting them", () => {
    const id = usePrevizStore.getState().addObject("character")!;
    usePrevizStore.getState().updateObject(id, {
      name: "阿离",
      visible: false,
      locked: true,
      heightCm: 200,
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });

    const maybeName: string | undefined = undefined;
    usePrevizStore.getState().updateObject(id, {
      name: maybeName,
      visible: undefined,
      locked: undefined,
      heightCm: undefined,
      transform: undefined,
    });

    const patched = usePrevizStore.getState().scene.objects[0];
    expect(patched.name).toBe("阿离");
    expect(patched.visible).toBe(false);
    expect(patched.locked).toBe(true);
    expect(patched.kind === "character" && patched.heightCm).toBe(200);
    expect(patched.transform.position).toEqual([1, 2, 3]);
  });

  // updateObject 是唯一一个改场景、却没有任何用例盯着它的历史行为的 CRUD 方法：把它
  // 改成直接 `set({ scene })`（很可能是为了「一次改名不该压满 50 步历史」而绕开
  // applyScene）能让整份用例全绿，用户看到的却是「改完属性 Ctrl+Z 撤不回来」。
  // 任务卡的「一律经过 applyScene」是条不变式，不变式要有红线。
  it("routes an object patch through the history too", () => {
    const id = usePrevizStore.getState().addObject("camera")!;
    const past = usePrevizStore.getState().past.length;

    usePrevizStore.getState().updateObject(id, { focalMm: 85 });
    expect(usePrevizStore.getState().past).toHaveLength(past + 1);

    usePrevizStore.getState().undo();

    const restored = usePrevizStore.getState().scene.objects[0];
    expect(restored.kind === "camera" && restored.focalMm).toBe(50);
  });

  it("ignores a patch for an unknown id", () => {
    const before = usePrevizStore.getState().scene;
    usePrevizStore.getState().updateObject("nope", { name: "x" });
    expect(usePrevizStore.getState().scene).toBe(before);
  });

  // `loadScene` / `applyScene` 的入参是调用方自建的 PrevizScene，不经 parseScene，
  // 所以空 id 这类脏值进得来：`.some()` 守卫放行、`parseObject` 却因空 id 返回 null。
  // 少了归一化那一步的兜底，`scene.objects` 就会变成 `[undefined]`，接着被
  // JSON.stringify 原样写进 node.data。宁可留一个没规范化的对象。
  it("never lets a patch put undefined into the objects array", () => {
    const scene = createDefaultScene();
    scene.objects = [{ ...createPrevizObject("prop", []), id: "" }];
    usePrevizStore.getState().loadScene(scene);

    usePrevizStore.getState().updateObject("", { name: "x" });

    const objects = usePrevizStore.getState().scene.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]).toBeDefined();
    expect(objects[0]?.id).toBe("");
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

  // 退出监看走的就是 `setActiveCamera(null)`，和 `selectObject(null)` 一样得先钉住
  // 「传 null 真的清空」。上面那条只覆盖「机位被删掉时顺带清」，下面那条只覆盖
  // 「整场重载时清」，都不经过这个 setter 的 null 入参。缺了这条，将来给
  // setActiveCamera 补一条「只收场景里真实存在的机位 id」守卫时会把 null 一起挡掉——
  // 表现是退出监看的按钮点了没反应、视口永远卡在机位视角，而用例全绿。
  it("switches monitoring off when the active camera is set to null", () => {
    const id = usePrevizStore.getState().addObject("camera")!;
    usePrevizStore.getState().setActiveCamera(id);
    expect(usePrevizStore.getState().activeCameraId).toBe(id);

    usePrevizStore.getState().setActiveCamera(null);

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

    // 先断言取消选中真的生效：`addObject` 已经把 id 选上了，直接选回来的话这条用例
    // 连「selectObject 是个空实现」都区分不出来。
    usePrevizStore.getState().selectObject(null);
    expect(usePrevizStore.getState().selectedObjectId).toBeNull();
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

  // 撤销一次「新建」之后，选中 id 仍指着一个已经不在场景里的对象。这是「undo 不碰
  // 会话态」的直接后果，而且是想要的：redo 把同一个 id 放回来时，选中态自己就接回去了
  // （下面半条断言就是在钉这个来回）。代价是消费者不能假设 `selectedObjectId` 一定能在
  // `scene.objects` 里找得到——属性面板那边写 `objects.find(…)!` 会在这一步拿到 undefined。
  // 把这条契约钉在这里，免得日后有人把它当 bug「修」成「undo 顺手清空选中」，那等于
  // 让撤销去动会话态，正是规范禁止的。
  it("leaves the selection pointing at an object undo has taken away", () => {
    const id = usePrevizStore.getState().addObject("character")!;

    usePrevizStore.getState().undo();

    const state = usePrevizStore.getState();
    expect(state.scene.objects).toHaveLength(0);
    expect(state.selectedObjectId).toBe(id);

    usePrevizStore.getState().redo();
    expect(usePrevizStore.getState().scene.objects[0]?.id).toBe(id);
    expect(usePrevizStore.getState().selectedObjectId).toBe(id);
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
    // 用真的机位 id，不用一个场景里不存在的字符串：后者等于把「setActiveCamera 接受
    // 任何 id」写成测试契约，将来真要加 kind 守卫就得回头改这条用例。
    usePrevizStore.getState().setActiveCamera(usePrevizStore.getState().addObject("camera")!);
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
    // 工厂本身仍要被用到，而且要拿到**当前场景的对象列表**：编号是照着已有同类对象算
    // 出来的，实现里把 `scene.objects` 换成 `[]` 的话第二个物件也会叫「物件 1」。
    // 拿 `createPrevizObject("prop", [])` 的名字来比就抓不到这条——两边同源，恒等成立。
    expect(created?.name).toBe("物件 1");

    const second = usePrevizStore
      .getState()
      .addObject("prop", { assetUrl: "/static/y.glb", assetFormat: "glb" })!;
    const next = usePrevizStore.getState().scene.objects.find((object) => object.id === second);
    expect(next?.name).toBe("物件 2");
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

  it("clamps the playhead into the scene duration", () => {
    usePrevizStore.getState().applyScene(sceneWithDuration(200));

    usePrevizStore.getState().setTimelineFrame(500);
    expect(usePrevizStore.getState().timelineFrame).toBe(200);

    usePrevizStore.getState().setTimelineFrame(-10);
    expect(usePrevizStore.getState().timelineFrame).toBe(0);

    // 帧号是整数：小数帧在刻度尺上落在两格之间，读数也会抖。
    usePrevizStore.getState().setTimelineFrame(12.6);
    expect(usePrevizStore.getState().timelineFrame).toBe(13);
  });

  it("keeps the playhead out of the undo stack", () => {
    usePrevizStore.getState().setTimelineFrame(30);
    // 播放头是会话态，和选中对象同一类：撤销一次删除该把对象撤回来，
    // 而不是顺带把播放头也拽走。
    expect(usePrevizStore.getState().past).toHaveLength(0);
    expect(usePrevizStore.getState().dirty).toBe(false);
  });

  it("pulls the playhead back when a shorter scene is loaded", () => {
    usePrevizStore.getState().setTimelineFrame(120);
    usePrevizStore.getState().loadScene(sceneWithDuration(60));
    // 换节点时留在旧位置的话，播放头会停在时间轴之外，拖回来才动得了。
    expect(usePrevizStore.getState().timelineFrame).toBe(0);
    expect(usePrevizStore.getState().timelinePlaying).toBe(false);
  });

  it("advances the playhead at the playback rate", () => {
    usePrevizStore.getState().applyScene(sceneWithDuration(120));
    usePrevizStore.getState().setTimelineRate(2);
    usePrevizStore.getState().setTimelinePlaying(true);

    usePrevizStore.getState().tickPlayback(1);

    // 30 fps × 1 秒 × 2 倍速 = 60 帧。
    expect(usePrevizStore.getState().timelineFrame).toBe(60);
  });

  it("stops at the last frame instead of looping", () => {
    usePrevizStore.getState().applyScene(sceneWithDuration(120));
    usePrevizStore.getState().setTimelinePlaying(true);

    usePrevizStore.getState().tickPlayback(10);

    // 实测参照实现：播放到末尾停住，不回零、不循环（循环默认关）。
    expect(usePrevizStore.getState().timelineFrame).toBe(120);
    expect(usePrevizStore.getState().timelinePlaying).toBe(false);
  });

  it("ignores playback ticks while stopped", () => {
    usePrevizStore.getState().tickPlayback(1);
    expect(usePrevizStore.getState().timelineFrame).toBe(0);
  });

  it("rewinds to zero on stop", () => {
    usePrevizStore.getState().setTimelineFrame(60);
    usePrevizStore.getState().stopPlayback();
    expect(usePrevizStore.getState().timelineFrame).toBe(0);
    expect(usePrevizStore.getState().timelinePlaying).toBe(false);
  });

  it("clamps the playback rate to the offered ones", () => {
    usePrevizStore.getState().setTimelineRate(99);
    // 下拉框只给这五档；99 倍速一帧就跑完整条时间轴。
    expect(PREVIZ_PLAYBACK_RATES).toEqual([0.25, 0.5, 1, 1.5, 2]);
    expect(usePrevizStore.getState().timelineRate).toBe(2);
  });

  it("clears the clip and point selection when the object selection changes", () => {
    usePrevizStore.getState().selectClip("clip-1");
    usePrevizStore.getState().selectPathPoint("point-1");

    usePrevizStore.getState().selectObject("other");

    // 选中的片段属于上一个对象；留着它，属性面板会显示一个跟当前选中对象无关的片段。
    expect(usePrevizStore.getState().selectedClipId).toBeNull();
    expect(usePrevizStore.getState().selectedPointId).toBeNull();
  });

  it("clears the point selection when another clip is selected", () => {
    usePrevizStore.getState().selectClip("clip-1");
    usePrevizStore.getState().selectPathPoint("point-1");

    usePrevizStore.getState().selectClip("clip-2");

    expect(usePrevizStore.getState().selectedPointId).toBeNull();
  });

  it("clamps the drawing spacing into its range", () => {
    usePrevizStore.getState().setPathSpacing(0);
    expect(usePrevizStore.getState().pathSpacingM).toBe(0.05);
    usePrevizStore.getState().setPathSpacing(99);
    expect(usePrevizStore.getState().pathSpacingM).toBe(5);
  });

  function addCharacter(): string {
    const id = usePrevizStore.getState().addObject("character");
    if (!id) throw new Error("expected the character to be created");
    return id;
  }

  it("creates a track and a full-length clip on the first stroke", () => {
    const id = addCharacter();

    usePrevizStore.getState().drawPath(id, [
      [0, 0, 0],
      [3, 0, 0],
    ]);

    const track = usePrevizStore.getState().scene.timeline.tracks[0];
    expect(track.objectId).toBe(id);
    const clip = track.clips[0] as PrevizPathClip;
    expect(clip.kind).toBe("path");
    // 实测参照实现：人物原本不在时间轴上，画完直接生成轨道 + 铺满时间轴的路径片段。
    expect([clip.startFrame, clip.endFrame]).toEqual([0, 120]);
    expect(clip.points.length).toBeGreaterThan(1);
  });

  it("redraws into the clip under the playhead instead of stacking a new one", () => {
    const id = addCharacter();
    usePrevizStore.getState().drawPath(id, [
      [0, 0, 0],
      [3, 0, 0],
    ]);
    const first = usePrevizStore.getState().scene.timeline.tracks[0].clips[0].id;

    usePrevizStore.getState().drawPath(id, [
      [0, 0, 0],
      [0, 0, 6],
    ]);

    const clips = usePrevizStore.getState().scene.timeline.tracks[0].clips;
    // 重画是改这条轨迹，不是叠一条新的——叠起来两条同时覆盖同一帧，谁生效全靠运气。
    expect(clips).toHaveLength(1);
    expect(clips[0].id).toBe(first);
    expect((clips[0] as PrevizPathClip).points[0].position).toEqual([0, 0, 0]);
  });

  it("selects the clip it just drew", () => {
    const id = addCharacter();
    usePrevizStore.getState().drawPath(id, [
      [0, 0, 0],
      [3, 0, 0],
    ]);
    expect(usePrevizStore.getState().selectedClipId).toBe(
      usePrevizStore.getState().scene.timeline.tracks[0].clips[0].id,
    );
  });

  it("ignores a stroke with nothing in it", () => {
    const id = addCharacter();
    const before = usePrevizStore.getState().past.length;

    usePrevizStore.getState().drawPath(id, []);

    // 空笔画建了片段就是往 undo 栈里塞一步什么都没干的操作。
    expect(usePrevizStore.getState().scene.timeline.tracks).toHaveLength(0);
    expect(usePrevizStore.getState().past).toHaveLength(before);
  });

  it("puts every timeline edit on the undo stack", () => {
    const id = addCharacter();
    usePrevizStore.getState().drawPath(id, [
      [0, 0, 0],
      [3, 0, 0],
    ]);

    usePrevizStore.getState().undo();

    // 画一条轨迹是一次场景改动，撤销该把它整条撤掉。
    expect(usePrevizStore.getState().scene.timeline.tracks).toHaveLength(0);
  });

  it("adds an empty clip for an object that has no track yet", () => {
    const id = addCharacter();

    usePrevizStore.getState().addObjectToTimeline(id);

    const clip = usePrevizStore.getState().scene.timeline.tracks[0].clips[0] as PrevizPathClip;
    expect(clip.points).toHaveLength(0);
    expect([clip.startFrame, clip.endFrame]).toEqual([0, 120]);
  });

  it("splits the selected clip at the playhead", () => {
    const id = addCharacter();
    usePrevizStore.getState().drawPath(id, [
      [0, 0, 0],
      [3, 0, 0],
    ]);
    const clipId = usePrevizStore.getState().scene.timeline.tracks[0].clips[0].id;
    usePrevizStore.getState().setTimelineFrame(60);

    usePrevizStore.getState().splitClipAtPlayhead(clipId);

    const clips = usePrevizStore.getState().scene.timeline.tracks[0].clips;
    expect(clips.map((clip) => [clip.startFrame, clip.endFrame])).toEqual([
      [0, 60],
      [60, 120],
    ]);
    // 被切的那条已经不存在了，选中态得跟着放开。
    expect(usePrevizStore.getState().selectedClipId).toBeNull();
  });

  it("inserts a keyframe at the playhead", () => {
    const id = addCharacter();
    usePrevizStore.getState().drawPath(id, [
      [0, 0, 0],
      [3, 0, 0],
    ]);
    const clipId = usePrevizStore.getState().scene.timeline.tracks[0].clips[0].id;
    const before = (usePrevizStore.getState().scene.timeline.tracks[0].clips[0] as PrevizPathClip)
      .points.length;
    usePrevizStore.getState().setTimelineFrame(37);

    usePrevizStore.getState().insertKeyframe(clipId);

    const points = (usePrevizStore.getState().scene.timeline.tracks[0].clips[0] as PrevizPathClip)
      .points;
    expect(points.length).toBe(before + 1);
  });

  it("marks a rotated keyframe as edited", () => {
    const id = addCharacter();
    usePrevizStore.getState().drawPath(id, [
      [0, 0, 0],
      [3, 0, 0],
    ]);
    const clip = usePrevizStore.getState().scene.timeline.tracks[0].clips[0] as PrevizPathClip;

    usePrevizStore.getState().updateKeyframe(clip.id, clip.points[0].id, { rotation: [0, 45, 0] });

    const points = (usePrevizStore.getState().scene.timeline.tracks[0].clips[0] as PrevizPathClip)
      .points;
    expect(points[0].rotationEdited).toBe(true);
  });

  it("drops the track when the object is removed from the timeline", () => {
    const id = addCharacter();
    usePrevizStore.getState().drawPath(id, [
      [0, 0, 0],
      [3, 0, 0],
    ]);

    usePrevizStore.getState().removeTrackFor(id);

    expect(usePrevizStore.getState().scene.timeline.tracks).toHaveLength(0);
    // 对象本身还在——删轨道不是删人。
    expect(usePrevizStore.getState().scene.objects).toHaveLength(1);
  });
});
