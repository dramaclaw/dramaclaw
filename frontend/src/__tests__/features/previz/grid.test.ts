// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import {
  PREVIZ_GRID_CELL_SIZE,
  PREVIZ_GRID_FADE_MAX,
  PREVIZ_GRID_FADE_MIN,
  PREVIZ_GRID_SECTION_SIZE,
  createInfiniteGrid,
  gridFollowState,
  syncInfiniteGrid,
} from '@/features/previz/engine/grid';

/** 假 three。地面网格只用到平面几何体、着色器材质和一个 Mesh。 */
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
    renderOrder = 0;
    userData: Record<string, unknown> = {};
    children: Object3D[] = [];
    position = new Vector3();
    rotation = new Vector3();
    scale = new Vector3(1, 1, 1);
    frustumCulled = true;
    matrixWorldUpdates = 0;
    onBeforeRender:
      | ((renderer: unknown, scene: unknown, camera: { getWorldPosition(target: Vector3): Vector3 }) => void)
      | undefined;
    raycast(): void {}
    updateMatrixWorld(): void {
      this.matrixWorldUpdates += 1;
    }
  }
  class FakePlaneGeometry {
    readonly shape = 'plane';
    readonly args: number[];
    dispose = vi.fn();
    constructor(...args: number[]) {
      this.args = args;
    }
  }
  class FakeShaderMaterial {
    dispose = vi.fn();
    uniforms: Record<string, { value: unknown }>;
    transparent = false;
    depthWrite = true;
    side: unknown = 'front';
    vertexShader = '';
    fragmentShader = '';
    constructor(params: Record<string, unknown> = {}) {
      Object.assign(this, params);
      this.uniforms = (params.uniforms as Record<string, { value: unknown }>) ?? {};
    }
  }
  class Mesh extends Object3D {
    constructor(
      public geometry: FakePlaneGeometry,
      public material: FakeShaderMaterial,
    ) {
      super();
    }
  }

  return {
    Object3D,
    Mesh,
    Vector3,
    PlaneGeometry: FakePlaneGeometry,
    ShaderMaterial: FakeShaderMaterial,
    DoubleSide: 'double',
    Color: class {
      constructor(public hex = 0) {}
    },
  } as unknown as typeof import('three');
}

/** 断言用的最小结构视图。 */
interface GridView {
  geometry: { shape: string; args: number[]; dispose: ReturnType<typeof vi.fn> };
  material: {
    uniforms: Record<string, { value: unknown }>;
    transparent: boolean;
    depthWrite: boolean;
    side: unknown;
    vertexShader: string;
    fragmentShader: string;
    dispose: ReturnType<typeof vi.fn>;
  };
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  renderOrder: number;
  frustumCulled: boolean;
  matrixWorldUpdates: number;
  onBeforeRender?: (
    renderer: unknown,
    scene: unknown,
    camera: { getWorldPosition(target: { set(x: number, y: number, z: number): unknown }): unknown },
  ) => void;
  userData: Record<string, unknown>;
  raycast: () => void;
}

/** 一台只交得出世界坐标的假相机——网格跟随只用得到这一个量。 */
function fakeCameraAt(x: number, y: number, z: number) {
  return {
    getWorldPosition(target: { set(x: number, y: number, z: number): unknown }) {
      target.set(x, y, z);
      return target;
    },
  };
}

describe('gridFollowState', () => {
  it('opens the fade out as the camera climbs', () => {
    const low = gridFollowState(3);
    const high = gridFollowState(20);

    // 抬高视角看得更远，网格也要跟着铺得更远，否则一拉远就只剩脚下一小块。
    expect(high.fadeFar).toBeGreaterThan(low.fadeFar);
    expect(low.fadeNear).toBeLessThan(low.fadeFar);
  });

  it('clamps the fade at both ends', () => {
    // 贴地时按高度算出来的半径趋近 0，网格会整片消失。
    expect(gridFollowState(0).fadeFar).toBe(PREVIZ_GRID_FADE_MIN);
    // 拉到天上则要停在相机远裁剪面之内，否则网格被裁出一条直边——正是要消灭的那条边。
    expect(gridFollowState(100_000).fadeFar).toBe(PREVIZ_GRID_FADE_MAX);
  });

  it('reads the height as a distance, not a sign', () => {
    // 视角转到地平面以下时高度是负的；取绝对值，否则网格从下面看就没了。
    expect(gridFollowState(-12).fadeFar).toBe(gridFollowState(12).fadeFar);
  });

  it('makes the plane big enough to cover the whole fade', () => {
    for (const height of [0, 3, 20, 500]) {
      const state = gridFollowState(height);
      // 平面以相机为心，半边长必须够到淡出半径；差一点就会先撞上平面的直边。
      expect(state.extent / 2).toBeGreaterThanOrEqual(state.fadeFar);
    }
  });
});

