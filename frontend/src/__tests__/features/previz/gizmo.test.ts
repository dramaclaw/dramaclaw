// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import { PrevizGizmo, type TransformControlsLike } from "@/features/previz/engine/gizmo";

class FakeTransformControls implements TransformControlsLike {
  enabled = true;
  object: unknown = null;
  /**
   * 正在被拖的那根手柄的名字。真身在 `pointerUp` 里是先 `this.dragging = false`
   * （这一句才是 `dragging-changed` 的来源），**下一句**才 `this.axis = null`
   * （three 0.185 `TransformControls.js:784-785`）。所以收尾事件跑的时候 axis 还在，
   * 替身也就在 emit 之后才清——两边顺序一致，落地那段读得到的东西才是同一个。
   */
  axis: string | null = null;
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

function setup(deps: { dropToSurface?: (objectId: string) => number | null } = {}) {
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
    ...deps,
  });
  return { controls, gizmo, added, removed, orbit, onCommit, onChange };
}

/**
 * 拖着某根手柄走一趟完整的拖拽再松手。`axis` 在松手事件**之后**才清，照的是真身
 * `pointerUp` 里那两句的顺序。
 */
function dragWith(controls: FakeTransformControls, axis: string) {
  controls.axis = axis;
  controls.emit("dragging-changed", { value: true });
  controls.emit("objectChange");
  controls.emit("dragging-changed", { value: false });
  controls.axis = null;
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

describe("PrevizGizmo 松手落地", () => {
  // 自由移动那颗手柄拖完就该落地，而且提交回 store 的必须是**落地后**的 y。
  // 顺序反过来（先读变换再落地）的话，提交上去的是半空中那个位置，下一帧引擎又把它
  // 写回节点——用户看到的是物体落下去、又弹回原处，而且撤销一步都退不回来。
  it("drops the object before it commits, so the committed y is the landed one", () => {
    const dropToSurface = vi.fn(() => 7);
    const { controls, gizmo, onCommit } = setup({ dropToSurface });
    const node = fakeNode("a");
    gizmo.attach(node);
    gizmo.setMode("translate");

    dragWith(controls, "XYZ");

    expect(dropToSurface).toHaveBeenCalledWith("a");
    expect((node as unknown as { position: { y: number } }).position.y).toBe(7);
    expect(onCommit).toHaveBeenCalledWith("a", {
      position: [1, 7, 3],
      rotation: [0, 90, 0],
      scale: [2, 2, 2],
    });
  });

  // 水平面那颗（XZ）同样是「只在平地上挪」，落地不会跟用户抢任何他自己调过的量。
  it("also drops after a drag on the horizontal plane handle", () => {
    const dropToSurface = vi.fn(() => 4);
    const { controls, gizmo } = setup({ dropToSurface });
    const node = fakeNode("a");
    gizmo.attach(node);
    gizmo.setMode("translate");

    dragWith(controls, "XZ");

    expect(dropToSurface).toHaveBeenCalledWith("a");
    expect((node as unknown as { position: { y: number } }).position.y).toBe(4);
  });

  // 整套吸附规则的核心：拖 Y 轴、拖 XY / YZ 这两个竖直面，用户都是**刻意**在调高度，
  // 吸附会当场把他刚调好的高度抹掉，这几根手柄等于失灵。单轴的 X / Z 同理——他要的
  // 就是「只动这一根」。
  it("never drops after a drag the user constrained to a single axis or a vertical plane", () => {
    for (const axis of ["Y", "XY", "YZ", "X", "Z"]) {
      const dropToSurface = vi.fn(() => 7);
      const { controls, gizmo, onCommit } = setup({ dropToSurface });
      const node = fakeNode("a");
      gizmo.attach(node);
      gizmo.setMode("translate");

      dragWith(controls, axis);

      expect(dropToSurface, `axis ${axis}`).not.toHaveBeenCalled();
      expect((node as unknown as { position: { y: number } }).position.y, `axis ${axis}`).toBe(2);
      expect(onCommit).toHaveBeenCalledWith("a", {
        position: [1, 2, 3],
        rotation: [0, 90, 0],
        scale: [2, 2, 2],
      });
    }
  });

  // 旋转 / 缩放模式下手柄中心那颗也叫 XYZ（three 三套手柄共用这批名字），只看 axis
  // 的话原地转一个物体就会把它吸到地上——转的时候谁都没打算挪它。
  it("does not drop when the gizmo is rotating rather than translating", () => {
    const dropToSurface = vi.fn(() => 7);
    const { controls, gizmo } = setup({ dropToSurface });
    const node = fakeNode("a");
    gizmo.attach(node);
    gizmo.setMode("rotate");

    dragWith(controls, "XYZ");

    expect(dropToSurface).not.toHaveBeenCalled();
    expect((node as unknown as { position: { y: number } }).position.y).toBe(2);
  });

  // 没设过模式就拖：three 的 TransformControls 默认就是 translate（`mode` 的
  // defineProperty 默认值），我们这份影子状态要跟它对齐，否则「打开编辑器第一下拖拽」
  // 这一段两边说法不一致——手柄真的在平移，我们却以为不知道它在干什么。
  it("treats the gizmo as translating before any mode has been set", () => {
    const dropToSurface = vi.fn(() => 7);
    const { controls, gizmo } = setup({ dropToSurface });
    gizmo.attach(fakeNode("a"));

    dragWith(controls, "XYZ");

    expect(dropToSurface).toHaveBeenCalledWith("a");
  });

  // 拖到一半按 R 换工具。那次切换是**挂起**的：`setMode` 见 dragging 为真只记下
  // pendingMode，到 finally 里、落地跑完之后才 `applyMode`。所以手上这一次仍旧是平移，
  // 该落地。把 mode 记在 `setMode` 而不是 `applyMode` 里的话，松手时它已经是 'rotate'，
  // 这一拖静默地不落地了——而用户按 R 的本意是给**下一次**操作换工具，不是撤销手上这次。
  it("still drops when the user switches tools midway through the drag", () => {
    const dropToSurface = vi.fn(() => 7);
    const { controls, gizmo } = setup({ dropToSurface });
    const node = fakeNode("a");
    gizmo.attach(node);
    gizmo.setMode("translate");

    // 这里不能用 dragWith：整条序列的中间要塞一次切换。
    controls.axis = "XYZ";
    controls.emit("dragging-changed", { value: true });
    gizmo.setMode("rotate");
    controls.emit("objectChange");
    controls.emit("dragging-changed", { value: false });
    controls.axis = null;

    expect(dropToSurface).toHaveBeenCalledWith("a");
    expect((node as unknown as { position: { y: number } }).position.y).toBe(7);
    // 挂起的那次切换照常在落地之后放出去，下一次拖拽才是旋转。
    expect(controls.setMode).toHaveBeenLastCalledWith("rotate");
  });

  // 返回 null 是「这次不该落地」（机位、灯、还没有几何体的模型），不是「落到 0」。
  // 当成 0 用的话，一个正在加载的模型松手就被拍到地面上。
  it("commits the untouched y when the drop declines", () => {
    const dropToSurface = vi.fn(() => null);
    const { controls, gizmo, onCommit } = setup({ dropToSurface });
    const node = fakeNode("a");
    gizmo.attach(node);
    gizmo.setMode("translate");

    dragWith(controls, "XYZ");

    expect((node as unknown as { position: { y: number } }).position.y).toBe(2);
    expect(onCommit).toHaveBeenCalledWith("a", {
      position: [1, 2, 3],
      rotation: [0, 90, 0],
      scale: [2, 2, 2],
    });
  });

  // 依赖是可选的：渲染器之外还有别的调用点（以及这个文件里另外 22 条用例）根本不给它。
  // 不给就该完全是改动之前那套行为，而不是在收尾里抛一句 undefined is not a function。
  it("behaves exactly as before when no dropToSurface dependency is wired", () => {
    const { controls, gizmo, onCommit } = setup();
    const node = fakeNode("a");
    gizmo.attach(node);
    gizmo.setMode("translate");

    dragWith(controls, "XYZ");

    expect((node as unknown as { position: { y: number } }).position.y).toBe(2);
    expect(onCommit).toHaveBeenCalledWith("a", {
      position: [1, 2, 3],
      rotation: [0, 90, 0],
      scale: [2, 2, 2],
    });
  });
});
