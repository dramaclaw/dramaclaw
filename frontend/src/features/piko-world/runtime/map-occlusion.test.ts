// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from "vitest";
import { Container, Graphics, Texture } from "pixi.js";
import data from "../../../../public/piko/world/maps/welcome-courtyard/data/occlusion.json";
import navigation from "../../../../public/piko/world/maps/welcome-courtyard/data/navigation.json";
import { PikoNavigationSchema, PikoOccluderSchema, PikoOcclusionSchema } from "./map-package-schema";
import { createMapOccluder, createBakedActorOcclusion, isBakedOccluder, isResidentHeadOccluded } from "./map-occlusion";
import { canStand, moveCharacter } from "./character-movement";
import { pointInPolygon } from "./navigation-geometry";
import { RESIDENT_WORLD_SCALE } from "./resident-actor";

const occlusion = PikoOcclusionSchema.parse(data);
const nav = PikoNavigationSchema.parse(navigation);

it("uses the seated head and ground depth together for speech visibility", () => {
  const scene = { ...occlusion, occluders: [{ ...occlusion.occluders[0], position: { x: 0, y: 0 }, depthY: 510,
    outline: [{x:1400,y:440},{x:1580,y:440},{x:1580,y:500},{x:1400,y:500}] }] };
  const seated = {x:1490,y:496};
  // Its seated head is in this silhouette, while the old standing head probe misses it.
  expect(isResidentHeadOccluded(seated, scene, 2)).toBe(false);
  expect(isResidentHeadOccluded(seated, scene, 2, {depthY:496,headOffset:18})).toBe(true);
  // Feet are in front of the scenery: the bubble should remain visible with the body.
  expect(isResidentHeadOccluded(seated, scene, 2, {depthY:540,headOffset:18})).toBe(false);
});

