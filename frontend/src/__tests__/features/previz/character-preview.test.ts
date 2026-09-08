// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import { createCharacterDraft } from "@/features/previz/domain/characterDraft";
import type { PrevizCharacterDraft } from "@/features/previz/domain/characterDraft";
import {
  renderCharacterPreview,
  type CharacterPreviewDeps,
} from "@/features/previz/engine/characterPreview";
import { createCharacterPlaceholder } from "@/features/previz/engine/sceneGraph";

/**
 * 这份用例盯的是「什么时候重建木偶」与「相机按身高摆在哪」，不是 three 本身。
 * jsdom 里建不出 WebGL 上下文，所以 three 换成一份只忠实到被测代码用得到那几处的假实现。
 */
class FakeObject3D {
  children: FakeObject3D[] = [];
  userData: Record<string, unknown> = {};
  visible = true;
  position = { x: 0, y: 0, z: 0, set: vi.fn() };
  add(child: FakeObject3D) {
    this.children.push(child);
  }
  remove(child: FakeObject3D) {
    this.children = this.children.filter((entry) => entry !== child);
  }
  traverse(visit: (object: FakeObject3D) => void) {
    visit(this);
    for (const child of [...this.children]) child.traverse(visit);
  }
}

class FakeGeometry {
  dispose = vi.fn();
  args: number[];
  constructor(...args: number[]) {
    this.args = args;
  }
}

class FakeMaterial {
  dispose = vi.fn();
  color = { set: vi.fn() };
  params: Record<string, unknown>;
  constructor(params: Record<string, unknown> = {}) {
    this.params = params;
  }
}

class FakeMesh extends FakeObject3D {
  constructor(
    public geometry: FakeGeometry,
    public material: FakeMaterial,
  ) {
    super();
  }
}

class FakeRenderTarget {
  disposed = false;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  dispose() {
    this.disposed = true;
  }
}

/** 场上那具木偶的骨架替身。`previzRig` 是场景图与预览共用的「这是真模型」标记。 */
function fakeRig(): FakeObject3D {
  const rig = new FakeObject3D();
  rig.userData.previzRig = true;
  rig.userData.previzSharedModel = true;
  return rig;
}

function setup(options: { build?: () => FakeObject3D | null } = {}) {
  const targets: FakeRenderTarget[] = [];
  const three = {
    Group: FakeObject3D,
    Mesh: FakeMesh,
    CapsuleGeometry: FakeGeometry,
    SphereGeometry: FakeGeometry,
    MeshStandardMaterial: FakeMaterial,
    SRGBColorSpace: "srgb",
    WebGLRenderTarget: class extends FakeRenderTarget {
      constructor(width: number, height: number) {
        super(width, height);
        targets.push(this);
      }
    },
  } as unknown as CharacterPreviewDeps["three"];

  const renderer = {
    getRenderTarget: vi.fn(() => null),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    readRenderTargetPixels: vi.fn(),
  };

  const camera = {
    position: { set: vi.fn() },
    lookAt: vi.fn(),
    fov: 0,
    aspect: 0,
    updateProjectionMatrix: vi.fn(),
  };

  const canvas = {
    width: 320,
    height: 180,
    getContext: () => ({
      fillStyle: "",
      fillRect: vi.fn(),
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData: vi.fn(),
    }),
  };

  const scene = new FakeObject3D();
  const build = vi.fn(async () => (options.build ?? fakeRig)());
  const applyCharacter = vi.fn(() => true);
  const rig = { build, applyCharacter };

  const deps = {
    three,
    renderer,
    camera,
    canvas,
    scene,
    rig,
  } as unknown as CharacterPreviewDeps;

  /** 预览场景里那个常驻的木偶容器；它的唯一子节点就是当前这具木偶。 */
  const mannequin = () => scene.children[0]?.children ?? [];
  /** 最后一次摆相机用的 [x, y, z]。 */
  const eye = () => {
    const calls = camera.position.set.mock.calls;
    return calls[calls.length - 1] as [number, number, number] | undefined;
  };

  return {
    deps, three, renderer, camera, canvas, scene, build, applyCharacter, targets, mannequin, eye,
  };
}

