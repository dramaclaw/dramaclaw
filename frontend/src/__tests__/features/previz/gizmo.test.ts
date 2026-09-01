// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import { PrevizGizmo, type TransformControlsLike } from "@/features/previz/engine/gizmo";

class FakeTransformControls implements TransformControlsLike {
  enabled = true;
  object: unknown = null;
  private readonly listeners: Record<string, Array<(event: { value?: boolean }) => void>> = {};
  readonly helper = { name: "gizmo-helper", visible: true };

  attach = vi.fn((object: unknown) => {
    this.object = object;
    return this;
  });
  detach = vi.fn(() => {
    this.object = null;
    return this;
  });
  setMode = vi.fn();
  setSpace = vi.fn();
  dispose = vi.fn();
  getHelper = vi.fn(() => this.helper as never);
  addEventListener(type: string, handler: (event: { value?: boolean }) => void) {
    (this.listeners[type] ??= []).push(handler);
  }
  emit(type: string, event: { value?: boolean } = {}) {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
}

function fakeNode(id: string) {
  return {
    userData: { previzObjectId: id },
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: Math.PI / 2, z: 0 },
    scale: { x: 2, y: 2, z: 2 },
  } as never;
}

function setup() {
  const controls = new FakeTransformControls();
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const orbit = { enabled: true };
  const onCommit = vi.fn();
  const onChange = vi.fn();
  const gizmo = new PrevizGizmo({
    controls,
    orbit,
    root: {
      add: (object: unknown) => added.push(object),
      remove: (object: unknown) => removed.push(object),
    } as never,
    onCommit,
    onChange,
  });
  return { controls, gizmo, added, removed, orbit, onCommit, onChange };
}

describe("PrevizGizmo", () => {
  // three 0.185 的 TransformControls 继承 Controls，不是 Object3D：直接 add 进场景
  // 什么都不会显示，而且不报错——只有加 getHelper() 的返回值才有手柄。
  it("adds the helper object, not the controls themselves", () => {
    const { controls, added } = setup();

    expect(controls.getHelper).toHaveBeenCalled();
    expect(added).toEqual([controls.helper]);
  });

  it("attaches to the selected node and detaches on null", () => {
    const { controls, gizmo } = setup();

    gizmo.attach(fakeNode("a"));
    expect(controls.attach).toHaveBeenCalled();

    gizmo.attach(null);
    expect(controls.detach).toHaveBeenCalled();
  });

  it("refuses to attach to a locked object", () => {
    const { controls, gizmo } = setup();
    const node = { userData: { previzObjectId: "a", previzLocked: true } } as never;

    gizmo.attach(node);

    expect(controls.attach).not.toHaveBeenCalled();
    expect(controls.detach).toHaveBeenCalled();
  });

  it("disables orbit while dragging and restores it afterwards", () => {
    const { controls, orbit } = setup();

    controls.emit("dragging-changed", { value: true });
    expect(orbit.enabled).toBe(false);

    controls.emit("dragging-changed", { value: false });
    expect(orbit.enabled).toBe(true);
  });

  it("repaints on every objectChange but commits only when the drag ends", () => {
    const { controls, gizmo, onCommit, onChange } = setup();
    gizmo.attach(fakeNode("a"));

    controls.emit("dragging-changed", { value: true });
    controls.emit("objectChange");
    controls.emit("objectChange");

    // 每帧提交会往 undo 栈里塞几百步，一次撤销只退回一个像素。
    expect(onCommit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(2);

    controls.emit("dragging-changed", { value: false });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("a", {
      position: [1, 2, 3],
      rotation: [0, 90, 0],
      scale: [2, 2, 2],
    });
  });

  it("does not commit when the drag moved nothing", () => {
    const { controls, gizmo, onCommit } = setup();
    gizmo.attach(fakeNode("a"));

    // 只点了一下手柄没拖动：没有 objectChange，就不该产生一步历史。
    controls.emit("dragging-changed", { value: true });
    controls.emit("dragging-changed", { value: false });

    expect(onCommit).not.toHaveBeenCalled();
  });

  // 上一次拖拽把 movedDuringDrag 留在 true 的话，下一次「点一下不拖」也会提交一步空历史。
  // 标记必须在每次拖拽开始时清掉，而不是只在提交后清。
  it("does not carry the moved flag into the next drag", () => {
    const { controls, gizmo, onCommit } = setup();
    gizmo.attach(fakeNode("a"));

    controls.emit("dragging-changed", { value: true });
    controls.emit("objectChange");
    controls.emit("dragging-changed", { value: false });
    expect(onCommit).toHaveBeenCalledTimes(1);

    controls.emit("dragging-changed", { value: true });
    controls.emit("dragging-changed", { value: false });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  // 拖到一半对象被删了（另一个窗口、或者撤销）：控件的 object 已经是 null，
  // 照着它读变换会在 `node.position` 上抛 TypeError，整个拖拽结束的处理链断掉，
  // 连 orbit.enabled 都恢复不了——相机从此转不动。
  it("restores orbit even when the attached object vanished mid-drag", () => {
    const { controls, gizmo, onCommit, orbit } = setup();
    gizmo.attach(fakeNode("a"));

    controls.emit("dragging-changed", { value: true });
    controls.emit("objectChange");
    controls.object = null;
    controls.emit("dragging-changed", { value: false });

    expect(onCommit).not.toHaveBeenCalled();
    expect(orbit.enabled).toBe(true);
  });

  // 手柄的箭头进了截图就毁了整张参考图。
  it("can hide its helper for a capture", () => {
    const { gizmo, controls } = setup();

    // 断言读 controls.helper 而不是 getHelper() 的返回值：假控件把它声明成 never
    // 好塞进 THREE.Object3D 的位置，取属性过不了 tsc。两者本来就是同一个对象。
    gizmo.setHelperVisible(false);
    expect(controls.helper.visible).toBe(false);

    gizmo.setHelperVisible(true);
    expect(controls.helper.visible).toBe(true);
  });

  it("forwards the mode and cleans up on dispose", () => {
    const { controls, gizmo, removed } = setup();

    gizmo.setMode("rotate");
    expect(controls.setMode).toHaveBeenCalledWith("rotate");

    gizmo.dispose();
    expect(controls.dispose).toHaveBeenCalled();
    // helper 留在场景里的话，渲染器 dispose 之后手柄还挂在那棵树上。
    expect(removed).toEqual([controls.helper]);
  });
});
