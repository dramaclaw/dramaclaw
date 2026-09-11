// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import type { PrevizObject, PrevizScene } from '../domain/scene';
import { PREVIZ_OVERLAY_KEY, type ThreeModule } from './sceneGraph';

/**
 * 视图叠加层：模型描边与人物名牌。
 *
 * 这两样都是**看**的辅助，不是场景里的东西：它们在视口和机位监看里都要出现（监看是
 * 用来确认走位的，正是最需要认人的地方），但出片与录制里一律不出现。所以它们既不能
 * 走 `previzEditorOnly`（那批在监看里就被藏了），也不能当成普通子节点（会被拾取、被
 * 显示模式染色、被 `disposeSubtree` 当成自己的资源还掉）——统一打 `PREVIZ_OVERLAY_KEY`，
 * 由本模块独家持有它们的 GPU 资源。
 */

export interface PrevizViewOverlayOptions {
  /** 模型描边。 */
  outline: boolean;
  /** 人物名牌。 */
  namePlate: boolean;
}

/** 描边颜色。比背景（#101216）再深一点，贴着模型看得出是一条线而不是一圈光。 */
const OUTLINE_COLOR = 0x05070b;
/**
 * 描边厚度，单位米，沿模型法线外扩。世界尺度而不是屏幕尺度：屏幕恒宽要在裁剪空间里
 * 按深度补偿，而预演台的相机来回推拉得厉害，世界尺度那条「近处粗、远处细」反而更像
 * 一支笔画出来的。
 */
const OUTLINE_THICKNESS_M = 0.014;

/** 名牌贴图的字号与四周留白，单位是贴图像素。 */
const PLATE_FONT_PX = 34;
const PLATE_PADDING_PX = 18;
/** 名牌在世界里的高度，单位米。宽度按贴图的宽高比回推，长名字就更宽。 */
const PLATE_WORLD_HEIGHT_M = 0.17;
/** 名牌浮在头顶上方这么高。 */
const PLATE_LIFT_M = 0.26;
/** 人物没有身高时（模型自带尺寸）退到这个高度，免得名牌落在脚底。 */
const PLATE_FALLBACK_HEIGHT_M = 1.7;

/** 只有这两类挂描边：机位是取景框、灯是标记，给它们描边只会多两团噪点。 */
const OUTLINED_KINDS: ReadonlySet<PrevizObject['kind']> = new Set(['character', 'prop']);

interface OverlayEntry {
  /** 已经挂过描边的源网格。用它判重，不必每次 sync 都整树扫一遍 userData。 */
  readonly outlined: Set<THREE.Object3D>;
  plate: THREE.Sprite | null;
  /** 名牌上现在印的是哪个名字。改名了才重画贴图。 */
  plateName: string | null;
}

export class PrevizViewOverlays {
  private readonly entries = new Map<string, OverlayEntry>();
  private options: PrevizViewOverlayOptions = { outline: false, namePlate: false };
  /** 出片与录制期间整块让位，用户的开关原样留着。 */
  private suppressed = false;
  /** 所有描边共用一份材质：它没有逐节点的状态，各建一份只是白占显存。 */
  private outlineMaterial: THREE.Material | null = null;

  /**
   * 两个开关都关着时本类一件 three 的东西都不碰：材质是懒建的，节点遍历也只在对应
   * 开关打开时才走。渲染器的单测传的是手写的 three 替身，靠的就是这条。
   */
  constructor(private readonly three: ThreeModule) {}

  setOptions(options: PrevizViewOverlayOptions): void {
    this.options = options;
  }