/**
 * 一棵占位体的形状：每一级的几何体构造参数与它被摆在哪。
 *
 * 只读构造时那一次 `position.set`——`FakeObject3D` 不算变换矩阵，拿它比对象的世界坐标
 * 是比不出东西来的。
 */
function shapeOf(node: unknown): unknown {
  const mesh = node as FakeMesh;
  return {
    geometry: mesh.geometry?.args,
    position: mesh.position.set.mock.calls[0],
    children: mesh.children.map(shapeOf),
  };
}

function draftOf(patch: Partial<PrevizCharacterDraft> = {}): PrevizCharacterDraft {
  return { ...createCharacterDraft([]), ...patch };
}

describe("renderCharacterPreview 重建判据", () => {
  it("clones one skeleton and then only re-poses it while the sliders move", async () => {
    const harness = setup();
    const base = draftOf({ bodyType: "average" });

    await renderCharacterPreview(harness.deps, base);
    await renderCharacterPreview(harness.deps, {
      ...base,
      poseAdjust: { pitch: 12, turn: 0, lean: 0 },
    });

    // 每拖一像素克隆一副骨架，滑杆会卡死——姿态微调走的是 `applyCharacter`，不是重建。
    expect(harness.build).toHaveBeenCalledTimes(1);
    expect(harness.applyCharacter).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ poseAdjust: { pitch: 12, turn: 0, lean: 0 } }),
    );
    expect(harness.mannequin()).toHaveLength(1);
  });

  it("keeps the same skeleton when only the body width changes", async () => {
    const harness = setup();

    await renderCharacterPreview(harness.deps, draftOf({ bodyType: "slim" }));
    await renderCharacterPreview(harness.deps, draftOf({ bodyType: "heavy" }));

    // 纤细 / 标准 / 健壮 / 高挑 只差一个水平缩放（`BODY_WIDTH_SCALE`），而缩放由
    // `applyCharacter` 每次无条件重算。为这个重建一副骨架是白花的。
    expect(harness.build).toHaveBeenCalledTimes(1);
    expect(harness.applyCharacter).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ bodyType: "heavy" }),
    );
  });

  it("keeps the same skeleton when only the base pose changes", async () => {
    const harness = setup();

    await renderCharacterPreview(harness.deps, draftOf({ basePoseId: "standing" }));
    await renderCharacterPreview(harness.deps, draftOf({ basePoseId: "sitting" }));

    // `applyPose` 就是为「rig 建好之后还能改姿势」写的，它自己带着一层缓存。
    expect(harness.build).toHaveBeenCalledTimes(1);
  });

  it("keeps the same skeleton when only the height changes", async () => {
    const harness = setup();

    await renderCharacterPreview(harness.deps, draftOf({ heightCm: 150 }));
    await renderCharacterPreview(harness.deps, draftOf({ heightCm: 200 }));

    // 身高对真模型只是一次 uniform 缩放（`applyBodyScale`）。占位胶囊才必须重建，
    // 因为它的高度是烤进 `CapsuleGeometry` 的——见下面那条。
    expect(harness.build).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when the draft crosses in or out of the capsule body", async () => {
    const harness = setup();

    await renderCharacterPreview(harness.deps, draftOf({ bodyType: "capsule" }));
    expect(harness.build).not.toHaveBeenCalled();

    await renderCharacterPreview(harness.deps, draftOf({ bodyType: "average" }));
    expect(harness.build).toHaveBeenCalledTimes(1);
    // 换过去之后场上只该剩一具：留着旧的等于让胶囊和木偶叠在一起。
    expect(harness.mannequin()).toHaveLength(1);
    expect(harness.mannequin()[0]?.userData.previzRig).toBe(true);

    await renderCharacterPreview(harness.deps, draftOf({ bodyType: "capsule" }));
    expect(harness.mannequin()).toHaveLength(1);
    expect(harness.mannequin()[0]?.userData.previzPlaceholder).toBe(true);
  });
});