describe("welcome arch occlusion", () => {
  it("keeps a continuous north/south passage with the grove roots included", () => {
    expect(nav.colliders).toHaveLength(38);
    let position = { x: 1060, y: 1060 };
    for (let step = 0; step < 100; step++) {
      expect(canStand(position, nav)).toBe(true);
      position = moveCharacter(position, { x: 0, y: -1 }, 50, nav);
      if (position.y <= 700) break;
    }
    expect(position.y).toBeLessThanOrEqual(700);
    expect(canStand({ x: 940, y: 965 }, nav)).toBe(false);
    expect(canStand({ x: 1180, y: 965 }, nav)).toBe(false);
  });

  it("covers the beam while preserving empty pixels inside the doorway", () => {
    const contains = (x: number, y: number) => occlusion.occluders.some(item => pointInPolygon({
      x: x - item.position.x, y: y - item.position.y,
    }, item.outline!));
    expect(contains(1060, 770)).toBe(true);
    expect(contains(940, 925)).toBe(true);
    expect(contains(1180, 925)).toBe(true);
    for (let y = 825; y < 1030; y += 10) expect(contains(1060, y)).toBe(false);
  });

  it("allows crossing behind each pillar onto the grass while keeping the feet solid", () => {
    for (const direction of [-1, 1]) {
      for (const y of [790, 850, 925]) {
        let position = { x: 1060, y };
        for (let step = 0; step < 20; step++) {
          position = moveCharacter(position, { x: direction, y: 0 }, 50, nav);
        }
        expect(position.x).toBeCloseTo(1060 + direction * 150);
        expect(position.y).toBe(y);
      }
    }
    expect(canStand({ x: 935, y: 975 }, nav)).toBe(false);
    expect(canStand({ x: 1180, y: 975 }, nav)).toBe(false);
  });

  it("suppresses speech only when the head is behind the arch silhouette", () => {
    expect(isResidentHeadOccluded({ x: 1060, y: 855 }, occlusion, RESIDENT_WORLD_SCALE)).toBe(true);
    expect(isResidentHeadOccluded({ x: 1060, y: 950 }, occlusion, RESIDENT_WORLD_SCALE)).toBe(false);
    expect(isResidentHeadOccluded({ x: 1060, y: 1030 }, occlusion, RESIDENT_WORLD_SCALE)).toBe(false);
    expect(isResidentHeadOccluded({ x: 1300, y: 855 }, occlusion, RESIDENT_WORLD_SCALE)).toBe(false);
  });

  it("rejects invalid crops and outlines", () => {
    const beam = occlusion.occluders[0];
    expect(() => PikoOccluderSchema.parse({ ...beam, frame: { ...beam.frame, width: 0 } })).toThrow();
    expect(() => PikoOccluderSchema.parse({ ...beam, outline: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] })).toThrow();
    expect(() => createMapOccluder(Texture.WHITE, beam)).toThrow("exceeds source");
    expect(() => PikoOcclusionSchema.parse({ ...data, occluders: [beam, beam] })).toThrow("ID");
  });

  it("sorts separate scenery between rear and front actors without destroying shared textures", () => {
    const definition = PikoOccluderSchema.parse({ id: "test", src: "base.png", position: { x: 0, y: 0 }, depthY: 100,
      frame: { x: 0, y: 0, width: 1, height: 1 }, outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] });
    const item = createMapOccluder(Texture.WHITE, definition);
    const world = new Container({ sortableChildren: true });
    const rear = new Container({ zIndex: 90 }), front = new Container({ zIndex: 110 });
    world.addChild(front, item.container, rear);
    world.sortChildren();
    expect(world.children).toEqual([rear, item.container, front]);
    const source = Texture.WHITE.source;
    const context = (item.container.children[0] as Graphics).context;
    item.destroy();
    expect(context.destroyed).toBe(true);
    expect(source.destroyed).toBe(false);
    world.destroy({ children: true });
  });

  it("cuts only scenery ahead of the actor and restores the full actor in front", () => {
    const animatedPine = occlusion.occluders.find(item => item.id === "west-hall-pine");
    expect(animatedPine).toBeDefined();
    expect(isBakedOccluder(animatedPine!, "base.png")).toBe(false);
    const bakedOccluders = occlusion.occluders.filter(item => isBakedOccluder(item, "base.png"));
    expect(bakedOccluders).toHaveLength(30);
    const actor = new Container();
    actor.position.set(1060, 855);
    const masked = createBakedActorOcclusion(actor, bakedOccluders, { width: 2048, height: 1152 });
    expect(actor.mask).toBe(masked.mask);
    expect(masked.mask.containsPoint({ x: 1060, y: 770 })).toBe(false);
    expect(masked.mask.containsPoint({ x: 1060, y: 900 })).toBe(true);
    expect(masked.mask.containsPoint({ x: 940, y: 925 })).toBe(false);
    actor.y = 979;
    masked.update();
    expect(masked.mask.containsPoint({ x: 1060, y: 770 })).toBe(true);
    expect(masked.mask.containsPoint({ x: 940, y: 925 })).toBe(false);
    actor.y = 1040;
    masked.update();
    expect(masked.mask.containsPoint({ x: 1060, y: 770 })).toBe(true);
    expect(masked.mask.containsPoint({ x: 940, y: 925 })).toBe(true);
    actor.y = 855;
    masked.update();
    expect(actor.mask).toBe(masked.mask);
    masked.destroy();
    expect(actor.mask).toBeUndefined();
    actor.destroy();
  });

  it("matches the combined arch outlines across every depth transition", () => {
    const actor = new Container();
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    for (const depth of [855, 975, 981, 983]) {
      actor.y = depth;
      masked.update();
      // Avoid points exactly on polygon edges, where raster fill conventions differ.
      for (let y = 700.271; y < 1000; y += 7) {
        for (let x = 850.137; x < 1260; x += 7) {
          const hidden = occlusion.occluders.some(item => depth < item.depthY && pointInPolygon({
            x: x - item.position.x, y: y - item.position.y,
          }, item.outline!));
          const visible = !actor.mask || masked.mask.containsPoint({ x, y });
          expect(visible, `depth=${depth}, point=${x},${y}`).toBe(!hidden);
        }
      }
    }
    masked.destroy();
    actor.destroy();
  });
});

