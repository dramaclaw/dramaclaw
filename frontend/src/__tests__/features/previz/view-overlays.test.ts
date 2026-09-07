// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrevizObject } from "@/features/previz/domain/objects";
import { createDefaultScene, type PrevizScene } from "@/features/previz/domain/scene";
import { PREVIZ_OVERLAY_KEY } from "@/features/previz/engine/sceneGraph";
import { PrevizViewOverlays } from "@/features/previz/engine/viewOverlays";

/**
 * 和场景图的用例同一个路子：真 three 在 jsdom 里连 WebGLRenderer 都建不出来，而这里
 * 要测的全是「树上多了 / 少了哪些节点、它们什么时候可见」，用替身反而断言得更准。
 * `PrevizViewOverlays` 把 three 当构造参数收，就是为了这个。
 */
class FakeObject3D {
  children: FakeObject3D[] = [];
  parent: FakeObject3D | null = null;
  userData: Record<string, unknown> = {};
  visible = true;
  renderOrder = 0;
  raycast: () => void = () => {};
  readonly position = { x: 0, y: 0, z: 0, set: vi.fn() };
  readonly rotation = { set: vi.fn() };
  readonly scale = { x: 0, y: 0, set: vi.fn() };

  add(child: FakeObject3D): this {
    child.parent = this;
    this.children.push(child);
    return this;
  }

  remove(child: FakeObject3D): this {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
    return this;
  }

  removeFromParent(): this {
    this.parent?.remove(this);
    return this;
  }

  traverse(callback: (object: FakeObject3D) => void): void {
    callback(this);
    for (const child of [...this.children]) child.traverse(callback);
  }
}

class FakeMesh extends FakeObject3D {
  isMesh = true;
  material: unknown = null;

  clone(): FakeMesh {
    const copy = new FakeMesh();
    copy.userData = { ...this.userData };
    copy.material = this.material;
    return copy;
  }
}

const disposed: string[] = [];

class FakeMaterial {
  onBeforeCompile: ((shader: { vertexShader: string }) => void) | null = null;
  map: { dispose: () => void } | null = null;
  constructor(public readonly options: Record<string, unknown> = {}) {
    this.map = (options.map as { dispose: () => void } | undefined) ?? null;
  }
  dispose() {
    disposed.push("material");
  }
}

class FakeSprite extends FakeObject3D {
  constructor(public material: FakeMaterial) {
    super();
  }
}

function fakeThree() {
  return {
    BackSide: 1,
    LinearFilter: 2,
    MeshBasicMaterial: FakeMaterial,
    SpriteMaterial: FakeMaterial,
    Sprite: FakeSprite,
    CanvasTexture: class {
      minFilter = 0;
      constructor(public readonly image: HTMLCanvasElement) {}
      dispose() {
        disposed.push("texture");
      }
    },
  } as never;
}

/** 一个人物节点：一件模型网格 + 一个不该被描边的辨识标记。 */
function characterNode() {
  const node = new FakeObject3D();
  const model = new FakeMesh();
  const marker = new FakeMesh();
  marker.userData.previzMarker = true;
  node.add(model);
  node.add(marker);
  return { node, model, marker };
}

function sceneWithCharacter(): { scene: PrevizScene; id: string } {
  const scene = createDefaultScene();
  scene.objects.push(createPrevizObject("character", scene.objects));
  return { scene, id: scene.objects[0]!.id };
}

function overlayChildren(mesh: FakeObject3D) {
  return mesh.children.filter((child) => child.userData[PREVIZ_OVERLAY_KEY]);
}

