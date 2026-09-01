// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { clampToRange, DEG_TO_RAD, type PrevizRange } from '../domain/camera';
import {
  PREVIZ_DEFAULT_HEIGHT_CM,
  PREVIZ_MAX_HEIGHT_CM,
  PREVIZ_MIN_HEIGHT_CM,
} from '../domain/objects';
import {
  PREVIZ_SCALE_RANGE,
  type DisplayMode,
  type PrevizObject,
  type PrevizScene,
  type Vec3,
} from '../domain/scene';

/** three 命名空间本体。以构造参数传入，绝不在本文件里 import —— 见类注释。 */
export type ThreeModule = typeof THREE;

/** 半透明模式的不透明度。设计文档「显示模式」一节定的 0.35。 */
export const PREVIZ_TRANSLUCENT_OPACITY = 0.35;

/**
 * 人物占位胶囊的半径，单位米。0.22 m 是成年人肩宽的一半上下，粗到一眼看得出是个人、
 * 细到不至于把相邻的两个人物粘在一起。
 *
 * 它同时是一条尺寸约束：胶囊中段长度是「身高 − 2 × 半径」，必须为正。身高先夹进
 * `HEIGHT_CM_RANGE`，下界 `PREVIZ_MIN_HEIGHT_CM` = 120 cm，减掉 0.44 m 还剩 0.76 m，
 * 离退化很远。改大这个半径前先算一遍这笔账。
 */
export const PREVIZ_PLACEHOLDER_RADIUS = 0.22;

/** 全灰模式的统一颜色。 */
const CLAY_COLOR = 0xb9bec8;

const KIND_COLOR: Record<PrevizObject['kind'], number> = {
  character: 0x6ea8fe,
  camera: 0xffd166,
  light: 0xfff3b0,
  prop: 0x9ad0a0,
};

/**
 * 身高区间。三个边界各自在 `domain/objects.ts` 有自己的调用方，这里只是拼成
 * `clampToRange` 要的形状——和 `domain/scene.ts` 里那份私有的 `HEIGHT_CM_RANGE`
 * 同源同值，共享的是常量而不是又抄了一遍数字。
 */
const HEIGHT_CM_RANGE: PrevizRange = {
  min: PREVIZ_MIN_HEIGHT_CM,
  max: PREVIZ_MAX_HEIGHT_CM,
  default: PREVIZ_DEFAULT_HEIGHT_CM,
};

/**
 * 位置与旋转没有值域，只有「必须有限」这一条。非有限分量落到 0：
 * NaN 会顺着 `updateMatrixWorld` 污染整棵子树的世界矩阵，物体从画面上凭空消失，
 * 而 three 一声不吭——症状离病因隔着整个引擎层。
 *
 * 这不是第二份 clamp：`clampToRange` 要一段区间，而这里没有区间可给。凡是有现成
 * 区间常量的字段（缩放、身高）走的都是 `clampToRange`。
 */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 场景图同步器：把 `PrevizScene.objects` 映成 three 的对象树，并按 id 做增量增删改。
 *
 * three 通过构造参数注入而不是本文件 import，理由有两条，都不是洁癖：
 * 一是 jsdom 里建不出 WebGL 上下文，注入之后可以喂假 three 单测结构行为；
 * 二是任何一处静态 `import 'three'` 都会把 three 从懒加载 chunk 里拽出来，
 * 预演台「不打开就不下载」的整个前提就没了。
 *
 * 本类只建占位几何体。真模型（人物 GLB、物件 GLB）由 `characterRig` /
 * `propLoader` 异步挂到同一个节点下面，占位在模型到位后移除。
 */
export class PrevizSceneGraph {
  private readonly nodes = new Map<string, THREE.Object3D>();
  private displayMode: DisplayMode | null = null;

  constructor(
    private readonly three: ThreeModule,
    private readonly root: THREE.Object3D,
  ) {}

  nodeFor(objectId: string): THREE.Object3D | undefined {
    return this.nodes.get(objectId);
  }

