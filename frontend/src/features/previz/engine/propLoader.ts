// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { isPrevizPrimitiveShape, type PrevizPrimitiveShape } from '../domain/primitives';
import { propUnitScale } from '../domain/propUnits';
import type { PrevizProp } from '../domain/scene';

export interface PropLoaderDeps {
  /** glb / gltf 走 GLTFLoader，obj 走 OBJLoader；两者都由渲染器动态 import 后注入。 */
  loadGltf: (url: string) => Promise<{ scene: THREE.Object3D }>;
  loadObj: (url: string) => Promise<THREE.Object3D>;
  /**
   * 克隆函数。必须是 `three/examples/jsm/utils/SkeletonUtils.js` 的 `clone`，
   * **不能**是 `Object3D.clone()`：后者复制 SkinnedMesh 时克隆体仍绑着源模型那具骨架，
   * 而源模型只躺在下面的缓存里、从没进过场景，骨头永远停在世界原点——于是不管把这份
   * 克隆挂到哪个物件节点下，蒙皮都按原点解算，模型渲染在原点，量出来的落地范围也在原点。
   * `characterRig.ts` 的 `CharacterRigDeps.clone` 上是同一条约束。
   */
  clone: (object: THREE.Object3D) => THREE.Object3D;
  /**
   * 量出模型自身包围盒的最长边。渲染器用 three 的 `Box3.setFromObject()` 实现。
   *
   * 做成注入而不是在这里 `new three.Box3()`：这一层至今只 import three 的类型、不碰
   * 它的实现——保住这一点，它就还能在没有 WebGL 的环境里测。
   */
  measure: (object: THREE.Object3D) => number;
  /**
   * 把整棵子树上的材质改成「预演台照得亮」的样子：双面，且 Phong / Lambert 换成
   * standard。渲染器用 `importedMaterials.ts` 实现，那边写着这两件事各自的理由。
   *
   * 做成注入而不是在这里做，与 `measure` 同理：这一层至今只 import three 的类型、
   * 不碰它的实现——保住这一点，它就还能在没有 WebGL 的环境里测。
   */
  prepareMaterials: (object: THREE.Object3D) => void;
  /**
   * 按形状名现造一件基础几何体（`assetFormat: 'primitive'`）。渲染器用
   * `primitiveBuilder.ts` 实现。做成注入的理由同 `measure`：这一层只 import three 的类型。
   */
  buildPrimitive: (shape: PrevizPrimitiveShape) => THREE.Object3D;
}

/**
 * 按 URL 加载物件模型。
 *
 * **只做整十倍的单位换算，不做「缩放到看着合适」**（见 `domain/propUnits.ts`）。两者
 * 差在哪儿：后者会把一把本来就按米建的椅子也缩一道，而单位换算对已经落在合理区间里的
 * 模型一个字节都不碰——它修的是「这份文件按厘米导出」这一类确凿的错，不是替用户拿主意。
 * 换不明白的仍旧原样放行，由用户在属性面板改 scale。
 */
export class PropLoader {
  /** 同一个 URL 只加载一次：同一把椅子摆 20 张不该下 20 遍。 */
  private readonly cache = new Map<string, Promise<THREE.Object3D | null>>();

  constructor(private readonly deps: PropLoaderDeps) {}

  load(prop: PrevizProp): Promise<THREE.Object3D | null> {
    if (!prop.assetUrl) return Promise.resolve(null);
    const key = `${prop.assetFormat}:${prop.assetUrl}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.loadOnce(prop).catch((error: unknown) => {
        // 失败的 Promise 留在缓存里会让重试永远拿到同一个错误。
        this.cache.delete(key);
        console.error('[previz] failed to load the prop model', prop.assetUrl, error);
        return null;
      });
      this.cache.set(key, pending);
    }
    // 每个物件要自己的一份：直接共享同一个 Object3D，第二个物件加进场景图时
    // 会把第一个从它父节点上摘走（three 的 add 会先 remove 旧父）。
    return pending.then((model) => {
      if (!model) return null;
      const instance = this.deps.clone(model);
      // 这个 clone 浅克隆几何体与材质：这一份和缓存里的源模型共用同一批 GPU 资源。
      // 场景图靠这个标记在删除物件时整棵跳过 dispose，否则删掉第一把椅子会把缓存里
      // 那份也还掉，之后同一个 URL 克隆出来的每一把都是空的。
      instance.userData.previzSharedModel = true;
      return instance;
    });
  }

  private async loadOnce(prop: PrevizProp): Promise<THREE.Object3D | null> {
    const model = await this.fetchModel(prop);
    this.applyUnitScale(model);
    // 和单位换算同理，烙在缓存里那份源模型上：`clone` 对材质是浅克隆，所有克隆体
    // 共用这一批材质，改一次就够。
    this.deps.prepareMaterials(model);
    return model;
  }

  private async fetchModel(prop: PrevizProp): Promise<THREE.Object3D> {
    switch (prop.assetFormat) {
      case 'primitive':
        // 形状名在解析时不校验（更新的版本可能加了新形状，旧版本不该把它写坏），认不
        // 出来就在这里按加载失败处理：`load()` 的 catch 会清缓存，占位方块留着。
        if (!isPrevizPrimitiveShape(prop.assetUrl)) {
          throw new Error(`unknown primitive shape: ${prop.assetUrl}`);
        }
        return this.deps.buildPrimitive(prop.assetUrl);
      case 'obj':
        return this.deps.loadObj(prop.assetUrl);
      default:
        return (await this.deps.loadGltf(prop.assetUrl)).scene;
    }
  }

  /**
   * 把单位换算烙在**缓存里那份源模型**上，而不是每个克隆体上。
   *
   * 于是同一个 URL 只量一次包围盒——`setFromObject` 要走遍整棵子树，几十万面的模型上
   * 不便宜——克隆体照抄 scale 就行。也正因如此它必须在 `loadOnce` 里、进缓存之前做完：
   * 挪到 `load()` 里的话，同一把椅子摆 20 张就要量 20 遍。
   */
  private applyUnitScale(model: THREE.Object3D): void {
    const largest = this.deps.measure(model);
    const scale = propUnitScale(largest);
    // 顺手把换算后的真实尺寸记下来。场景图靠它认出「一整间屋子」这类布景外壳，让它
    // 只接影不投影（见 `sceneGraph.enableShadows`）——包围盒这时刚量过，那边再量一遍
    // 就是把整棵子树白走一趟。
    model.userData.previzModelSizeM = largest * scale;
    if (scale === 1) return;
    // 逐分量乘，不用 `scale.multiplyScalar()`：这一层只依赖注入进来的 three 的**数据**
    // 形状，不依赖 Vector3 的方法表。`PrevizRenderer.syncDepthRange` 里是同一条理由。
    model.scale.x *= scale;
    model.scale.y *= scale;
    model.scale.z *= scale;
  }
}
