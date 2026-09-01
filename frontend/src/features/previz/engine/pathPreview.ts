// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { samplePathPosition } from '../domain/pathCurve';
import type { PrevizPathClip, PrevizScene } from '../domain/scene';
import { isPathClip } from '../domain/timeline';
import type { ThreeModule } from './sceneGraph';

/**
 * 轨迹预览：把路径片段画成一条曲线加一串轨迹点球。
 *
 * three 通过构造参数注入而不是本文件 import，理由同 `sceneGraph.ts`：jsdom 里建不出
 * WebGL 上下文，且任何一处静态 `import 'three'` 都会把 three 从懒加载 chunk 里拽出来。
 */

/**
 * 曲线采样段数。只连关键帧画出来是折线，而对象实际走的是 Catmull-Rom 曲线——
 * 看到的路线和跑出来的不是一条，用户会以为求值器错了。64 段在十来米的轨迹上
 * 目视已经完全平滑。
 */
export const PREVIZ_PATH_CURVE_SAMPLES = 64;

/** 轨迹点球半径，单位米。小到不挡住人物，大到在整场景视角下点得中。 */
const MARKER_RADIUS = 0.07;

const CURVE_COLOR = 0x5b8cff;
const CURVE_COLOR_SELECTED = 0xffd166;
const MARKER_COLOR = 0xdfe6f5;

export class PrevizPathPreview {
  constructor(
    private readonly three: ThreeModule,
    private readonly root: THREE.Object3D,
  ) {}

  /**
   * 整组重建，不做增量。一条轨迹撑死几百个顶点，而增量要按 clip id 对账点的增删改——
   * 那份账本的复杂度远超它省下的那点重建成本。
   */
  sync(scene: PrevizScene, selectedClipId: string | null): void {
    this.clear();

    for (const track of scene.timeline.tracks) {
      for (const clip of track.clips) {
        if (!isPathClip(clip)) continue;
        this.addClip(clip, clip.id === selectedClipId);
      }
    }
  }

  dispose(): void {
    this.clear();
  }

  private addClip(clip: PrevizPathClip, selected: boolean): void {
    // 一个点连不成线，但那个点自己要看得见——否则刚插的第一个关键帧是隐形的。
    if (clip.points.length >= 2) {
      const samples = Array.from({ length: PREVIZ_PATH_CURVE_SAMPLES + 1 }, (_, index) => {
        const [x, y, z] = samplePathPosition(clip.points, index / PREVIZ_PATH_CURVE_SAMPLES);
        return new this.three.Vector3(x, y, z);
      });
      const geometry = new this.three.BufferGeometry().setFromPoints(samples);
      const material = new this.three.LineBasicMaterial({
        color: selected ? CURVE_COLOR_SELECTED : CURVE_COLOR,
      });
      const line = new this.three.Line(geometry, material);
      line.userData.previzClipId = clip.id;
      this.root.add(line);
    }

    for (const point of clip.points) {
      const marker = new this.three.Mesh(
        new this.three.SphereGeometry(MARKER_RADIUS, 8, 8),
        new this.three.MeshBasicMaterial({ color: MARKER_COLOR }),
      );
      marker.position.set(point.position[0], point.position[1], point.position[2]);
      // 视口里点中一个球要能选中对应的轨迹点，靠的就是这两个标记。
      marker.userData.previzClipId = clip.id;
      marker.userData.previzPointId = point.id;
      this.root.add(marker);
    }
  }

  private clear(): void {
    for (const child of [...this.root.children]) {
      this.root.remove(child);
      // 这些几何体与材质都是本模块自己 new 出来的，没有和任何人共享，直接还回去。
      // 不还的话每次编辑都漏一批 GPU 缓冲。
      const drawable = child as THREE.Mesh;
      drawable.geometry?.dispose();
      const material = drawable.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    }
  }
}