  /** 把当前场景同步进对象树。可以每帧调，代价是一次 Map 查表加几次赋值。 */
  sync(scene: PrevizScene): void {
    const mode = scene.settings.displayMode;
    // 显示模式只在变化时整树重刷：它要遍历整棵树改材质并让着色程序失效，每帧跑纯属浪费。
    const modeChanged = this.displayMode !== mode;
    this.displayMode = mode;

    const seen = new Set<string>();
    const created: THREE.Object3D[] = [];

    for (const object of scene.objects) {
      seen.add(object.id);
      let node = this.nodes.get(object.id);
      if (!node) {
        node = this.createNode(object);
        this.nodes.set(object.id, node);
        this.root.add(node);
        created.push(node);
      }

      node.name = object.name;
      node.visible = object.visible;
      node.userData.previzObjectId = object.id;
      node.userData.previzKind = object.kind;
      node.userData.previzLocked = object.locked;

      const { position, rotation, scale } = object.transform;
      const [px, py, pz] = finiteVec3(position);
      node.position.set(px, py, pz);
      // 场景里的角度是度（属性面板直接展示的就是它），three 的 Euler 收弧度。
      const [rx, ry, rz] = finiteVec3(rotation);
      node.rotation.set(rx * DEG_TO_RAD, ry * DEG_TO_RAD, rz * DEG_TO_RAD);
      // 零与负的缩放压出退化几何（法线全零、包围盒没厚度），手柄抓不住，
      // `view.ts` 的取景距离也跟着算不出来。夹取语义全仓只有 `clampToRange` 一份。
      node.scale.set(
        clampToRange(scale[0], PREVIZ_SCALE_RANGE),
        clampToRange(scale[1], PREVIZ_SCALE_RANGE),
        clampToRange(scale[2], PREVIZ_SCALE_RANGE),
      );
    }

    for (const [id, node] of [...this.nodes]) {
      if (seen.has(id)) continue;
      this.root.remove(node);
      disposeSubtree(node);
      this.nodes.delete(id);
    }

    // 模式没变时，这一帧新建的节点仍然要单独吃一次：它们的材质是按「实心」建出来的，
    // 少了这一步，半透明场景里后加的对象会一直停在实心态。
    if (modeChanged) this.applyDisplayMode(this.root);
    else for (const node of created) this.applyDisplayMode(node);
  }

  /** 新挂进来的模型（GLB）也要吃到当前显示模式，加载完调这个。 */
  refreshDisplayMode(): void {
    if (this.displayMode) this.applyDisplayMode(this.root);
  }

  dispose(): void {
    for (const node of this.nodes.values()) {
      this.root.remove(node);
      disposeSubtree(node);
    }
    this.nodes.clear();
    this.displayMode = null;
  }

  private createNode(object: PrevizObject): THREE.Object3D {
    const group = new this.three.Group();
    group.add(this.createPlaceholder(object));
    return group;
  }

  /** 占位几何体。人物胶囊、机位锥体、灯球、物件方块——形状不同是为了一眼分得清。 */
  private createPlaceholder(object: PrevizObject): THREE.Mesh {
    const three = this.three;
    let geometry: THREE.BufferGeometry;
    let yOffset = 0;

    switch (object.kind) {
      case 'character': {
        const height = clampToRange(object.heightCm, HEIGHT_CM_RANGE) / 100;
        // CapsuleGeometry(radius, height, …)：第二参数是两个半球之间那段柱体的高度
        // （three 0.185 的形参名就叫 height），胶囊总高是它加上两个半径，所以先减掉。
        const radius = PREVIZ_PLACEHOLDER_RADIUS;
        geometry = new three.CapsuleGeometry(radius, height - radius * 2, 4, 12);
        // 胶囊自身以原点为中心，抬高半个身高才让脚底落在 y=0 的地面网格上。
        yOffset = height / 2;
        break;
      }
      case 'camera':
        geometry = new three.ConeGeometry(0.16, 0.42, 4);
        break;
      case 'light':
        geometry = new three.SphereGeometry(0.14, 16, 12);
        break;
      case 'prop':
        geometry = new three.BoxGeometry(0.6, 0.6, 0.6);
        break;
    }

    const material = new three.MeshStandardMaterial({
      color: KIND_COLOR[object.kind],
      roughness: 0.7,
      metalness: 0.05,
    });
    const mesh = new three.Mesh(geometry, material);
    mesh.position.set(0, yOffset, 0);
    mesh.userData.previzPlaceholder = true;
    return mesh;
  }

  /**
   * 把当前显示模式刷到 `target` 子树的每份材质上。
   *
   * 从全灰切回来时只有占位体能恢复本色——它的颜色由 `KIND_COLOR` 决定，重算得出来。
   * Task 8 / Task 9 挂进来的 GLB 材质各有各的贴图与颜色，被染灰之后无从还原，那时要么
   * 给它们单独记一份原色，要么换成整体覆盖材质（`Scene.overrideMaterial`）；在只有占位体
   * 的当下，这个分支覆盖了全部情况。
   */
  private applyDisplayMode(target: THREE.Object3D): void {
    const mode = this.displayMode;
    if (!mode) return;
    target.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      for (const entry of list) {
        const standard = entry as THREE.MeshStandardMaterial;
        standard.transparent = mode === 'translucent';
        standard.opacity = mode === 'translucent' ? PREVIZ_TRANSLUCENT_OPACITY : 1;
        if (mode === 'clay') standard.color?.set(CLAY_COLOR);
        else if (mesh.userData.previzPlaceholder) {
          const kind = (mesh.parent?.userData.previzKind ?? 'prop') as PrevizObject['kind'];
          standard.color?.set(KIND_COLOR[kind]);
        }
        // `transparent` 参与 three 的着色程序缓存键（`WebGLPrograms` 的 opaque 项），
        // 不置 needsUpdate 就还在用旧程序，材质改了画面不跟着变。
        standard.needsUpdate = true;
      }
    });
  }
}

function finiteVec3(value: Vec3): Vec3 {
  return [finiteOr(value[0], 0), finiteOr(value[1], 0), finiteOr(value[2], 0)];
}

/** three 的 remove() 只解父子关系，几何体与材质要自己还。 */
function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material?.dispose();
  });
}
