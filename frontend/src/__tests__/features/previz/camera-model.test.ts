// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import { verticalFovDeg } from '@/features/previz/domain/camera';
import type { OutputAspect, PrevizCamera } from '@/features/previz/domain/scene';
import {
  PREVIZ_CAMERA_COLOR,
  PREVIZ_CAMERA_FRUSTUM_DISTANCE,
  buildCameraModel,
  frustumWireframe,
  syncCameraFrustum,
} from '@/features/previz/engine/cameraModel';

/**
 * 假 three。只实现本模块用到的那几个类——真 three 要 WebGL 上下文，jsdom 里建不出来。
 * 几何体各是一个独立子类并记下构造实参：机身是由几个基本体拼出来的，形状与尺寸
 * **就是**本模块的输出，共用一个类之后「把圆柱写成方块」在测试里完全看不出来。
 */
function fakeThree() {
  class Vector3 {
    constructor(
      public x = 0,
      public y = 0,
      public z = 0,
    ) {}
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  }
  class Object3D {
    name = '';
    visible = true;
    userData: Record<string, unknown> = {};
    children: Object3D[] = [];
    parent: Object3D | null = null;
    position = new Vector3();
    rotation = new Vector3();
    scale = new Vector3(1, 1, 1);
    add(child: Object3D) {
      child.parent = this;
      this.children.push(child);
      return this;
    }
    remove(child: Object3D) {
      this.children = this.children.filter((entry) => entry !== child);
      child.parent = null;
      return this;
    }
    traverse(callback: (object: Object3D) => void) {
      callback(this);
      for (const child of [...this.children]) child.traverse(callback);
    }
  }
  class Group extends Object3D {}
  class FakeGeometry {
    readonly shape: string = 'unknown';
    readonly args: number[];
    dispose = vi.fn();
    constructor(...args: number[]) {
      this.args = args;
    }
  }
  class FakeBoxGeometry extends FakeGeometry {
    readonly shape = 'box';
  }
  class FakeCylinderGeometry extends FakeGeometry {
    readonly shape = 'cylinder';
  }
  /** 视锥是逐点喂进来的，构造实参为空，点在 `setAttribute` 里落下来。 */
  class FakeBufferGeometry extends FakeGeometry {
    readonly shape = 'buffer';
    attributes: Record<string, { array: number[]; itemSize: number }> = {};
    setAttribute(name: string, attribute: { array: number[]; itemSize: number }) {
      this.attributes[name] = attribute;
      return this;
    }
  }
  class FakeFloat32BufferAttribute {
    constructor(
      public array: number[],
      public itemSize: number,
    ) {}
  }
  class FakeMaterial {
    opacity = 1;
    transparent = false;
    needsUpdate = false;
    color = { set: vi.fn() };
    dispose = vi.fn();
    constructor(public params: Record<string, unknown> = {}) {}
  }
  class Mesh extends Object3D {
    constructor(
      public geometry: FakeGeometry,
      public material: FakeMaterial,
    ) {
      super();
    }
  }
  class LineSegments extends Mesh {}

  return {
    Object3D,
    Group,
    Mesh,
    LineSegments,
    Vector3,
    BoxGeometry: FakeBoxGeometry,
    CylinderGeometry: FakeCylinderGeometry,
    BufferGeometry: FakeBufferGeometry,
    Float32BufferAttribute: FakeFloat32BufferAttribute,
    MeshStandardMaterial: FakeMaterial,
    LineBasicMaterial: FakeMaterial,
  } as unknown as typeof import('three');
}