  /** 出片 / 录制期间藏起来。传 false 恢复用户自己的开关。 */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
    this.applyVisibility();
  }

  /**
   * 按当前场景补齐或撤下叠加层。每次 `setScene` 调一次，模型异步到位时也要补调一次
   * ——那条路径不经过 setScene，少了它后到的 GLB 会一直没有描边。
   */
  sync(scene: PrevizScene, nodeFor: (objectId: string) => THREE.Object3D | undefined): void {
    const seen = new Set<string>();
    for (const object of scene.objects) {
      const node = nodeFor(object.id);
      if (!node) continue;
      seen.add(object.id);
      const entry = this.entryFor(object.id);
      if (this.options.outline && OUTLINED_KINDS.has(object.kind)) this.buildOutlines(entry, node);
      if (this.options.namePlate && object.kind === 'character') {
        this.buildPlate(entry, node, object.name, characterPlateHeight(object));
      }
    }

    // 对象删了、或撤销把它带回来时换了一个全新的节点：旧账留着会拖住一份贴图不放。
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      this.disposeEntry(entry);
      this.entries.delete(id);
    }

    this.applyVisibility();
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.outlineMaterial?.dispose();
    this.outlineMaterial = null;
  }

  private entryFor(objectId: string): OverlayEntry {
    let entry = this.entries.get(objectId);
    if (!entry) {
      entry = { outlined: new Set(), plate: null, plateName: null };
      this.entries.set(objectId, entry);
    }
    return entry;
  }

  /**
   * 反向外壳描边：把每个网格复制一份，材质换成只画背面、并沿法线外扩一圈的纯色。
   *
   * 复制体挂在**源网格自己底下**、变换归一，而不是挂在对象组下：蒙皮网格的
   * `bindMatrixWorld` 是从自己的 `matrixWorld` 推出来的，只有当父子变换完全一致时，
   * 复制体才会跟着骨骼一起动；挂到别处的话人一走动，描边会僵在原地。
   */
  private buildOutlines(entry: OverlayEntry, node: THREE.Object3D): void {
    const targets: THREE.Mesh[] = [];
    node.traverse((child) => {
      const mesh = child as THREE.Mesh;
      // 描边自己也是网格，不给描边再描一层边。辨识标记是界面，不是模型。
      if (!mesh.isMesh || mesh.userData[PREVIZ_OVERLAY_KEY] || mesh.userData.previzMarker) return;
      if (entry.outlined.has(mesh)) return;
      targets.push(mesh);
    });

    // traverse 期间不改树：往里加子节点会让同一次遍历走进刚加的那些描边。
    for (const mesh of targets) {
      const outline = mesh.clone(false) as THREE.Mesh;
      // clone 会把源网格的变换一起抄来，而复制体是源网格的子节点——不归一的话变换叠两遍。
      outline.position.set(0, 0, 0);
      outline.rotation.set(0, 0, 0);
      outline.scale.set(1, 1, 1);
      outline.material = this.sharedOutlineMaterial();
      // 整份换掉而不是补一个键：clone 抄来的 userData 里带着 previzSharedModel 之类的
      // 标记，留着会让下面的判重和资源回收都跟着错。
      outline.userData = { [PREVIZ_OVERLAY_KEY]: true };
      // 拾取只该命中模型本身；描边套在外面，不剔掉的话点谁都先撞上它。
      outline.raycast = () => {};
      mesh.add(outline);
      entry.outlined.add(mesh);
    }
  }

  private sharedOutlineMaterial(): THREE.Material {
    if (this.outlineMaterial) return this.outlineMaterial;
    const material = new this.three.MeshBasicMaterial({
      color: OUTLINE_COLOR,
      side: this.three.BackSide,
      // 描边是画在场景里的界面，不该被渲染器那条 ACES 曲线压掉颜色。
      // 同 `sceneGraph.markerMaterial`，那里写着完整理由。
      toneMapped: false,
    });
    material.onBeforeCompile = (shader) => {
      // 外扩放在 `begin_vertex` 之后、蒙皮之前：这时 `transformed` 还在绑定姿势下，
      // 外扩量会跟着骨骼一起被变换，人一动描边也跟着动。反过来在蒙皮之后再推，
      // 推的方向是绑定姿势的法线，抬手时描边会从手臂上滑开。
      // 用的是 `normal` 属性而不是 `objectNormal`：后者只在开了蒙皮或环境贴图时才声明，
      // 而 `normal` 是 three 给每个非 Raw 着色器无条件加的默认属性。
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed += normalize(normal) * ${OUTLINE_THICKNESS_M.toFixed(4)};`,
      );
    };
    this.outlineMaterial = material;
    return material;
  }

  /**
   * 人物名牌：一张画着名字的贴图挂成 Sprite，永远正对相机。
   *
   * `depthTest: false` 是故意的——名牌要在人被道具挡住时也读得到，那正是需要靠名字
   * 认人的时候。代价是它会浮在所有东西前面，所以尺寸压得很小。
   */
  private buildPlate(
    entry: OverlayEntry,
    node: THREE.Object3D,
    name: string,
    heightM: number,
  ): void {
    if (entry.plate && entry.plateName === name) {
      entry.plate.position.set(0, heightM + PLATE_LIFT_M, 0);
      return;
    }
    if (entry.plate) this.disposePlate(entry);

    const texture = createPlateTexture(this.three, name);
    // 没有 2D 上下文（jsdom 没装 node-canvas）就不画名牌，其余叠加层照常。
    if (!texture) return;

    const sprite = new this.three.Sprite(
      new this.three.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        // 名牌上的字是画好的像素，过一遍 ACES 只会把白字洗成灰字。同上。
        toneMapped: false,
      }),
    );
    const aspect = texture.image.width / texture.image.height;
    sprite.scale.set(PLATE_WORLD_HEIGHT_M * aspect, PLATE_WORLD_HEIGHT_M, 1);
    sprite.position.set(0, heightM + PLATE_LIFT_M, 0);
    // depthTest 关了之后先画后画就决定了叠放次序，名牌要压在模型上面。
    sprite.renderOrder = 10;
    sprite.userData = { [PREVIZ_OVERLAY_KEY]: true };
    sprite.raycast = () => {};
    node.add(sprite);
    entry.plate = sprite;
    entry.plateName = name;
  }

  /** 把所有叠加层的可见性刷成当前开关的样子。 */
  private applyVisibility(): void {
    const outline = this.options.outline && !this.suppressed;
    const plate = this.options.namePlate && !this.suppressed;
    for (const entry of this.entries.values()) {
      for (const mesh of entry.outlined) {
        for (const child of mesh.children) {
          if (child.userData[PREVIZ_OVERLAY_KEY]) child.visible = outline;
        }
      }
      if (entry.plate) entry.plate.visible = plate;
    }
  }

  private disposeEntry(entry: OverlayEntry): void {
    for (const mesh of entry.outlined) {
      for (const child of [...mesh.children]) {
        // 几何体是跟源网格借的，材质是全局共用的——描边自己什么都不持有，摘掉即可。
        if (child.userData[PREVIZ_OVERLAY_KEY]) mesh.remove(child);
      }
    }
    entry.outlined.clear();
    this.disposePlate(entry);
  }

  private disposePlate(entry: OverlayEntry): void {
    const plate = entry.plate;
    if (!plate) return;
    plate.removeFromParent();
    // 贴图是这块名牌独有的（上面印着它自己的名字），必须显式还。
    plate.material.map?.dispose();
    plate.material.dispose();
    entry.plate = null;
    entry.plateName = null;
  }
}

/** 人物头顶的高度。模型自带尺寸时 `heightCm` 仍然是用户填的那个值，直接用。 */
function characterPlateHeight(object: PrevizObject): number {
  if (object.kind !== 'character') return PLATE_FALLBACK_HEIGHT_M;
  const metres = object.heightCm / 100;
  return Number.isFinite(metres) && metres > 0 ? metres : PLATE_FALLBACK_HEIGHT_M;
}

/** 把名字画成一张贴图。拿不到 2D 上下文时返回 null。 */
function createPlateTexture(three: ThreeModule, name: string): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas');
  const measureContext = canvas.getContext('2d');
  if (!measureContext) return null;

  const font = `500 ${PLATE_FONT_PX}px system-ui, -apple-system, "PingFang SC", sans-serif`;
  measureContext.font = font;
  const textWidth = measureContext.measureText(name).width;
  // 先量再定尺寸：写死宽度的话长名字会被截掉，短名字两边留一大片空。
  canvas.width = Math.max(64, Math.ceil(textWidth + PLATE_PADDING_PX * 2));
  canvas.height = PLATE_FONT_PX + PLATE_PADDING_PX;

  // 改过 width / height 之后画布状态全被重置，字体要重新设。
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.font = font;
  context.fillStyle = 'rgba(8, 10, 14, 0.72)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new three.CanvasTexture(canvas);
  // 名牌是贴着屏幕看的，各向异性过滤帮不上忙，但线性缩小能让斜看时不闪。
  texture.minFilter = three.LinearFilter;
  return texture;
}
