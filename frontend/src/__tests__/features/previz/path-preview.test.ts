// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import { createDefaultScene, type PrevizPathClip, type PrevizScene } from '@/features/previz/domain/scene';
import { PREVIZ_PATH_CURVE_SAMPLES, PrevizPathPreview } from '@/features/previz/engine/pathPreview';

/**
 * 够用的假 three。真 three 在 jsdom 里建不出 WebGL 上下文，而这个模块要测的全是
 * 「建了几条线、几个球、dispose 了几次」这类结构性行为——`PrevizPathPreview` 把
 * three 当构造参数收就是为了这个。
 */
class FakeObject3D {
  visible = true;
  userData: Record<string, unknown> = {};
  children: FakeObject3D[] = [];
  parent: FakeObject3D | null = null;
  position = { set: vi.fn() };

  add(child: FakeObject3D) {
    child.parent = this;
    this.children.push(child);
    return this;
  }

  remove(child: FakeObject3D) {
    this.children = this.children.filter((entry) => entry !== child);
    child.parent = null;
    return this;
  }

  traverse(callback: (object: FakeObject3D) => void) {
    callback(this);
    for (const child of [...this.children]) child.traverse(callback);
  }
}

const disposed: string[] = [];

function fakeThree() {
  class FakeGeometry {
    disposed = false;
    setFromPoints = vi.fn(() => this);
    dispose() {
      disposed.push('geometry');
    }
  }
  class FakeMaterial {
    constructor(public params: { color?: number } = {}) {}
    dispose() {
      disposed.push('material');
    }
  }
  return {
    Group: FakeObject3D,
    Object3D: FakeObject3D,
    Vector3: class {
      constructor(
        public x = 0,
        public y = 0,
        public z = 0,
      ) {}
    },
    BufferGeometry: FakeGeometry,
    SphereGeometry: class extends FakeGeometry {
      constructor(public radius = 0) {
        super();
      }
    },
    LineBasicMaterial: FakeMaterial,
    MeshBasicMaterial: FakeMaterial,
    Line: class extends FakeObject3D {
      constructor(
        public geometry: FakeGeometry,
        public material: FakeMaterial,
      ) {
        super();
      }
    },
    Mesh: class extends FakeObject3D {
      constructor(
        public geometry: FakeGeometry,
        public material: FakeMaterial,
      ) {
        super();
      }
    },
  } as unknown as typeof import('three');
}

function sceneWithPath(points = 3): PrevizScene {
  const clip: PrevizPathClip = {
    id: 'clip',
    kind: 'path',
    startFrame: 0,
    endFrame: 120,
    points: Array.from({ length: points }, (_, index) => ({
      id: `p${index}`,
      u: points > 1 ? index / (points - 1) : 0,
      position: [index, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
    })),
  };
  return {
    ...createDefaultScene(),
    timeline: { tracks: [{ id: 'track', objectId: 'obj', clips: [clip] }] },
  };
}

describe('PrevizPathPreview', () => {
  it('draws one curve and one marker per keyframe', () => {
    const three = fakeThree();
    const root = new three.Group();
    const preview = new PrevizPathPreview(three, root);

    preview.sync(sceneWithPath(3), null);

    // 一条曲线加三个轨迹点球。
    expect(root.children).toHaveLength(4);
  });

  it('samples the curve densely enough to look curved', () => {
    const three = fakeThree();
    const root = new three.Group();
    const preview = new PrevizPathPreview(three, root);

    preview.sync(sceneWithPath(3), null);

    const line = root.children[0] as unknown as { geometry: { setFromPoints: ReturnType<typeof vi.fn> } };
    // 只连关键帧的话画出来是折线，而对象走的是曲线——看到的路线和实际不是一条。
    expect(line.geometry.setFromPoints.mock.calls[0][0]).toHaveLength(PREVIZ_PATH_CURVE_SAMPLES + 1);
  });

  it('skips clips with fewer than two points', () => {
    const three = fakeThree();
    const root = new three.Group();
    const preview = new PrevizPathPreview(three, root);

    preview.sync(sceneWithPath(1), null);

    // 一个点连不成线，但那个点自己要看得见——否则刚插的第一个关键帧是隐形的。
    expect(root.children).toHaveLength(1);
  });

  it('frees the old geometry and material on every resync', () => {
    const three = fakeThree();
    const root = new three.Group();
    const preview = new PrevizPathPreview(three, root);
    preview.sync(sceneWithPath(3), null);
    disposed.length = 0;

    preview.sync(sceneWithPath(3), null);

    // 每次编辑都重建；不还回去的话拖一次滑杆就漏一批 GPU 缓冲。
    expect(disposed.filter((entry) => entry === 'geometry')).toHaveLength(4);
    expect(disposed.filter((entry) => entry === 'material')).toHaveLength(4);
  });

  it('clears everything when the scene has no tracks', () => {
    const three = fakeThree();
    const root = new three.Group();
    const preview = new PrevizPathPreview(three, root);
    preview.sync(sceneWithPath(3), null);

    preview.sync(createDefaultScene(), null);

    expect(root.children).toHaveLength(0);
  });

  it('gives the selected clip a different colour', () => {
    const three = fakeThree();
    const root = new three.Group();
    const preview = new PrevizPathPreview(three, root);

    preview.sync(sceneWithPath(3), 'clip');
    const selected = (root.children[0] as unknown as { material: { params: { color: number } } })
      .material.params.color;

    preview.sync(sceneWithPath(3), null);
    const plain = (root.children[0] as unknown as { material: { params: { color: number } } })
      .material.params.color;

    // 场上可以有好几条轨迹；选中的那条要一眼认得出，否则改片段属性时不知道在改哪条。
    expect(selected).not.toBe(plain);
  });

  it('tags every marker with its clip and point id', () => {
    const three = fakeThree();
    const root = new three.Group();
    const preview = new PrevizPathPreview(three, root);

    preview.sync(sceneWithPath(2), null);

    // 视口里点中一个球要能选中对应的轨迹点，靠的就是这两个标记。
    const marker = root.children[1];
    expect(marker.userData.previzClipId).toBe('clip');
    expect(marker.userData.previzPointId).toBe('p0');
  });

  it('marks the selected path point out from the rest', () => {
    const three = fakeThree();
    const root = new three.Group();
    const preview = new PrevizPathPreview(three, root);

    preview.sync(sceneWithPath(3), 'clip', 'p1');

    type Marker = { geometry: { radius: number }; material: { params: { color: number } } };
    const markers = root.children.slice(1) as unknown as Marker[];
    // 点中一个球之后画面上必须看得出点中的是哪个：只有右侧面板换了内容的话，
    // 用户没法确认自己点到的是不是想改的那个点。
    expect(markers[1].material.params.color).not.toBe(markers[0].material.params.color);
    expect(markers[2].material.params.color).toBe(markers[0].material.params.color);
    // 顺带长大一圈：改完位置之后还要再点它一次，太小了会点不回来。
    expect(markers[1].geometry.radius).toBeGreaterThan(markers[0].geometry.radius);
  });

  it('empties the group on dispose', () => {
    const three = fakeThree();
    const root = new three.Group();
    const preview = new PrevizPathPreview(three, root);
    preview.sync(sceneWithPath(3), null);
    disposed.length = 0;

    preview.dispose();

    expect(root.children).toHaveLength(0);
    expect(disposed.length).toBeGreaterThan(0);
  });
});