function cameraWith(overrides: Partial<PrevizCamera> = {}): PrevizCamera {
  return {
    id: 'cam-1',
    kind: 'camera',
    name: '机位 1',
    visible: true,
    locked: false,
    transform: { position: [0, 1.5, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    focalMm: 50,
    aperture: 2.8,
    sensor: 'ff',
    cameraBody: 'cine',
    lensSeries: 'prime',
    ...overrides,
  };
}

/** 断言用的最小结构视图。 */
interface MeshView {
  geometry: {
    shape: string;
    args: number[];
    dispose: ReturnType<typeof vi.fn>;
    attributes?: Record<string, { array: number[]; itemSize: number }>;
  };
  material: { params: { color?: number }; dispose: ReturnType<typeof vi.fn> };
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  userData: Record<string, unknown>;
}

function meshesOf(model: unknown): MeshView[] {
  const found: MeshView[] = [];
  (model as { traverse(cb: (object: unknown) => void): void }).traverse((object) => {
    const mesh = object as MeshView;
    if (mesh.geometry) found.push(mesh);
  });
  return found;
}

function frustumOf(model: unknown): MeshView {
  const line = meshesOf(model).find((mesh) => mesh.userData.previzCameraFrustum);
  if (!line) throw new Error('模型里没有视锥');
  return line;
}

/** 视锥线段的端点，每三个数一组。 */
function pointsOf(line: MeshView): Array<[number, number, number]> {
  const array = line.geometry.attributes?.position?.array ?? [];
  const points: Array<[number, number, number]> = [];
  for (let index = 0; index < array.length; index += 3) {
    points.push([array[index]!, array[index + 1]!, array[index + 2]!]);
  }
  return points;
}

describe('frustumWireframe', () => {
  it('draws four edges from the lens plus the far rectangle', () => {
    const points = frustumWireframe(50, 'ff', '16:9', 2);

    // 8 条线段 × 2 端 × 3 分量：4 条棱加远端矩形的 4 条边。
    expect(points).toHaveLength(48);
  });

  it('starts every edge at the camera origin and lands the corners on the far plane', () => {
    const line = frustumWireframe(50, 'ff', '16:9', 2);
    const points: Array<[number, number, number]> = [];
    for (let index = 0; index < line.length; index += 3) {
      points.push([line[index]!, line[index + 1]!, line[index + 2]!]);
    }

    // 前四段是棱：每一段都从原点出发，落在 z = -distance 的远平面上。
    for (let segment = 0; segment < 4; segment += 1) {
      expect(points[segment * 2]).toEqual([0, 0, 0]);
      expect(points[segment * 2 + 1]![2]).toBeCloseTo(-2, 6);
    }
    // 后四段是远端矩形：两端都在远平面上，不再回到原点。
    for (let segment = 4; segment < 8; segment += 1) {
      expect(points[segment * 2]![2]).toBeCloseTo(-2, 6);
      expect(points[segment * 2 + 1]![2]).toBeCloseTo(-2, 6);
    }
  });

  it('sizes the far rectangle from the taking fov, not the sensor', () => {
    const distance = 2;
    const points = frustumWireframe(50, 'ff', '16:9', distance);
    const halfHeight = Math.max(...points.filter((_, index) => index % 3 === 1));
    const halfWidth = Math.max(...points.filter((_, index) => index % 3 === 0));

    // 取景角与监看相机同源（`verticalFovDeg`），否则视口里画的框和监看里看到的画面对不上。
    const fov = verticalFovDeg(50, 'ff', '16:9');
    expect(halfHeight).toBeCloseTo(distance * Math.tan((fov * Math.PI) / 360), 6);
    // 16:9 的远端矩形是横的。
    expect(halfWidth / halfHeight).toBeCloseTo(16 / 9, 6);
  });

  it('narrows for a long lens and flips tall for a vertical output', () => {
    const wide = frustumWireframe(14, 'ff', '16:9', 2);
    const tele = frustumWireframe(200, 'ff', '16:9', 2);
    const widest = (points: number[]) => Math.max(...points.filter((_, i) => i % 3 === 0));
    expect(tele[0]).toBe(0);
    expect(widest(tele)).toBeLessThan(widest(wide));

    const portrait = frustumWireframe(50, 'ff', '9:16', 2);
    const tallest = (points: number[]) => Math.max(...points.filter((_, i) => i % 3 === 1));
    // 竖幅出片时取景框是立着的。
    expect(widest(portrait)).toBeLessThan(tallest(portrait));
  });
});

describe('buildCameraModel', () => {
  it('builds a body that sits behind the lens', () => {
    const three = fakeThree();
    const model = buildCameraModel(three, cameraWith(), '16:9');
    const solids = meshesOf(model).filter((mesh) => !mesh.userData.previzCameraFrustum);

    // 机身、顶板、尾板、镜头筒、遮光罩：五件。
    expect(solids).toHaveLength(5);
    // 镜头朝 -Z（three 相机的朝向），所以实体全在原点后方，视锥才不会穿过机身。
    for (const mesh of solids) expect(mesh.position.z).toBeGreaterThan(0);
    expect(solids.filter((mesh) => mesh.geometry.shape === 'cylinder')).toHaveLength(2);
    expect(solids.filter((mesh) => mesh.geometry.shape === 'box')).toHaveLength(3);
  });

  it('lays the lens barrels down the view axis', () => {
    const three = fakeThree();
    const model = buildCameraModel(three, cameraWith(), '16:9');
    const barrels = meshesOf(model).filter((mesh) => mesh.geometry.shape === 'cylinder');

    // three 的圆柱轴默认沿 Y，不转过来的话镜头是竖着插在机身上的。
    for (const barrel of barrels) expect(barrel.rotation.x).toBeCloseTo(Math.PI / 2, 6);
  });

  it('hands every part to the display-mode pass with its own colour', () => {
    const three = fakeThree();
    const model = buildCameraModel(three, cameraWith(), '16:9');

    for (const mesh of meshesOf(model)) {
      // 「全灰」会把材质统一染色，切回「实体」时各件靠自己记的本色还原。
      expect(mesh.userData.previzPlaceholder).toBe(true);
      expect(mesh.userData.previzPlaceholderColor).toBe(mesh.material.params.color);
    }
    expect(frustumOf(model).material.params.color).toBe(PREVIZ_CAMERA_COLOR.frustum);
  });

  it('draws the frustum at the shared preview distance', () => {
    const three = fakeThree();
    const model = buildCameraModel(three, cameraWith(), '16:9');
    const far = pointsOf(frustumOf(model)).map(([, , z]) => z);

    expect(Math.min(...far)).toBeCloseTo(-PREVIZ_CAMERA_FRUSTUM_DISTANCE, 6);
  });

  it('marks the whole model so the scene graph can find and replace it', () => {
    const three = fakeThree();
    const model = buildCameraModel(three, cameraWith(), '16:9');

    expect(model.userData.previzCameraModel).toBe(true);
    // 场景图按这个标记找占位体来删——机位模型也是占位体的一种。
    expect(model.userData.previzPlaceholder).toBe(true);
  });
});

describe('syncCameraFrustum', () => {
  const rebuild = (
    from: Partial<PrevizCamera>,
    to: Partial<PrevizCamera>,
    aspect: OutputAspect = '16:9',
    nextAspect: OutputAspect = aspect,
  ) => {
    const three = fakeThree();
    const model = buildCameraModel(three, cameraWith(from), aspect);
    const before = frustumOf(model).geometry;
    const changed = syncCameraFrustum(three, model, cameraWith(to), nextAspect);
    return { model, before, changed };
  };

  it('redraws when the focal length changes and disposes the old geometry', () => {
    const { model, before, changed } = rebuild({ focalMm: 50 }, { focalMm: 200 });

    expect(changed).toBe(true);
    // 旧几何体不还就是按帧泄漏——拖一次焦距滑杆能扔掉几十份。
    expect(before.dispose).toHaveBeenCalledTimes(1);
    const widest = Math.max(...pointsOf(frustumOf(model)).map(([x]) => Math.abs(x)));
    const wasWidest = Math.max(
      ...(before.attributes?.position?.array ?? []).filter((_, i) => i % 3 === 0).map(Math.abs),
    );
    // 200mm 的取景框比 50mm 窄——重建之后画的确实是新焦距。
    expect(widest).toBeLessThan(wasWidest);
  });

  it('redraws when the sensor or the output aspect changes', () => {
    expect(rebuild({ sensor: 'ff' }, { sensor: 's35' }).changed).toBe(true);
    expect(rebuild({}, {}, '16:9', '9:16').changed).toBe(true);
  });

  it('leaves the frustum alone when nothing optical moved', () => {
    // 位置和名字每帧都可能变，视锥不该跟着重建——`sync` 是逐帧调的。
    const { before, changed } = rebuild(
      { focalMm: 50, name: '机位 1' },
      { focalMm: 50, name: '机位 2', transform: { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    );

    expect(changed).toBe(false);
    expect(before.dispose).not.toHaveBeenCalled();
  });

  it('ignores a node that carries no frustum', () => {
    const three = fakeThree();
    const stray = new three.Group();

    expect(syncCameraFrustum(three, stray, cameraWith(), '16:9')).toBe(false);
  });
});