describe("renderCharacterPreview 简化圆柱体", () => {
  it("draws the capsule through the scene graph's own placeholder factory", async () => {
    const harness = setup();
    const draft = draftOf({ bodyType: "capsule", heightCm: 180 });

    await renderCharacterPreview(harness.deps, draft);

    // 「简化圆柱体」这一档就是「不要 GLB」，问 rig 工厂要模型等于把这一档的意义抹掉。
    expect(harness.build).not.toHaveBeenCalled();

    // 逐个尺寸写字面量会把当下这副形状锁死，而占位体的轮廓还要改（球头露不露得出来
    // 是另一个 Task 的事）。这里锁的是本 Task 真正该保证的那件事：预览画的是
    // `createCharacterPlaceholder` 建出来的**那一件**，没有在预览侧重算第二份尺寸。
    // 形状怎么变都不影响这条；而只要预览自己算一次球心或半径，两边立刻对不上。
    const reference = createCharacterPlaceholder(harness.three, {
      heightCm: 180,
      color: draft.color,
    });
    expect(shapeOf(harness.mannequin()[0])).toEqual(shapeOf(reference));
  });

  it("rebuilds the capsule when the height changes because the size is baked in", async () => {
    const harness = setup();
    const draft = draftOf({ bodyType: "capsule", heightCm: 150 });

    await renderCharacterPreview(harness.deps, draft);
    const first = harness.mannequin()[0] as unknown as FakeMesh;

    await renderCharacterPreview(harness.deps, { ...draft, heightCm: 200 });
    const second = harness.mannequin()[0] as unknown as FakeMesh;

    expect(second).not.toBe(first);
    expect(shapeOf(second)).toEqual(
      shapeOf(createCharacterPlaceholder(harness.three, { heightCm: 200, color: draft.color })),
    );
    // 换下来的那一对 geometry / material 要还掉，否则拖一次身高滑杆就按帧漏。
    expect(first.geometry.dispose).toHaveBeenCalled();
    expect(first.material.dispose).toHaveBeenCalled();
  });

  it("does not rebuild the capsule while nothing about it changed", async () => {
    const harness = setup();
    const draft = draftOf({ bodyType: "capsule", heightCm: 150 });

    await renderCharacterPreview(harness.deps, draft);
    const first = harness.mannequin()[0];
    await renderCharacterPreview(harness.deps, { ...draft, name: "改个名字" });

    expect(harness.mannequin()[0]).toBe(first);
  });

  it("falls back to the capsule when the actor model cannot be loaded", async () => {
    const harness = setup({ build: () => null });

    await renderCharacterPreview(harness.deps, draftOf({ bodyType: "average" }));

    // 模型下不下来是网络的事。给用户一块空地，他会以为是自己选错了体型。
    expect(harness.mannequin()[0]?.userData.previzPlaceholder).toBe(true);
    // 下一次编辑要再试一次，否则这个对话框在这一次会话里永远停在胶囊上。
    await renderCharacterPreview(harness.deps, draftOf({ bodyType: "average" }));
    expect(harness.build).toHaveBeenCalledTimes(2);
  });
});

