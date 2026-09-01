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

  constructor(private readonly deps: PrevizGizmoDeps) {
    // 手柄本体不是 Object3D：加错了不会报错，只是永远看不见。
    deps.root.add(deps.controls.getHelper());
    deps.controls.setSpace('world');

    deps.controls.addEventListener('dragging-changed', (event) => {
      // 不关掉轨道控制的话，一次拖拽会同时转相机和移物体。
      deps.orbit.enabled = event.value !== true;
      if (event.value === true) {
        // 开始时清标记，而不是提交后清：留着上一次的 true，下一次「点一下不拖」
        // 也会提交一步什么都没改的历史。
        this.movedDuringDrag = false;
        return;
      }
      if (!this.movedDuringDrag || !this.attachedId) return;
      // 拖到一半对象被删了（撤销、另一个窗口）时 object 会是 null。照着它读变换会抛，
      // 而这条处理链一断，上面那句 `orbit.enabled = true` 之后的收尾全没了。
      const node = deps.controls.object as THREE.Object3D | null;
      if (!node) return;
      deps.onCommit(this.attachedId, readTransform(node));
    });

    deps.controls.addEventListener('objectChange', () => {
      this.movedDuringDrag = true;
      deps.onChange();
    });
  }

  /** 挂到某个对象节点上。传 null 或锁定对象都等于摘掉手柄。 */
  attach(node: THREE.Object3D | null): void {
    const objectId = node?.userData?.previzObjectId;
    if (!node || node.userData?.previzLocked === true || typeof objectId !== 'string') {
      this.attachedId = null;
      this.deps.controls.detach();
      return;
    }
    this.attachedId = objectId;
    this.deps.controls.attach(node);
  }

  setMode(mode: GizmoMode): void {
    this.deps.controls.setMode(mode);
  }

  /** 截图前把手柄藏掉——箭头进了截图就毁了整张参考图。 */
  setHelperVisible(visible: boolean): void {
    this.deps.controls.getHelper().visible = visible;
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