describe("east canopy tree occlusion", () => {
  const tree = occlusion.occluders.find(item => item.id === "east-canopy-tree")!;

  it("allows walking behind the trunk and around the tree while blocking roots and the bench", () => {
    let position = { x: 1410, y: 450 };
    for (let step = 0; step < 32; step++) {
      position = moveCharacter(position, { x: 1, y: 0 }, 50, nav);
    }
    expect(position).toEqual({ x: 1650, y: 450 });
    for (const x of [1400, 1600]) {
      for (let y = 360; y <= 560; y += 10) expect(canStand({ x, y }, nav)).toBe(true);
    }
    expect(canStand({ x: 1530, y: 450 }, nav)).toBe(true);
    expect(canStand({ x: 1530, y: 489 }, nav)).toBe(false);
    expect(canStand({ x: 1480, y: 520 }, nav)).toBe(false);
  });

  it("covers crown and trunk, then restores the player and speech in front of the roots", () => {
    const actor = new Container();
    actor.position.set(1530, 450);
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    expect(masked.mask.containsPoint({ x: 1520, y: 340 })).toBe(false);
    expect(masked.mask.containsPoint({ x: 1530, y: 460 })).toBe(false);
    expect(masked.mask.containsPoint({ x: 1380, y: 460 })).toBe(true);
    expect(isResidentHeadOccluded(actor.position, occlusion, RESIDENT_WORLD_SCALE)).toBe(true);
    actor.y = tree.depthY;
    masked.update();
    expect(masked.mask.containsPoint({ x: 1520, y: 340 })).toBe(true);
    expect(masked.mask.containsPoint({ x: 1530, y: 460 })).toBe(true);
    expect(isResidentHeadOccluded(actor.position, occlusion, RESIDENT_WORLD_SCALE)).toBe(false);
    masked.destroy();
    actor.destroy();
  });

  it("keeps tree clipping consistent with its outline alongside all three arch parts", () => {
    const actor = new Container();
    actor.y = 450;
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    for (let y = 250.271; y < 520; y += 7) {
      for (let x = 1350.137; x < 1670; x += 7) {
        const hidden = occlusion.occluders.some(item => actor.y < item.depthY && pointInPolygon({
          x: x - item.position.x, y: y - item.position.y,
        }, item.outline!));
        expect(masked.mask.containsPoint({ x, y }), `tree point=${x},${y}`).toBe(!hidden);
      }
    }
    expect(masked.mask.containsPoint({ x: 1060, y: 770 })).toBe(false);
    masked.destroy();
    actor.destroy();
  });
});

describe("central fountain occlusion", () => {
  const parts = occlusion.occluders.filter(item => item.id.startsWith("central-fountain-"));

  it("allows circling the basin and passing behind the statue while blocking the water", () => {
    expect(canStand({ x: 1060, y: 515 }, nav)).toBe(true);
    expect(canStand({ x: 1060, y: 588 }, nav)).toBe(false);
    for (const y of [530, 680]) {
      for (const direction of [-1, 1]) {
        let position = { x: direction === 1 ? 940 : 1180, y };
        for (let step = 0; step < 32; step++) position = moveCharacter(position, { x: direction, y: 0 }, 50, nav);
        expect(position).toEqual({ x: direction === 1 ? 1180 : 940, y });
      }
    }
    for (const x of [940, 1180]) {
      for (let y = 530; y <= 680; y += 10) expect(canStand({ x, y }, nav)).toBe(true);
    }
  });

  it("restores the upper statue before the basin as the player moves to the foreground", () => {
    const actor = new Container();
    actor.position.set(1060, 530);
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    expect(masked.mask.containsPoint({ x: 1060, y: 510 })).toBe(false);
    expect(masked.mask.containsPoint({ x: 1060, y: 620 })).toBe(false);
    actor.y = 595;
    masked.update();
    expect(masked.mask.containsPoint({ x: 1060, y: 510 })).toBe(true);
    expect(masked.mask.containsPoint({ x: 1060, y: 620 })).toBe(false);
    actor.y = 656;
    masked.update();
    expect(masked.mask.containsPoint({ x: 1060, y: 620 })).toBe(true);
    expect(isResidentHeadOccluded(actor.position, occlusion, RESIDENT_WORLD_SCALE)).toBe(false);
    masked.destroy();
    actor.destroy();
  });

  it("matches both fountain outlines without cutting gaps into the combined scenery mask", () => {
    const actor = new Container();
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    for (const depth of [450, 595, 656]) {
      actor.y = depth;
      masked.update();
      for (let y = 450.271; y < 680; y += 5) {
        for (let x = 940.137; x < 1180; x += 5) {
          const covering = parts.filter(item => pointInPolygon({ x: x - item.position.x, y: y - item.position.y }, item.outline!));
          expect(covering.length).toBeLessThanOrEqual(1);
          const hidden = covering.some(item => depth < item.depthY);
          expect(masked.mask.containsPoint({ x, y }), `fountain depth=${depth}, point=${x},${y}`).toBe(!hidden);
        }
      }
    }
    masked.destroy();
    actor.destroy();
  });
});