describe('createInfiniteGrid', () => {
  it('lays a camera-facing plane flat on the ground', () => {
    const three = fakeThree();
    const grid = createInfiniteGrid(three) as unknown as GridView;

    expect(grid.geometry.shape).toBe('plane');
    // 平面自带 1×1，尺寸全靠 scale——跟着相机改大小时不必重建几何体。
    expect(grid.geometry.args.slice(0, 2)).toEqual([1, 1]);
    expect(grid.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
    // 从地平面下方看过去也要有网格，单面材质会让视角翻过去之后地面凭空消失。
    expect(grid.material.side).toBe('double');
  });

  it('keeps the ground out of the depth buffer and out of the picker', () => {
    const three = fakeThree();
    const grid = createInfiniteGrid(three) as unknown as GridView;

    expect(grid.material.transparent).toBe(true);
    // 网格是半透明的：写进深度缓冲的话它淡出的那一圈会把后面的对象整块挡掉。
    expect(grid.material.depthWrite).toBe(false);
    // 点选走的是射线检测。地面铺满整个视野，不摘掉的话每一次空点都会命中它，
    // 于是永远选不中「空白」，框选与取消选中全废。这里要的是实例上自带一个空实现，
    // 而不是继承 Mesh 的那个真检测。
    expect(Object.prototype.hasOwnProperty.call(grid, 'raycast')).toBe(true);
    const hits: unknown[] = [];
    (grid.raycast as unknown as (raycaster: unknown, intersects: unknown[]) => void)({}, hits);
    expect(hits).toHaveLength(0);
    expect(grid.userData.previzGrid).toBe(true);
  });

  it('drives the line spacing from uniforms, in metres', () => {
    const three = fakeThree();
    const grid = createInfiniteGrid(three) as unknown as GridView;

    expect(grid.material.uniforms.uCellSize?.value).toBe(PREVIZ_GRID_CELL_SIZE);
    expect(grid.material.uniforms.uSectionSize?.value).toBe(PREVIZ_GRID_SECTION_SIZE);
    // 粗线必须是细线的整数倍，否则两层线互相错开，画面上是一片乱纹而不是网格。
    expect(PREVIZ_GRID_SECTION_SIZE % PREVIZ_GRID_CELL_SIZE).toBe(0);
    expect(PREVIZ_GRID_SECTION_SIZE).toBeGreaterThan(PREVIZ_GRID_CELL_SIZE);
  });

  it('derives the lines from world coordinates', () => {
    const three = fakeThree();
    const grid = createInfiniteGrid(three) as unknown as GridView;

    // 线条按世界坐标算，平面跟着相机平移时线才不会跟着漂——这是「无限」的全部把戏。
    expect(grid.material.vertexShader).toContain('modelMatrix');
    expect(grid.material.fragmentShader).toContain('fwidth');
  });
});

describe('grid follow', () => {
  it('re-centres itself before every pass, whichever camera draws it', () => {
    const three = fakeThree();
    const grid = createInfiniteGrid(three) as unknown as GridView;

    // 跟随挂在 onBeforeRender 上，所以视口、监看、出片、取景预览四趟各自的相机
    // 都自动带上地面；逐个渲染调用点手动同步的话，漏掉的那一趟会整片没有地面。
    grid.onBeforeRender?.({}, {}, fakeCameraAt(50, 4, -20));

    expect(grid.position.x).toBe(50);
    expect(grid.position.z).toBe(-20);
    expect(grid.material.uniforms.uFadeFar?.value).toBeCloseTo(gridFollowState(4).fadeFar, 6);
    // onBeforeRender 发生在 three 算完世界矩阵之后，不补一次的话位置慢一帧生效，
    // 画面上是网格拖着相机漂。
    expect(grid.matrixWorldUpdates).toBeGreaterThan(0);
  });

  it('stays out of the frustum cull', () => {
    const three = fakeThree();
    const grid = createInfiniteGrid(three) as unknown as GridView;

    // 剔除判定用的是「挪到相机脚下之前」的位置，留着它网格会在被摆正之前就被判出局。
    expect(grid.frustumCulled).toBe(false);
  });
});

describe('syncInfiniteGrid', () => {
  it('centres the plane under the camera and resizes it', () => {
    const three = fakeThree();
    const grid = createInfiniteGrid(three) as unknown as GridView;

    syncInfiniteGrid(grid as never, { x: 12, y: 8, z: -30 });
    const state = gridFollowState(8);

    expect(grid.position.x).toBe(12);
    // 网格是地面，不管相机飞多高它都在 y=0。
    expect(grid.position.y).toBe(0);
    expect(grid.position.z).toBe(-30);
    // 平面绕 X 转平之后，本地 y 就是世界 z。
    expect(grid.scale.x).toBeCloseTo(state.extent, 6);
    expect(grid.scale.y).toBeCloseTo(state.extent, 6);
    expect(grid.material.uniforms.uFadeNear?.value).toBeCloseTo(state.fadeNear, 6);
    expect(grid.material.uniforms.uFadeFar?.value).toBeCloseTo(state.fadeFar, 6);
  });

  it('follows every pass, so a monitor camera gets its own patch of ground', () => {
    const three = fakeThree();
    const grid = createInfiniteGrid(three) as unknown as GridView;

    syncInfiniteGrid(grid as never, { x: 0, y: 6, z: 0 });
    syncInfiniteGrid(grid as never, { x: 200, y: 2, z: 40 });

    // 监看那一趟用的是机位自己的相机，可能离编辑视角很远。不跟着重定位的话，
    // 监看画面里看到的是网格边缘之外的一片空白。
    expect(grid.position.x).toBe(200);
    expect(grid.position.z).toBe(40);
    expect(grid.material.uniforms.uFadeFar?.value).toBeCloseTo(gridFollowState(2).fadeFar, 6);
  });
});
