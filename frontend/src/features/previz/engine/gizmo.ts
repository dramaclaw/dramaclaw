// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { RAD_TO_DEG } from '../domain/camera';
import type { PrevizTransform } from '../domain/scene';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * `TransformControls` 里本模块用到的那部分。写成结构类型而不是直接引 three 的
 * 类型，是为了 jsdom 里能塞一个假的进来——真控件要 DOM 事件和 WebGL 上下文。
 */
export interface TransformControlsLike {
  enabled: boolean;
  object: unknown;
  attach(object: THREE.Object3D): unknown;
  detach(): unknown;
  setMode(mode: GizmoMode): void;
  setSpace(space: 'world' | 'local'): void;
  dispose(): void;
  /** three 0.185 起 TransformControls 继承 Controls，可见的手柄要从这里拿。 */
  getHelper(): THREE.Object3D;
  addEventListener(type: string, handler: (event: { value?: boolean }) => void): void;
}

export interface PrevizGizmoDeps {
  controls: TransformControlsLike;
  /** OrbitControls 本体（只用到 enabled）。拖手柄期间必须把它关掉。 */
  orbit: { enabled: boolean };
  /** 手柄 helper 挂到哪个节点下，通常就是 three 的 Scene。 */
  root: THREE.Object3D;
  /** 拖拽结束时回调，把最终变换写回 store。 */
  onCommit: (objectId: string, transform: PrevizTransform) => void;
  /** 每次 objectChange 都调，用来请求重绘。 */
  onChange: () => void;
}

/**
 * 视口里的变换手柄。三件事：让手柄看得见、拖拽期间别和轨道相机打架、拖完把变换写回 store。
 *
 * 提交时机是**拖拽结束**而不是每帧：`objectChange` 一次拖拽能来几百次，每次都进 undo 栈
 * 的话一次撤销只退回一个像素，撤销功能等于废掉。
 */
export class PrevizGizmo {
  private attachedId: string | null = null;
  private movedDuringDrag = false;
  /**
   * 手柄该不该看得见，互不相干的理由各记一份，画的时候取与（见 [applyVisibility]）。
   *
   * 合成一个裸开关就会出这个 bug：工具切到「选择」（不该有手柄）时用户按下截图，
   * 截图前后是 `setHelperVisible(false)` / `setHelperVisible(true)` 一对，收尾那句会
   * 把本来就不该在的手柄放回来。渲染器里这样的成对调用有 10 处（截图、机位预览、
   * 四视图、录制…），任何一处都够把它放出来，而这条路径没人会手测。
   */
  private modeVisible = true;
  private captureVisible = true;
  /**
   * 手柄正在被拖。切换要压到松手才生效，见 [setMode]。
   */
  private dragging = false;
  /**
   * 待生效的切换。`undefined` = 没有待生效的；`null` 本身是合法待生效值（「这颗工具
   * 不要手柄」），所以不能拿 null 当哨兵。
   */
  private pendingMode: GizmoMode | null | undefined = undefined;

  constructor(private readonly deps: PrevizGizmoDeps) {
    // 手柄本体不是 Object3D：加错了不会报错，只是永远看不见。
    deps.root.add(deps.controls.getHelper());
    deps.controls.setSpace('world');

    deps.controls.addEventListener('dragging-changed', (event) => {
      // 不关掉轨道控制的话，一次拖拽会同时转相机和移物体。
      deps.orbit.enabled = event.value !== true;
      if (event.value === true) {
        this.dragging = true;
        // 开始时清标记，而不是提交后清：留着上一次的 true，下一次「点一下不拖」
        // 也会提交一步什么都没改的历史。
        this.movedDuringDrag = false;
        return;
      }
      // 提交那段原先是三个条件、两条 early return。改成嵌套的 if 再套一层 finally，为的是
      // 让收尾那几句一定跑得到：
      //   * 「点一下不拖」（!movedDuringDrag）是用户每天做几十次的事，早退的话
      //     dragging 永远停在 true，之后所有的工具切换都被当成「还在拖」挂起，手柄再也换不动；
      //   * onCommit 抛出（store 校验不过、对象刚被别处删掉）走的是 return 挡不住的那条路，
      //     所以光靠嵌套 if 不够，得用 finally。用户看到的只是「按 W 没反应」，
      //     根本联想不到几步之前那次拖拽。
      try {
        if (this.movedDuringDrag && this.attachedId) {
          // 拖到一半对象被删了（撤销、另一个窗口）时 object 会是 null。照着它读变换会抛，
          // 而这条处理链一断，上面那句 `orbit.enabled = true` 之后的收尾全没了。
          const node = deps.controls.object as THREE.Object3D | null;
          if (node) deps.onCommit(this.attachedId, readTransform(node));
        }
      } finally {
        this.dragging = false;
        // 先清再放：applyMode 里万一又抛，挂起的这一次也不会留到下一次拖拽结束再放一遍。
        const pending = this.pendingMode;
        this.pendingMode = undefined;
        if (pending !== undefined) this.applyMode(pending);
      }
    });

    deps.controls.addEventListener('objectChange', () => {
      this.movedDuringDrag = true;
      deps.onChange();
    });
  }