describe("renderCharacterPreview 取景", () => {
  it("frames the mannequin the same way at both ends of the height range", async () => {
    const harness = setup();

    await renderCharacterPreview(harness.deps, draftOf({ heightCm: 150 }));
    const short = harness.eye()!;
    await renderCharacterPreview(harness.deps, draftOf({ heightCm: 220 }));
    const tall = harness.eye()!;

    // 视线抬到半身高，人正好在画面中间。
    expect(short[1]).toBeCloseTo(0.75, 6);
    expect(tall[1]).toBeCloseTo(1.1, 6);
    expect(harness.camera.lookAt).toHaveBeenLastCalledWith(0, 1.1, 0);

    // 距离与身高成正比：150 cm 与 220 cm 各自占掉同样比例的画面高度。
    const shortDistance = Math.hypot(short[0], short[2]);
    const tallDistance = Math.hypot(tall[0], tall[2]);
    expect(shortDistance).toBeCloseTo(3.2547, 3);
    expect(tallDistance).toBeCloseTo(4.7736, 3);

    // 落到取景上：身高占画面高度的 86%，上下各留一成余量。
    const fill = (height: number, distance: number) =>
      height / (2 * distance * Math.tan((harness.camera.fov / 2) * (Math.PI / 180)));
    expect(fill(1.5, shortDistance)).toBeCloseTo(0.86, 6);
    expect(fill(2.2, tallDistance)).toBeCloseTo(0.86, 6);
  });

  it("stands in front of the mannequin, off to one side", async () => {
    const harness = setup();

    await renderCharacterPreview(harness.deps, draftOf({ heightCm: 200 }));
    const [x, , z] = harness.eye()!;

    // 人物零旋转时朝 -Z（`characterRig` 把模型转了半圈就为这条），站到 +Z 去看的是后脑勺。
    expect(z).toBeLessThan(0);
    // 再偏开 30°：正面看「前倾」那根滑杆的旋转轴正对着镜头，人只是变矮一点点。
    expect(Math.atan2(x, -z) * (180 / Math.PI)).toBeCloseTo(30, 6);
  });

  it("frames the body it actually drew, not the number the user typed", async () => {
    const harness = setup();

    await renderCharacterPreview(harness.deps, draftOf({ heightCm: 1000 }));
    const eye = harness.eye()!;

    // 木偶的身高被 `PREVIZ_HEIGHT_CM_RANGE` 夹到 220 了（占位胶囊与 `applyBodyScale`
    // 各自夹过一次）。相机跟着那个 1000 飞出去的话，画面上是一个远处的小点。
    expect(eye[1]).toBeCloseTo(1.1, 6);
    expect(Math.hypot(eye[0], eye[2])).toBeCloseTo(4.7736, 3);
  });

  it("matches the canvas aspect and paints through the shared renderer", async () => {
    const harness = setup();

    await renderCharacterPreview(harness.deps, draftOf());

    expect(harness.camera.aspect).toBeCloseTo(320 / 180, 6);
    expect(harness.camera.updateProjectionMatrix).toHaveBeenCalled();
    // 借的是视口那台 renderer：为一个对话框再开一个 WebGL 上下文是拿整个编辑器冒险。
    expect(harness.renderer.render).toHaveBeenCalledWith(harness.scene, harness.camera);
    // 离屏缓冲用完要还，屏幕上原来挂着的 target 也要还回去。
    expect(harness.targets[0]?.disposed).toBe(true);
    expect(harness.renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
  });
});

describe("renderCharacterPreview 并发", () => {
  it("keeps a single mannequin when two builds overlap", async () => {
    const pending: Array<(value: FakeObject3D) => void> = [];
    const harness = setup();
    harness.build.mockImplementation(
      () => new Promise<FakeObject3D>((resolve) => pending.push(resolve)),
    );

    const first = renderCharacterPreview(harness.deps, draftOf({ bodyType: "average" }));
    const second = renderCharacterPreview(harness.deps, draftOf({ bodyType: "capsule" }));
    // 先建的那一具后到：滑杆一路拖过去时这就是常态。
    pending[0]?.(fakeRig());
    await Promise.all([first, second]);

    // 过时的那一具挂进去会和新的叠在一起——画面上是一个人站在自己的胶囊里。
    expect(harness.mannequin()).toHaveLength(1);
    expect(harness.mannequin()[0]?.userData.previzPlaceholder).toBe(true);
  });
});