/** 给名牌用的 2D 上下文替身。jsdom 没装 node-canvas，真调 getContext 拿到的是 null。 */
function stubCanvas2d() {
  const context = {
    font: "",
    fillStyle: "",
    textAlign: "",
    textBaseline: "",
    measureText: () => ({ width: 120 }),
    fillRect: vi.fn(),
    fillText: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return context;
}

afterEach(() => {
  vi.restoreAllMocks();
  disposed.length = 0;
});

describe("PrevizViewOverlays", () => {
  it("touches nothing while both switches are off", () => {
    const { scene, id } = sceneWithCharacter();
    const { node, model } = characterNode();
    const overlays = new PrevizViewOverlays(fakeThree());

    overlays.sync(scene, () => node as never);

    // 关着的时候连遍历都不该走：注入的 three 可能是个只够别处用的替身。
    expect(model.children).toHaveLength(0);
    expect(node.children).toHaveLength(2);
    expect(id).toBeTruthy();
  });

  it("wraps every model mesh in an outline and leaves the marker alone", () => {
    const { scene } = sceneWithCharacter();
    const { node, model, marker } = characterNode();
    const overlays = new PrevizViewOverlays(fakeThree());
    overlays.setOptions({ outline: true, namePlate: false });

    overlays.sync(scene, () => node as never);

    expect(overlayChildren(model)).toHaveLength(1);
    // 辨识标记是画在场景里的界面，不是模型；给它描边只会多两团噪点。
    expect(overlayChildren(marker)).toHaveLength(0);
    // 描边套在模型外面，不剔掉拾取的话点谁都先撞上它。
    expect(overlayChildren(model)[0]!.raycast).not.toBe(model.raycast);
  });

  it("reuses one material and never doubles up on repeat syncs", () => {
    const { scene } = sceneWithCharacter();
    const second = characterNode();
    const first = characterNode();
    const node = new FakeObject3D();
    node.add(first.node);
    node.add(second.node);
    const overlays = new PrevizViewOverlays(fakeThree());
    overlays.setOptions({ outline: true, namePlate: false });

    overlays.sync(scene, () => node as never);
    overlays.sync(scene, () => node as never);

    expect(overlayChildren(first.model)).toHaveLength(1);
    expect(overlayChildren(second.model)).toHaveLength(1);
    // 描边没有逐节点的状态，各建一份材质只是白占显存。
    expect((overlayChildren(first.model)[0] as FakeMesh).material).toBe(
      (overlayChildren(second.model)[0] as FakeMesh).material,
    );
  });

  it("hides the overlays while a capture is running and puts them back", () => {
    const { scene } = sceneWithCharacter();
    const { node, model } = characterNode();
    const overlays = new PrevizViewOverlays(fakeThree());
    overlays.setOptions({ outline: true, namePlate: false });
    overlays.sync(scene, () => node as never);

    overlays.setSuppressed(true);
    expect(overlayChildren(model)[0]!.visible).toBe(false);

    // 让位是出片那一趟的事，用户自己的开关原样留着。
    overlays.setSuppressed(false);
    expect(overlayChildren(model)[0]!.visible).toBe(true);
  });

  it("hides the outline when the switch goes off", () => {
    const { scene } = sceneWithCharacter();
    const { node, model } = characterNode();
    const overlays = new PrevizViewOverlays(fakeThree());
    overlays.setOptions({ outline: true, namePlate: false });
    overlays.sync(scene, () => node as never);

    overlays.setOptions({ outline: false, namePlate: false });
    overlays.sync(scene, () => node as never);

    expect(overlayChildren(model)[0]!.visible).toBe(false);
  });

  it("drops the overlays of an object that left the scene", () => {
    const { scene } = sceneWithCharacter();
    const { node, model } = characterNode();
    const overlays = new PrevizViewOverlays(fakeThree());
    overlays.setOptions({ outline: true, namePlate: false });
    overlays.sync(scene, () => node as never);

    const emptied = { ...scene, objects: [] };
    overlays.sync(emptied, () => node as never);

    // 留着的话，撤销一次删除带回来的是全新的节点，旧描边会一直挂在树上。
    expect(overlayChildren(model)).toHaveLength(0);
  });

  it("puts a name plate above the character's head", () => {
    stubCanvas2d();
    const { scene } = sceneWithCharacter();
    const character = scene.objects[0]!;
    const { node } = characterNode();
    const overlays = new PrevizViewOverlays(fakeThree());
    overlays.setOptions({ outline: false, namePlate: true });

    overlays.sync(scene, () => node as never);

    const plate = node.children.find((child) => child.userData[PREVIZ_OVERLAY_KEY]);
    expect(plate).toBeDefined();
    expect(plate!.position.set).toHaveBeenCalledWith(
      0,
      expect.closeTo(character.kind === "character" ? character.heightCm / 100 + 0.26 : 0, 5),
      0,
    );
  });

  it("redraws the plate when the character is renamed and returns the old texture", () => {
    stubCanvas2d();
    const { scene } = sceneWithCharacter();
    const { node } = characterNode();
    const overlays = new PrevizViewOverlays(fakeThree());
    overlays.setOptions({ outline: false, namePlate: true });
    overlays.sync(scene, () => node as never);

    const renamed = {
      ...scene,
      objects: [{ ...scene.objects[0]!, name: "阿零" }],
    } as PrevizScene;
    overlays.sync(renamed, () => node as never);

    expect(node.children.filter((child) => child.userData[PREVIZ_OVERLAY_KEY])).toHaveLength(1);
    // 每块名牌上印的是它自己的名字，贴图是独有的，换掉的那份必须显式还。
    expect(disposed).toContain("texture");
  });

  it("skips the name plate when there is no 2d context", () => {
    const { scene } = sceneWithCharacter();
    const { node } = characterNode();
    const overlays = new PrevizViewOverlays(fakeThree());
    overlays.setOptions({ outline: false, namePlate: true });

    // jsdom 的默认行为就是返回 null；这一条锁的是「不画名牌」而不是「整个崩掉」。
    expect(() => overlays.sync(scene, () => node as never)).not.toThrow();
    expect(node.children.filter((child) => child.userData[PREVIZ_OVERLAY_KEY])).toHaveLength(0);
  });
});
