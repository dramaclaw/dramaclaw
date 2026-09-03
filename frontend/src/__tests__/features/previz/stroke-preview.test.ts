// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import type { Vec3 } from '@/features/previz/domain/scene';
import {
  PREVIZ_STROKE_CAPACITY,
  PrevizStrokePreview,
} from '@/features/previz/engine/strokePreview';

/**
 * 够用的假 three，理由同 `path-preview.test.ts`：这个模块要测的是「建了几条线、
 * 画到第几个点、缓冲有没有反复重建」，全是结构性行为，不需要真的 WebGL。
 */
class FakeObject3D {
  visible = true;
  renderOrder = 0;
  frustumCulled = true;
  userData: Record<string, unknown> = {};
  children: FakeObject3D[] = [];

  add(child: FakeObject3D) {
    this.children.push(child);
    return this;
  }

  remove(child: FakeObject3D) {
    this.children = this.children.filter((entry) => entry !== child);
    return this;
  }
}

const disposed: string[] = [];

interface FakeAttribute {
  array: Float32Array;
  needsUpdate: boolean;
}

class FakeGeometry {
  drawRange = { start: 0, count: Infinity };
  setAttribute = vi.fn((_name: string, _attribute: FakeAttribute) => this);
  setDrawRange(start: number, count: number) {
    this.drawRange = { start, count };
  }
  dispose() {
    disposed.push('geometry');
  }
}

class FakeMaterial {
  constructor(public params: Record<string, unknown> = {}) {}
  dispose() {
    disposed.push('material');
  }
}

let geometriesBuilt = 0;

function fakeThree() {
  return {
    Group: FakeObject3D,
    Object3D: FakeObject3D,
    BufferGeometry: class extends FakeGeometry {
      constructor() {
        super();
        geometriesBuilt++;
      }
    },
    BufferAttribute: class {
      needsUpdate = false;
      constructor(
        public array: Float32Array,
        public itemSize: number,
      ) {}
    },
    LineBasicMaterial: FakeMaterial,
    Line: class extends FakeObject3D {
      constructor(
        public geometry: FakeGeometry,
        public material: FakeMaterial,
      ) {
        super();
      }
    },
  } as unknown as typeof import('three');
}

function setup() {
  disposed.length = 0;
  geometriesBuilt = 0;
  const three = fakeThree();
  const root = new three.Group();
  return { three, root, preview: new PrevizStrokePreview(three, root) };
}

function straightStroke(count: number): Vec3[] {
  return Array.from({ length: count }, (_, index) => [index, 1.5, -index] as Vec3);
}

/** 场上唯一那条线，连同它的假几何体。 */
function lineOf(root: { children: FakeObject3D[] }) {
  return root.children[0] as unknown as {
    visible: boolean;
    renderOrder: number;
    frustumCulled: boolean;
    geometry: FakeGeometry;
    material: FakeMaterial;
  };
}

describe('PrevizStrokePreview', () => {
  it('draws the stroke as one line through every sampled point', () => {
    const { root, preview } = setup();

    preview.set(straightStroke(3));

    const line = lineOf(root);
    expect(root.children).toHaveLength(1);
    expect(line.visible).toBe(true);
    // 画到第几个点由 drawRange 决定，缓冲本身是预分配的一大块。
    expect(line.geometry.drawRange).toEqual({ start: 0, count: 3 });
  });

  it('writes the points in world order', () => {
    const { root, preview } = setup();

    preview.set([
      [1, 2, 3],
      [4, 5, 6],
    ]);

    const attribute = lineOf(root).geometry.setAttribute.mock.calls[0][1];
    expect([...attribute.array.slice(0, 6)]).toEqual([1, 2, 3, 4, 5, 6]);
    // 不置 needsUpdate 的话缓冲改了也传不到 GPU，线会停在第一帧的形状上。
    expect(attribute.needsUpdate).toBe(true);
  });

  it('reuses one line and one buffer across the whole stroke', () => {
    const { root, preview } = setup();

    preview.set(straightStroke(2));
    const first = lineOf(root);
    for (let count = 3; count < 40; count++) preview.set(straightStroke(count));

    // 每次 pointermove 重建几何体就是每帧扔一批 GPU 缓冲，而一笔有几百个 move。
    expect(lineOf(root)).toBe(first);
    expect(geometriesBuilt).toBe(1);
    expect(lineOf(root).geometry.drawRange.count).toBe(39);
  });

  it('grows the buffer when a stroke outruns it', () => {
    const { root, preview } = setup();

    const long = straightStroke(PREVIZ_STROKE_CAPACITY + 1);
    preview.set(long);

    const line = lineOf(root);
    expect(line.geometry.drawRange.count).toBe(long.length);
    const calls = line.geometry.setAttribute.mock.calls;
    const attribute = calls[calls.length - 1][1];
    expect(attribute.array.length).toBeGreaterThanOrEqual(long.length * 3);
    // 末点也要真的落进缓冲：只扩容不重写会让新出来的那一段是零。
    const tail = (long.length - 1) * 3;
    expect([...attribute.array.slice(tail, tail + 3)]).toEqual(long[long.length - 1]);
  });

  it('hides the line instead of leaving the last stroke on screen', () => {
    const { root, preview } = setup();
    preview.set(straightStroke(4));

    preview.set(null);

    // 收笔后那条线必须消失，否则它会和刚生成的轨迹曲线重叠成两条。
    expect(lineOf(root).visible).toBe(false);
  });

  it('draws nothing until the stroke has two points', () => {
    const { root, preview } = setup();

    preview.set([[0, 0, 0]]);

    // 一个点连不成线，而按下还没拖时就是这个状态。
    expect(root.children).toHaveLength(0);
  });

  it('ignores depth so the line stays visible on the ground and behind objects', () => {
    const { root, preview } = setup();

    preview.set(straightStroke(2));

    const line = lineOf(root);
    // 贴地画时这条线和地面网格共面，开深度测试会争成一段一段的虚线；而画到人物
    // 背后去时用户同样要看得见自己画了什么。
    expect(line.material.params.depthTest).toBe(false);
    expect(line.material.params.depthWrite).toBe(false);
    expect(line.renderOrder).toBeGreaterThan(0);
    // drawRange 之外的顶点是零，包围球会把整条线算到原点去，进而被剔除掉。
    expect(line.frustumCulled).toBe(false);
  });

  it('gives the buffer back on dispose', () => {
    const { root, preview } = setup();
    preview.set(straightStroke(4));

    preview.dispose();

    expect(root.children).toHaveLength(0);
    expect(disposed).toEqual(['geometry', 'material']);
  });
});
