// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import { PrevizGizmo, type TransformControlsLike } from "@/features/previz/engine/gizmo";

class FakeTransformControls implements TransformControlsLike {
  enabled = true;
  object: unknown = null;
  private readonly listeners: Record<string, Array<(event: { value?: boolean }) => void>> = {};
  /**
   * 初始不可见，attach 打开、detach 关掉——照抄 three 0.185：`TransformControlsRoot`
   * 构造里就是 `this.visible = false`，`attach()` 里 `_root.visible = true`，`detach()` 里
   * 置回 false。替身要是在被测的这个属性上偏离真身，「换一次选中项会不会把本不该有的
   * 手柄放出来」这条路在 jsdom 里就永远看不见——恰好是最需要它设防的地方。
   */
  readonly helper = { name: "gizmo-helper", visible: false };

  attach = vi.fn((object: unknown) => {
    this.object = object;
    this.helper.visible = true;
    return this;
  });
  detach = vi.fn(() => {
    this.object = null;
    this.helper.visible = false;
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
    // 没挂上对象的话手柄本来就不该在，下面那对开关全程都是 false，用例会退化成同义反复。
    gizmo.attach(fakeNode("a"));

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

  // W / Q / 绘制 / 标记这四颗工具下视口里不该有手柄。光把 helper 藏起来是不够的：
  // 控件还在接指针事件，用户会在一片看不见任何东西的画面里莫名其妙地把物体拖走。
  it("hides the helper and stops taking pointer events when the mode goes null", () => {
    const { controls, gizmo } = setup();
    gizmo.attach(fakeNode("a"));

    gizmo.setMode(null);

    expect(controls.helper.visible).toBe(false);
    expect(controls.enabled).toBe(false);
  });

  // 「当前工具不要手柄」和「截图/录制期间不要手柄」是两个互不相干的理由。共用一个
  // 裸开关的话，截图收尾那句 setHelperVisible(true) 会把 W 工具下本来就不该有的手柄
  // 放回来——渲染器里这样的成对调用有 10 处，任何一处都够把它放出来。
  it("keeps the helper hidden when a capture ends while the mode is null", () => {
    const { controls, gizmo } = setup();
    gizmo.attach(fakeNode("a"));

    gizmo.setMode(null);
    gizmo.setHelperVisible(false);
    gizmo.setHelperVisible(true);

    expect(controls.helper.visible).toBe(false);
    expect(controls.enabled).toBe(false);
  });

  // 反过来也得成立：真在用手柄的时候截一张图，收尾必须把它还回来，否则用户截完图
  // 手柄就没了，只能切一次工具才能拖回来。
  it("brings the helper back after a capture taken under a transform mode", () => {
    const { controls, gizmo } = setup();
    gizmo.attach(fakeNode("a"));

    gizmo.setMode("rotate");
    gizmo.setHelperVisible(false);
    expect(controls.helper.visible).toBe(false);

    gizmo.setHelperVisible(true);
    expect(controls.helper.visible).toBe(true);
  });

  // three 的 TransformControls 每个指针处理器都以 `if (this.enabled === false) return;`
  // 开头。拖到一半把 enabled 置 false，它内部的 dragging 会永远停在 true，我们
  // dragging-changed 收尾里那句 orbit.enabled = true 也就永远不跑——轨道相机就此死掉，
  // 用户只能重开编辑器。所以拖拽中的切换必须一直压到松手。
  it("defers a mode switch made mid-drag until the pointer is released", () => {
    const { controls, gizmo, orbit } = setup();
    gizmo.attach(fakeNode("a"));

    controls.emit("dragging-changed", { value: true });
    gizmo.setMode(null);

    expect(controls.enabled).toBe(true);
    expect(controls.helper.visible).toBe(true);

    controls.emit("objectChange");
    controls.emit("dragging-changed", { value: false });

    expect(controls.enabled).toBe(false);
    expect(controls.helper.visible).toBe(false);
    expect(orbit.enabled).toBe(true);
  });

  // 拖拽中连按两次快捷键：生效的该是最后那一次，而不是第一次（先来的把后来的挡掉）
  // 也不是两次都放。
  it("applies only the last mode asked for during a drag", () => {
    const { controls, gizmo } = setup();
    // 末尾要断言手柄回到可见，没挂上对象的话它本来就不该在，那一条就成了同义反复。
    gizmo.attach(fakeNode("a"));

    controls.emit("dragging-changed", { value: true });
    gizmo.setMode(null);
    gizmo.setMode("scale");
    controls.emit("dragging-changed", { value: false });

    expect(controls.setMode).toHaveBeenLastCalledWith("scale");
    expect(controls.enabled).toBe(true);
    expect(controls.helper.visible).toBe(true);
  });

  // 「点一下不拖」走的是收尾里 `movedDuringDrag` 不成立的那条分支。dragging 不在
  // 那条路径上解开的话，之后所有的工具切换都会被当成「还在拖」永远挂起——而点一下
  // 手柄不拖是用户每天都会做几十次的事。
  it("still switches modes after a click that dragged nothing", () => {
    const { controls, gizmo } = setup();
    gizmo.attach(fakeNode("a"));

    controls.emit("dragging-changed", { value: true });
    controls.emit("dragging-changed", { value: false });

    gizmo.setMode(null);

    expect(controls.enabled).toBe(false);
    expect(controls.helper.visible).toBe(false);
  });

  // 收尾里的第二条判断（内层的 `if (node)`）：拖到一半对象被删了（撤销、另一个窗口），
  // controls.object 是 null。
  it("still switches modes after the attached object vanished mid-drag", () => {
    const { controls, gizmo } = setup();
    gizmo.attach(fakeNode("a"));

    controls.emit("dragging-changed", { value: true });
    controls.emit("objectChange");
    controls.object = null;
    controls.emit("dragging-changed", { value: false });

    gizmo.setMode(null);

    expect(controls.enabled).toBe(false);
    expect(controls.helper.visible).toBe(false);
  });

  // 换一次选中项就把手柄放回来了：three 的 `attach()` 内部会写 `_root.visible = true`，
  // 而可见性只在 setMode / setHelperVisible 里算的话，W 工具下点另一个物体手柄就凭空
  // 冒出来——它还接不到指针事件（enabled 是 false），是个拖不动也关不掉的鬼影。
  it("keeps the helper hidden when the selection changes while the mode is null", () => {
    const { controls, gizmo } = setup();

    gizmo.setMode(null);
    gizmo.attach(fakeNode("a"));

    expect(controls.helper.visible).toBe(false);
  });

  // 截图/录制途中换选中项是同一个洞：那条路上手柄本来藏着，attach 一句就把它放回画面，
  // 直接烤进成片。录制期间画面是每帧重绘的，选中项一变就中招。
  it("keeps the helper hidden when the selection changes during a capture", () => {
    const { controls, gizmo } = setup();

    gizmo.setMode("translate");
    gizmo.attach(fakeNode("a"));
    gizmo.setHelperVisible(false);
    gizmo.attach(fakeNode("b"));

    expect(controls.helper.visible).toBe(false);
  });

  // 反过来这一半也得成立：什么都没选中的时候手柄不该在。three 那边 attach 之前 root 就是
  // 隐藏的，而只看模式的话 setMode 会替它开灯——画面正中多出一副没挂在任何东西上的手柄。
  it("keeps the helper down until something is actually selected", () => {
    const { controls, gizmo } = setup();

    gizmo.setMode("translate");
    expect(controls.helper.visible).toBe(false);

    gizmo.attach(fakeNode("a"));
    expect(controls.helper.visible).toBe(true);

    gizmo.attach(null);
    expect(controls.helper.visible).toBe(false);
  });

  // 挂起的切换生效之后要清掉。留在那儿的话下一次拖拽结束会把它再放一遍：用户明明已经
  // 换过工具，拖完一下手柄自己跳回上一次挂起的那种模式，工具栏上亮的却还是新的那颗。
  it("forgets a pending mode once it has been applied", () => {
    const { controls, gizmo } = setup();
    gizmo.attach(fakeNode("a"));

    controls.emit("dragging-changed", { value: true });
    gizmo.setMode("scale");
    controls.emit("dragging-changed", { value: false });
    expect(controls.setMode).toHaveBeenLastCalledWith("scale");

    // 这一次的切换是在没拖拽的时候发的，走的是立即生效那条路；紧接着来一次普通拖拽，
    // 收尾不该再冒出一次谁都没要的 scale。
    gizmo.setMode("translate");
    controls.emit("dragging-changed", { value: true });
    controls.emit("objectChange");
    controls.emit("dragging-changed", { value: false });

    expect(controls.setMode).toHaveBeenLastCalledWith("translate");
  });

  // 提交回调抛了（store 里的校验、或者另一个窗口刚把对象删掉）也得把 dragging 解开。
  // 不解开的话之后每一次工具切换都被当成「还在拖」永远挂起，手柄再也换不动，而用户
  // 看到的只是「按 W 没反应」，根本联想不到几步之前那次拖拽。
  it("keeps switching modes even when the commit throws", () => {
    const { controls, gizmo, onCommit } = setup();
    onCommit.mockImplementation(() => {
      throw new Error("store rejected the transform");
    });
    gizmo.attach(fakeNode("a"));

    controls.emit("dragging-changed", { value: true });
    controls.emit("objectChange");
    expect(() => controls.emit("dragging-changed", { value: false })).toThrow();

    gizmo.setMode(null);

    expect(controls.enabled).toBe(false);
    expect(controls.helper.visible).toBe(false);
  });
});