  /**
   * 挂到某个对象节点上。传 null 或锁定对象都等于摘掉手柄。
   *
   * 两条分支末尾都要重算一次可见性：three 的 `attach()` 内部会写死 `_root.visible = true`
   * （`detach()` 写死 false），它并不知道当前工具要不要手柄、也不知道正在截图。少了这一句，
   * 「W 工具下点另一个物体」和「录制途中换选中项」都会把本不该在的手柄放回画面——前者是
   * 个接不到指针事件的鬼影，后者直接烤进成片。
   */
  attach(node: THREE.Object3D | null): void {
    const objectId = node?.userData?.previzObjectId;
    if (!node || node.userData?.previzLocked === true || typeof objectId !== 'string') {
      this.attachedId = null;
      this.deps.controls.detach();
      this.applyVisibility();
      return;
    }
    this.attachedId = objectId;
    this.deps.controls.attach(node);
    this.applyVisibility();
  }

  /**
   * 换手柄模式；`null` 表示当前工具（选择/导航/绘制/标记）压根不要手柄。
   *
   * 拖拽中的切换必须压到松手：three 的 `TransformControls` 每个指针处理器都以
   * `if ( this.enabled === false ) return;` 开头，拖到一半把 enabled 置 false，它内部的
   * `dragging` 会永远停在 true，`dragging-changed` 的收尾再也不来，上面那句
   * `orbit.enabled = true` 就永远不跑——轨道相机就此死掉，用户只能重开编辑器。
   */
  setMode(mode: GizmoMode | null): void {
    if (this.dragging) {
      this.pendingMode = mode;
      return;
    }
    this.applyMode(mode);
  }

  /** 截图前把手柄藏掉——箭头进了截图就毁了整张参考图。 */
  setHelperVisible(visible: boolean): void {
    this.captureVisible = visible;
    this.applyVisibility();
  }

  private applyMode(mode: GizmoMode | null): void {
    this.modeVisible = mode !== null;
    // 只藏 helper 是不够的：控件还在接指针事件，用户会在一片看不见任何东西的画面里
    // 莫名其妙地把选中的物体拖走，而且完全找不到是什么把它拖动的。
    this.deps.controls.enabled = mode !== null;
    if (mode) this.deps.controls.setMode(mode);
    this.applyVisibility();
  }

  /**
   * 三个理由取与，是可见性唯一的落笔处。
   *
   * `attachedId` 也要参与：没挂上对象时手柄拖不动任何东西，让它亮着只是在画面正中留一副
   * 谁也用不了的箭头。three 自己是靠 attach/detach 管这半件事的，我们既然接管了另外两个
   * 理由，就得把这一个也算进来——否则 `setMode` 会替一个空控件开灯。
   */
  private applyVisibility(): void {
    this.deps.controls.getHelper().visible =
      this.attachedId !== null && this.modeVisible && this.captureVisible;
  }

  dispose(): void {
    this.deps.controls.detach();
    this.deps.root.remove(this.deps.controls.getHelper());
    this.deps.controls.dispose();
  }
}

/** three 的 Euler 是弧度，场景里存的是度。 */
function readTransform(node: THREE.Object3D): PrevizTransform {
  return {
    position: [node.position.x, node.position.y, node.position.z],
    rotation: [
      node.rotation.x * RAD_TO_DEG,
      node.rotation.y * RAD_TO_DEG,
      node.rotation.z * RAD_TO_DEG,
    ],
    scale: [node.scale.x, node.scale.y, node.scale.z],
  };
}