describe("west noticeboard occlusion", () => {
  const parts = occlusion.occluders.filter(item => item.id.startsWith("west-noticeboard-north-"));

  it("allows passing behind and around the sign while keeping its base solid", () => {
    for (const y of [380, 405, 460]) {
      for (const direction of [-1, 1]) {
        let position = { x: direction === 1 ? 310 : 475, y };
        for (let step = 0; step < 22; step++) position = moveCharacter(position, { x: direction, y: 0 }, 50, nav);
        expect(position).toEqual({ x: direction === 1 ? 475 : 310, y });
      }
    }
    expect(canStand({ x: 392, y: 432 }, nav)).toBe(false);
  });

  it("masks the sign face and stand while preserving the two openings", () => {
    const actor = new Container();
    actor.position.set(395, 405);
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    expect(masked.mask.containsPoint({ x: 395, y: 350 })).toBe(false);
    expect(masked.mask.containsPoint({ x: 395, y: 410 })).toBe(false);
    expect(masked.mask.containsPoint({ x: 395, y: 390 })).toBe(true);
    expect(masked.mask.containsPoint({ x: 395, y: 434 })).toBe(true);
    expect(isResidentHeadOccluded(actor.position, occlusion, RESIDENT_WORLD_SCALE)).toBe(true);
    actor.y = 444;
    masked.update();
    expect(masked.mask.containsPoint({ x: 395, y: 350 })).toBe(true);
    expect(isResidentHeadOccluded(actor.position, occlusion, RESIDENT_WORLD_SCALE)).toBe(false);
    masked.destroy();
    actor.destroy();
  });

  it("keeps the open wooden frame consistent in the combined scenery mask", () => {
    const actor = new Container();
    actor.y = 400;
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    for (let y = 280.271; y < 450; y += 3) {
      for (let x = 330.137; x < 460; x += 3) {
        const covering = parts.filter(item => pointInPolygon({ x: x - item.position.x, y: y - item.position.y }, item.outline!));
        expect(covering.length, `overlap at ${x},${y}`).toBeLessThanOrEqual(1);
        expect(masked.mask.containsPoint({ x, y }), `sign point=${x},${y}`).toBe(covering.length === 0);
      }
    }
    masked.destroy();
    actor.destroy();
  });
});

describe("west south map sign occlusion", () => {
  it("opens the route behind the sign while retaining its ground footprint", () => {
    for (const direction of [-1, 1]) {
      let position = { x: direction === 1 ? 250 : 415, y: 700 };
      for (let step = 0; step < 22; step++) position = moveCharacter(position, { x: direction, y: 0 }, 50, nav);
      expect(position).toEqual({ x: direction === 1 ? 415 : 250, y: 700 });
    }
    expect(canStand({ x: 330, y: 731 }, nav)).toBe(false);
    expect(canStand({ x: 330, y: 758 }, nav)).toBe(true);
  });

  it("preserves the frame gaps and restores the actor in front", () => {
    const actor = new Container();
    actor.position.set(330, 715);
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    for (const point of [{ x: 330, y: 660 }, { x: 280, y: 701 }, { x: 330, y: 716 }]) {
      expect(masked.mask.containsPoint(point)).toBe(false);
    }
    for (const point of [{ x: 305, y: 700 }, { x: 358, y: 700 }, { x: 330, y: 734 }]) {
      expect(masked.mask.containsPoint(point)).toBe(true);
    }
    expect(isResidentHeadOccluded(actor.position, occlusion, RESIDENT_WORLD_SCALE)).toBe(true);
    actor.y = 750;
    masked.update();
    expect(masked.mask.containsPoint({ x: 330, y: 660 })).toBe(true);
    expect(isResidentHeadOccluded(actor.position, occlusion, RESIDENT_WORLD_SCALE)).toBe(false);
    masked.destroy();
    actor.destroy();
  });
});

describe("west garden lamp and canopy", () => {
  it("allows crossing behind the canopy but keeps the garden barrier solid", () => {
    for (const direction of [-1, 1]) {
      let position = { x: direction === 1 ? 475 : 655, y: 620 };
      for (let step = 0; step < 24; step++) position = moveCharacter(position, { x: direction, y: 0 }, 50, nav);
      expect(position).toEqual({ x: direction === 1 ? 655 : 475, y: 620 });
    }
    expect(canStand({ x: 550, y: 662 }, nav)).toBe(false);
    expect(canStand({ x: 570, y: 850 }, nav)).toBe(false);
  });

  it("clips the lamp and foliage without covering the empty space alongside the lamp", () => {
    const actor = new Container();
    actor.position.set(550, 620);
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    expect(masked.mask.containsPoint({ x: 547, y: 530 })).toBe(false);
    expect(masked.mask.containsPoint({ x: 550, y: 605 })).toBe(false);
    expect(masked.mask.containsPoint({ x: 520, y: 540 })).toBe(true);
    actor.y = 670;
    masked.update();
    expect(masked.mask.containsPoint({ x: 547, y: 530 })).toBe(true);
    expect(masked.mask.containsPoint({ x: 550, y: 605 })).toBe(true);
    masked.destroy();
    actor.destroy();
  });
});

