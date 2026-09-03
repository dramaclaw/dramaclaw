// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import type { Vec3 } from '../domain/scene';
import type { ThreeModule } from './sceneGraph';

/**
 * 正在画的那一笔：一条跟着指针实时长出来的折线。
 *
 * 没有它，绘制轨迹是一次盲画——按下去到松手之间画面上什么都不发生，用户只能凭
 * 记忆猜自己划过哪里，松手才第一次看见结果。参照实现里这条线从按下的那一刻就在，
 * 实测下来它才是「画轨迹」这件事能用的前提。
 *
 * 画的是**原始笔画**，不是平滑重采样之后的结果：这条线代表「你的手划过了哪里」，
 * 提前把手抖磨掉反而对不上手感，而最终轨迹长什么样，松手后的轨迹曲线自会交代。
 *
 * three 通过构造参数注入而不是本文件 import，理由同 `sceneGraph.ts`。
 */

/**
 * 预分配的顶点数。一笔每个 pointermove 一个点，密集拖动几秒钟就是上千个，
 * 1024 覆盖绝大多数笔画；超了会翻倍扩容，所以这个数只影响扩容次数，不封顶。
 */
export const PREVIZ_STROKE_CAPACITY = 1024;

/**
 * 比成型轨迹（`pathPreview` 的 0x5b8cff）更淡的蓝。同色系是因为它俩说的是同一件事，
 * 淡一档是因为这一笔还没落地——松手之后颜色变实，本身就是「已生成」的信号。
 */
const STROKE_COLOR = 0x9fc0ff;

/** 排在所有常规物体之后画。不写深度就得靠顺序，否则后画的对象会盖住它。 */
const STROKE_RENDER_ORDER = 999;

export class PrevizStrokePreview {
  private line: THREE.Line | null = null;
  private attribute: THREE.BufferAttribute | null = null;
  private capacity = 0;

  constructor(
    private readonly three: ThreeModule,
    private readonly root: THREE.Object3D,
  ) {}

  /**
   * 把当前这一笔画出来；传 null（或不足两个点）收笔。
   *
   * 收笔走的是 `visible = false` 而不是拆掉重建：一次绘制里这个方法被调用几百次，
   * 而两笔之间的间隔以秒计——留着那条线什么都不占，重建才是真开销。
   *
   * `points` 当场就被抄进缓冲，所以调用方尽可以把还在增长的那支笔画数组本体递进来，
   * 不必每次 pointermove 复制一份。
   */
  set(points: readonly Vec3[] | null): void {
    if (!points || points.length < 2) {
      if (this.line) this.line.visible = false;
      return;
    }

    const { line, attribute } = this.ensure(points.length);
    const array = attribute.array as Float32Array;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      array[index * 3] = point[0];
      array[index * 3 + 1] = point[1];
      array[index * 3 + 2] = point[2];
    }
    attribute.needsUpdate = true;
    // 缓冲后面那截是上一笔留下的旧坐标（或零），画到第几个点只由 drawRange 说了算。
    line.geometry.setDrawRange(0, points.length);
    line.visible = true;
  }

  dispose(): void {
    if (!this.line) return;
    this.root.remove(this.line);
    this.line.geometry.dispose();
    const material = this.line.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material.dispose();
    this.line = null;
    this.attribute = null;
    this.capacity = 0;
  }

  /** 保证有一条线、且缓冲装得下 `count` 个点。 */
  private ensure(count: number): { line: THREE.Line; attribute: THREE.BufferAttribute } {
    if (this.line && this.attribute && this.capacity >= count) {
      return { line: this.line, attribute: this.attribute };
    }

    let capacity = Math.max(PREVIZ_STROKE_CAPACITY, this.capacity);
    while (capacity < count) capacity *= 2;

    // 自己 new Float32Array 再交给 BufferAttribute：`Float32BufferAttribute` 会把
    // 传进去的数组**拷一份**，那样往手里这份写坐标就传不到 GPU 了。
    const attribute = new this.three.BufferAttribute(new Float32Array(capacity * 3), 3);
    const geometry = new this.three.BufferGeometry();
    geometry.setAttribute('position', attribute);

    if (this.line) {
      // 扩容路径：换缓冲不换线，省掉一次材质重建，也不必重新设那几个标志位。
      this.line.geometry.dispose();
      this.line.geometry = geometry;
    } else {
      const material = new this.three.LineBasicMaterial({
        color: STROKE_COLOR,
        // 贴地画时这条线和地面网格共面，开深度测试会争成一段一段的虚线；画到人物
        // 背后去时用户同样要看得见自己画了什么——这是反馈，不是场景里的东西。
        depthTest: false,
        depthWrite: false,
      });
      this.line = new this.three.Line(geometry, material);
      this.line.renderOrder = STROKE_RENDER_ORDER;
      // drawRange 之外的顶点是零，包围球会被拉到原点去，进而在视锥外时被整条剔除。
      this.line.frustumCulled = false;
      this.root.add(this.line);
    }

    this.attribute = attribute;
    this.capacity = capacity;
    return { line: this.line, attribute };
  }
}
