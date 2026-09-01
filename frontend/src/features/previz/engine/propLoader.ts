// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import type { PrevizProp } from '../domain/scene';

export interface PropLoaderDeps {
  /** glb / gltf 走 GLTFLoader，obj 走 OBJLoader；两者都由渲染器动态 import 后注入。 */
  loadGltf: (url: string) => Promise<{ scene: THREE.Object3D }>;
  loadObj: (url: string) => Promise<THREE.Object3D>;
}

/**
 * 按 URL 加载物件模型。**不做归一化缩放**：物件是用户自备的资产，替他猜「应该多大」
 * 只会让一把本来就按米建模的椅子被缩成模型玩具。尺寸不对由用户在属性面板改 scale。
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
      const instance = model.clone();
      // `clone()` 是浅克隆几何体与材质：这一份和缓存里的源模型共用同一批 GPU 资源。
      // 场景图靠这个标记在删除物件时整棵跳过 dispose，否则删掉第一把椅子会把缓存里
      // 那份也还掉，之后同一个 URL 克隆出来的每一把都是空的。
      instance.userData.previzSharedModel = true;
      return instance;
    });
  }

  private async loadOnce(prop: PrevizProp): Promise<THREE.Object3D | null> {
    if (prop.assetFormat === 'obj') return this.deps.loadObj(prop.assetUrl);
    const gltf = await this.deps.loadGltf(prop.assetUrl);
    return gltf.scene;
  }
}