describe("west pavilion, lamp and grove", () => {
  it("allows passing behind scenery while blocking its ground supports", () => {
    for (const point of [{ x: 80, y: 380 }, { x: 255, y: 390 }, { x: 180, y: 620 }, { x: 90, y: 630 }]) {
      expect(canStand(point, nav), JSON.stringify(point)).toBe(true);
    }
    for (const point of [{ x: 80, y: 445 }, { x: 255, y: 435 }, { x: 171, y: 696 }, { x: 243, y: 645 }, { x: 12, y: 639 }, { x: 90, y: 668 }]) {
      expect(canStand(point, nav), JSON.stringify(point)).toBe(false);
    }
  });

  it("keeps all new silhouettes disjoint and consistent in the shared mask", () => {
    const actor = new Container();
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    for (const depth of [380, 461, 650, 710]) {
      actor.y = depth;
      masked.update();
      for (let y = 290.271; y < 715; y += 5) {
        for (let x = 0.137; x < 285; x += 5) {
          const covering = occlusion.occluders.filter(item => depth < item.depthY && pointInPolygon({
            x: x - item.position.x, y: y - item.position.y,
          }, item.outline!));
          expect(covering.length, `overlap ${x},${y}`).toBeLessThanOrEqual(1);
          expect(masked.mask.containsPoint({ x, y }), `depth=${depth}, ${x},${y}`).toBe(covering.length === 0);
        }
      }
    }
    masked.destroy();
    actor.destroy();
  });
});

describe("town hall roof and west boulder shrubs", () => {
  it("keeps the rear routes open and the hall and boulder footprints solid", () => {
    for (const y of [100, 430]) {
      let position = { x: y === 100 ? 900 : 680, y };
      const steps = y === 100 ? 40 : 20;
      for (let step = 0; step < steps; step++) position = moveCharacter(position, { x: 1, y: 0 }, 50, nav);
      expect(position).toEqual({ x: y === 100 ? 1200 : 830, y });
    }
    expect(canStand({ x: 1050, y: 220 }, nav)).toBe(false);
    expect(canStand({ x: 750, y: 474 }, nav)).toBe(false);
    expect(canStand({ x: 750, y: 510 }, nav)).toBe(true);
  });

  it("matches the roof and shrub outlines in the combined mask across depth changes", () => {
    const actor = new Container();
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    for (const depth of [100, 225, 430, 500]) {
      actor.y = depth;
      masked.update();
      for (let y = 10.271; y < 505; y += 7) {
        for (let x = 635.137; x < 1300; x += 7) {
          const hidden = occlusion.occluders.some(item => depth < item.depthY && pointInPolygon({
            x: x - item.position.x, y: y - item.position.y,
          }, item.outline!));
          expect(masked.mask.containsPoint({ x, y }), `depth=${depth}, ${x},${y}`).toBe(!hidden);
        }
      }
    }
    masked.destroy();
    actor.destroy();
  });
});

describe("east gate pine and bridge parapet", () => {
  it("opens the pine's rear while retaining roots, gate and canal barriers", () => {
    expect(canStand({ x: 1548, y: 210 }, nav)).toBe(true);
    expect(canStand({ x: 1548, y: 263 }, nav)).toBe(false);
    expect(canStand({ x: 1400, y: 210 }, nav)).toBe(false);
    expect(canStand({ x: 1970, y: 580 }, nav)).toBe(false);
    let position = { x: 1880, y: 500 };
    for (let step = 0; step < 20; step++) position = moveCharacter(position, { x: 1, y: 0 }, 50, nav);
    expect(position).toEqual({ x: 2030, y: 500 });
  });

  it("clips the tree and curved stone rail without covering the bridge deck", () => {
    const actor = new Container();
    actor.y = 210;
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    expect(masked.mask.containsPoint({ x: 1548, y: 170 })).toBe(false);
    actor.y = 500;
    masked.update();
    expect(masked.mask.containsPoint({ x: 1548, y: 170 })).toBe(true);
    expect(masked.mask.containsPoint({ x: 1965, y: 530 })).toBe(false);
    expect(masked.mask.containsPoint({ x: 1965, y: 495 })).toBe(true);
    expect(masked.mask.containsPoint({ x: 1965, y: 568 })).toBe(true);
    actor.y = 600;
    masked.update();
    expect(masked.mask.containsPoint({ x: 1965, y: 530 })).toBe(true);
    masked.destroy();
    actor.destroy();
  });
});

describe("southeast pine and path shrubs", () => {
  it("opens rear passage while keeping roots and the southern garden solid", () => {
    expect(canStand({ x: 1470, y: 755 }, nav)).toBe(true);
    expect(canStand({ x: 1580, y: 800 }, nav)).toBe(true);
    expect(canStand({ x: 1468, y: 799 }, nav)).toBe(false);
    expect(canStand({ x: 1580, y: 871 }, nav)).toBe(false);
    expect(canStand({ x: 1500, y: 950 }, nav)).toBe(false);
  });

  it("matches both silhouettes and leaves the path and cast shadow visible", () => {
    const actor = new Container();
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    for (const depth of [750, 806, 875]) {
      actor.y = depth;
      masked.update();
      for (let y = 600.271; y < 880; y += 5) {
        for (let x = 1410.137; x < 1660; x += 5) {
          const hidden = occlusion.occluders.some(item => depth < item.depthY && pointInPolygon({
            x: x - item.position.x, y: y - item.position.y,
          }, item.outline!));
          expect(masked.mask.containsPoint({ x, y }), `depth=${depth}, ${x},${y}`).toBe(!hidden);
        }
      }
    }
    masked.destroy();
    actor.destroy();
  });
});

describe("three southern lamps", () => {
  it("allows walking behind the poles while retaining bases and the fence", () => {
    for (const point of [{ x: 375, y: 845 }, { x: 875, y: 1080 }, { x: 1233, y: 1080 }]) {
      expect(canStand(point, nav), JSON.stringify(point)).toBe(true);
    }
    for (const point of [{ x: 375, y: 899 }, { x: 875, y: 1110 }, { x: 1233, y: 1110 }, { x: 300, y: 890 }]) {
      expect(canStand(point, nav), JSON.stringify(point)).toBe(false);
    }
  });

  it("clips lamp heads and poles and restores the foreground", () => {
    const actor = new Container();
    actor.y = 850;
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    for (const point of [{ x: 375, y: 820 }, { x: 875, y: 1055 }, { x: 1233, y: 1058 }]) {
      expect(masked.mask.containsPoint(point)).toBe(false);
    }
    expect(masked.mask.containsPoint({ x: 900, y: 1060 })).toBe(true);
    actor.y = 1130;
    masked.update();
    expect(masked.mask.containsPoint({ x: 875, y: 1055 })).toBe(true);
    expect(masked.mask.containsPoint({ x: 1233, y: 1058 })).toBe(true);
    masked.destroy();
    actor.destroy();
  });
});

describe("southern edge grove batch", () => {
  it("keeps the path open and blocks the two visible roots", () => {
    for (let y = 1080; y <= 1140; y += 10) expect(canStand({ x: 465, y }, nav)).toBe(true);
    expect(canStand({ x: 110, y: 1140 }, nav)).toBe(false);
    expect(canStand({ x: 260, y: 1145 }, nav)).toBe(false);
    expect(canStand({ x: 260, y: 1100 }, nav)).toBe(true);
  });

  it("matches the grouped canopy masks at the map boundary without hiding the path", () => {
    const actor = new Container();
    actor.y = 1100;
    const masked = createBakedActorOcclusion(actor, occlusion.occluders, { width: 2048, height: 1152 });
    for (let y = 950.271; y < 1152; y += 5) {
      for (let x = 0.137; x < 640; x += 5) {
        const hidden = occlusion.occluders.some(item => actor.y < item.depthY && pointInPolygon({
          x: x - item.position.x, y: y - item.position.y,
        }, item.outline!));
        expect(masked.mask.containsPoint({ x, y }), `${x},${y}`).toBe(!hidden);
      }
    }
    expect(masked.mask.containsPoint({ x: 465, y: 1120 })).toBe(true);
    masked.destroy();
    actor.destroy();
  });
});
