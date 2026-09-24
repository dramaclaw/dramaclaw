// SPDX-License-Identifier: Elastic-2.0
import { isPositionNavigable, type PikoPoint } from "./navigation-geometry";
import type { PikoNavigation } from "./map-package-schema";

export const CAT_HEART_FRAME = 0;
export const CAT_HEART_SRC = "animals/cat-heart-v1.png";
const ANIMAL_FOOTPRINT = [{ x: 0, y: 0 }, { x: -7, y: 0 }, { x: 7, y: 0 },
  { x: 0, y: -4 }, { x: 0, y: 4 }];
export function isAnimalPositionNavigable(point: PikoPoint, navigation: PikoNavigation): boolean {
  return ANIMAL_FOOTPRINT.every(offset => isPositionNavigable(
    { x: point.x + offset.x, y: point.y + offset.y }, navigation));
}

type Sheet = { src: string; anchors: readonly (readonly [number, number])[] };

/** Original 2048² sheets, read in row-major order. Anchors register feet (or butterfly thorax)
 * within each 1024² cell; transparent margins differ between rows and action sheets.
 * Do not independently fit each pose: grazing heads and closing wings must retain their scale.
 */
export const ANIMAL_SHEETS = {
  henWalk: { src: "animals/hen-walk-v1.png", anchors: [[525, 841], [460, 842], [525, 828], [460, 823]] },
  henPeck: { src: "animals/hen-peck-v1.png", anchors: [[515, 876], [456, 878], [530, 779], [465, 779]] },
  dogWalk: { src: "animals/dog-walk-v1.png", anchors: [[530, 960], [500, 940], [530, 810], [495, 810]] },
  dogBark: { src: "animals/dog-bark-v1.png", anchors: [[530, 920], [490, 920], [535, 789], [490, 793]] },
  calfChew: { src: "animals/calf-chew-v1.png", anchors: [[540, 858], [495, 858], [540, 813], [495, 814]] },
  calfGraze: { src: "animals/calf-graze-v1.png", anchors: [[540, 866], [490, 866], [540, 800], [490, 792]] },
  rabbitGraze: { src: "animals/rabbit-graze-v1.png", anchors: [[555, 879], [390, 879], [560, 735], [430, 735]] },
  catIdle: { src: "animals/cat-idle-v1.png", anchors: [[515, 862], [455, 874], [515, 784], [465, 774]] },
  squirrelEat: { src: "animals/squirrel-eat-v1.png", anchors: [[530, 893], [470, 895], [530, 833], [470, 833]] },
  butterflyFly: { src: "animals/butterfly-fly-v1.png", anchors: [[535, 665], [510, 720], [550, 650], [445, 670]] },
} as const satisfies Record<string, Sheet>;

export type AnimalClip = keyof typeof ANIMAL_SHEETS;
export type AnimalKind = "hen" | "dog" | "calf" | "rabbit" | "cat" | "squirrel" | "butterfly";
export type AnimalPlacement = {
  id: string;
  kind: AnimalKind;
  name?: string;
  position: PikoPoint;
  scale: number;
  facing?: 1 | -1;
  route?: readonly PikoPoint[];
  /** Initial idle time before roaming; randomized further for each instance. */
  initialPauseSeconds?: number;
  animationOffsetSeconds?: number;
};

/** Local habitats keep the central arrival, fountain interaction and exits clear. */
export const COURTYARD_ANIMALS: readonly AnimalPlacement[] = [
  { id: "west-lawn-calf", kind: "calf", position: { x: 137, y: 807 }, scale: 0.1064 },
  { id: "west-lawn-calf-2", kind: "calf", position: { x: 265, y: 822 }, scale: 0.1064,
    facing: -1, animationOffsetSeconds: 2.4 },
  { id: "fountain-west-hen-1", kind: "hen", position: { x: 755, y: 550 }, scale: 0.054,
    facing: 1, initialPauseSeconds: 1.2,
    route: [{ x: 788, y: 557 }, { x: 744, y: 573 }, { x: 755, y: 550 }] },
  { id: "fountain-west-hen-2", kind: "hen", position: { x: 904, y: 491 }, scale: 0.054,
    facing: -1, initialPauseSeconds: 3.8, animationOffsetSeconds: 0.8,
    route: [{ x: 870, y: 484 }, { x: 878, y: 515 }, { x: 904, y: 491 }] },
  { id: "riverside-hen", kind: "hen", position: { x: 1740, y: 762 }, scale: 0.054,
    facing: -1, initialPauseSeconds: 5.2, animationOffsetSeconds: 1.1,
    route: [{ x: 1718, y: 754 }, { x: 1728, y: 778 }, { x: 1740, y: 762 }] },
  { id: "fountain-path-dog", kind: "dog", name: "罐头", position: { x: 1185, y: 684 }, scale: 0.086,
    // Clockwise tour: east bank, northern garden, west lane, southern promenade, fountain.
    route: [
      { x: 1500, y: 610 }, { x: 1750, y: 545 }, { x: 1910, y: 530 },
      { x: 1750, y: 545 }, { x: 1700, y: 360 }, { x: 1610, y: 185 },
      { x: 1540, y: 95 }, { x: 1330, y: 85 }, { x: 1100, y: 95 },
      { x: 780, y: 110 }, { x: 690, y: 200 }, { x: 680, y: 360 },
      // Pass south of the pine fence instead of crossing its footprint.
      { x: 680, y: 490 }, { x: 480, y: 490 }, { x: 480, y: 350 }, { x: 300, y: 300 }, { x: 180, y: 220 },
      { x: 180, y: 480 }, { x: 420, y: 550 }, { x: 450, y: 780 },
      { x: 450, y: 970 }, { x: 300, y: 990 }, { x: 450, y: 1035 },
      { x: 700, y: 1060 }, { x: 1060, y: 1060 }, { x: 1650, y: 1050 },
      { x: 1690, y: 900 }, { x: 1650, y: 730 }, { x: 1500, y: 640 },
      { x: 1185, y: 684 },
    ] },
  { id: "southwest-grove-rabbit", kind: "rabbit", position: { x: 205, y: 982 }, scale: 0.058, facing: 1 },
  { id: "southeast-flowers-rabbit", kind: "rabbit", position: { x: 1700, y: 1050 }, scale: 0.058,
    facing: -1, animationOffsetSeconds: 3.2 },
  { id: "northwest-lawn-cat", kind: "cat", name: "小月亮", position: { x: 555, y: 108 }, scale: 0.0648, facing: -1 },
  { id: "northeast-lawn-squirrel", kind: "squirrel", position: { x: 1472, y: 111 }, scale: 0.059 },
  { id: "west-flowers-butterfly-1", kind: "butterfly", position: { x: 700, y: 826 }, scale: 0.019 },
  { id: "west-flowers-butterfly-2", kind: "butterfly", position: { x: 745, y: 860 }, scale: 0.016 },
  { id: "west-flowers-butterfly-3", kind: "butterfly", position: { x: 672, y: 875 }, scale: 0.017 },
  { id: "east-flowers-butterfly-1", kind: "butterfly", position: { x: 1395, y: 853 }, scale: 0.018 },
  { id: "east-flowers-butterfly-2", kind: "butterfly", position: { x: 1440, y: 874 }, scale: 0.015 },
  { id: "northwest-flowers-butterfly", kind: "butterfly", position: { x: 548, y: 218 }, scale: 0.018 },
  { id: "noticeboard-flowers-butterfly", kind: "butterfly", position: { x: 298, y: 393 }, scale: 0.017 },
  { id: "east-tree-flowers-butterfly", kind: "butterfly", position: { x: 1402, y: 466 }, scale: 0.018 },
  { id: "riverside-flowers-butterfly", kind: "butterfly", position: { x: 1724, y: 710 }, scale: 0.017 },
];

/** Artisan-market: hens near workshop/stall, rabbits by trees, butterflies near flowers. */
export const ARTISAN_MARKET_ANIMALS: readonly AnimalPlacement[] = [
  // Hens foraging near the workshop and market stall
  { id: "market-workshop-hen-1", kind: "hen", position: { x: 720, y: 420 }, scale: 0.054,
    facing: 1, initialPauseSeconds: 2.0,
    route: [{ x: 750, y: 430 }, { x: 700, y: 440 }, { x: 720, y: 420 }] },
  { id: "market-workshop-hen-2", kind: "hen", position: { x: 650, y: 430 }, scale: 0.054,
    facing: -1, initialPauseSeconds: 4.5, animationOffsetSeconds: 1.2,
    route: [{ x: 680, y: 440 }, { x: 630, y: 450 }, { x: 650, y: 430 }] },
  { id: "market-stall-hen-1", kind: "hen", position: { x: 1520, y: 470 }, scale: 0.054,
    facing: 1, initialPauseSeconds: 3.0, animationOffsetSeconds: 0.6,
    route: [{ x: 1550, y: 480 }, { x: 1500, y: 490 }, { x: 1520, y: 470 }] },
  { id: "market-stall-hen-2", kind: "hen", position: { x: 1600, y: 450 }, scale: 0.054,
    facing: -1, initialPauseSeconds: 2.5, animationOffsetSeconds: 1.5,
    route: [{ x: 1630, y: 460 }, { x: 1580, y: 470 }, { x: 1600, y: 450 }] },
  { id: "market-east-hen", kind: "hen", position: { x: 1700, y: 580 }, scale: 0.054,
    facing: 1, initialPauseSeconds: 1.5, animationOffsetSeconds: 0.3,
    route: [{ x: 1730, y: 590 }, { x: 1680, y: 600 }, { x: 1700, y: 580 }] },
  { id: "market-west-hen", kind: "hen", position: { x: 900, y: 700 }, scale: 0.054,
    facing: -1, initialPauseSeconds: 6.0, animationOffsetSeconds: 1.8,
    route: [{ x: 930, y: 710 }, { x: 880, y: 720 }, { x: 900, y: 700 }] },
  // Hens in upper forest lawn area
  { id: "market-forest-hen-1", kind: "hen", position: { x: 450, y: 200 }, scale: 0.054,
    facing: 1, initialPauseSeconds: 3.5, animationOffsetSeconds: 0.8,
    route: [{ x: 480, y: 210 }, { x: 430, y: 220 }, { x: 450, y: 200 }] },
  { id: "market-forest-hen-2", kind: "hen", position: { x: 1200, y: 180 }, scale: 0.054,
    facing: -1, initialPauseSeconds: 4.0, animationOffsetSeconds: 2.2,
    route: [{ x: 1230, y: 190 }, { x: 1180, y: 200 }, { x: 1200, y: 180 }] },
  // Rabbits near trees and bushes
  { id: "market-left-tree-rabbit", kind: "rabbit", position: { x: 480, y: 650 }, scale: 0.058,
    facing: 1, animationOffsetSeconds: 1.5 },
  { id: "market-right-tree-rabbit", kind: "rabbit", position: { x: 1450, y: 650 }, scale: 0.058,
    facing: -1, animationOffsetSeconds: 3.8 },
  { id: "market-southwest-rabbit", kind: "rabbit", position: { x: 280, y: 900 }, scale: 0.058,
    facing: 1, animationOffsetSeconds: 2.2 },
  { id: "market-southeast-rabbit", kind: "rabbit", position: { x: 1720, y: 900 }, scale: 0.058,
    facing: -1, animationOffsetSeconds: 4.5 },
  // Rabbits in upper forest area
  { id: "market-forest-rabbit-1", kind: "rabbit", position: { x: 350, y: 150 }, scale: 0.058,
    facing: 1, animationOffsetSeconds: 1.0 },
  { id: "market-forest-rabbit-2", kind: "rabbit", position: { x: 1400, y: 160 }, scale: 0.058,
    facing: -1, animationOffsetSeconds: 2.8 },
  // Squirrel in lower-left grass lawn area
  { id: "market-lawn-squirrel", kind: "squirrel", position: { x: 180, y: 900 }, scale: 0.059,
    facing: 1, animationOffsetSeconds: 1.5 },
  // Butterflies near flower patches
  { id: "market-workshop-butterfly-1", kind: "butterfly", position: { x: 760, y: 310 }, scale: 0.018 },
  { id: "market-workshop-butterfly-2", kind: "butterfly", position: { x: 740, y: 330 }, scale: 0.016 },
  { id: "market-house-butterfly", kind: "butterfly", position: { x: 1310, y: 300 }, scale: 0.017 },
  { id: "market-stall-butterfly-1", kind: "butterfly", position: { x: 1630, y: 380 }, scale: 0.017 },
  { id: "market-stall-butterfly-2", kind: "butterfly", position: { x: 1660, y: 410 }, scale: 0.015 },
  { id: "market-left-tree-butterfly", kind: "butterfly", position: { x: 610, y: 630 }, scale: 0.018 },
  { id: "market-right-tree-butterfly", kind: "butterfly", position: { x: 1450, y: 630 }, scale: 0.016 },
  { id: "market-east-butterfly", kind: "butterfly", position: { x: 1800, y: 380 }, scale: 0.018 },
  { id: "market-west-butterfly", kind: "butterfly", position: { x: 200, y: 420 }, scale: 0.016 },
  { id: "market-south-butterfly-1", kind: "butterfly", position: { x: 380, y: 900 }, scale: 0.017 },
  { id: "market-south-butterfly-2", kind: "butterfly", position: { x: 1600, y: 900 }, scale: 0.018 },
  { id: "market-forest-butterfly-1", kind: "butterfly", position: { x: 500, y: 180 }, scale: 0.017 },
  { id: "market-forest-butterfly-2", kind: "butterfly", position: { x: 1150, y: 200 }, scale: 0.016 },
  { id: "market-left-bench-butterfly", kind: "butterfly", position: { x: 600, y: 540 }, scale: 0.017 },
  { id: "market-right-bench-butterfly", kind: "butterfly", position: { x: 1200, y: 560 }, scale: 0.016 },
];

/** Canal street: hens forage by the two homes; rabbits and squirrels stay in the bank-side groves. */
export const LANTERN_CANAL_ANIMALS: readonly AnimalPlacement[] = [
  { id: "canal-west-cottage-hen-1", kind: "hen", position: { x: 560, y: 520 }, scale: 0.054,
    facing: 1, initialPauseSeconds: 2.1,
    route: [{ x: 585, y: 530 }, { x: 545, y: 540 }, { x: 560, y: 520 }] },
  { id: "canal-west-cottage-hen-2", kind: "hen", position: { x: 680, y: 495 }, scale: 0.054,
    facing: -1, initialPauseSeconds: 4.3, animationOffsetSeconds: 1.1,
    route: [{ x: 700, y: 510 }, { x: 655, y: 510 }, { x: 680, y: 495 }] },
  { id: "canal-east-cottage-hen-1", kind: "hen", position: { x: 1510, y: 485 }, scale: 0.054,
    facing: 1, initialPauseSeconds: 3.4, animationOffsetSeconds: 0.7,
    route: [{ x: 1535, y: 500 }, { x: 1480, y: 505 }, { x: 1510, y: 485 }] },
  { id: "canal-east-cottage-hen-2", kind: "hen", position: { x: 1720, y: 550 }, scale: 0.054,
    facing: -1, initialPauseSeconds: 5.0, animationOffsetSeconds: 1.9,
    route: [{ x: 1750, y: 560 }, { x: 1695, y: 570 }, { x: 1720, y: 550 }] },
  { id: "canal-southwest-rabbit", kind: "rabbit", position: { x: 490, y: 755 }, scale: 0.058,
    facing: 1, animationOffsetSeconds: 1.5 },
  { id: "canal-west-bank-rabbit", kind: "rabbit", position: { x: 705, y: 700 }, scale: 0.058,
    facing: -1, animationOffsetSeconds: 3.1 },
  { id: "canal-east-meadow-rabbit", kind: "rabbit", position: { x: 1640, y: 760 }, scale: 0.058,
    facing: -1, animationOffsetSeconds: 4.2 },
  { id: "canal-northwest-squirrel", kind: "squirrel", position: { x: 245, y: 185 }, scale: 0.059,
    facing: 1, animationOffsetSeconds: 0.7 },
  { id: "canal-north-grove-squirrel", kind: "squirrel", position: { x: 760, y: 90 }, scale: 0.059,
    facing: -1, animationOffsetSeconds: 2.3 },
  { id: "canal-east-grove-squirrel", kind: "squirrel", position: { x: 1810, y: 250 }, scale: 0.059,
    facing: -1, animationOffsetSeconds: 3.5 },
];

export const ANIMAL_FRAME_SECONDS: Record<AnimalClip, readonly number[]> = {
  henWalk: [0.19, 0.19, 0.19, 0.19], henPeck: [0.55, 0.32, 0.14, 0.48],
  dogWalk: [0.18, 0.18, 0.18, 0.18], dogBark: [0.48, 0.16, 0.18, 0.42],
  calfChew: [1.15, 0.8, 0.95, 1.1], calfGraze: [1.35, 1.1, 0.9, 1.2],
  rabbitGraze: [5.2, 0.45, 1.7, 0.5], catIdle: [2.2, 0.75, 4.8, 1.2],
  squirrelEat: [1.4, 0.3, 0.45, 0.75], butterflyFly: [0.12, 0.09, 0.1, 0.1],
};

export function animalClipDuration(clip: AnimalClip) {
  return ANIMAL_FRAME_SECONDS[clip].reduce((sum, duration) => sum + duration, 0);
}

export function animalFrameAt(clip: AnimalClip, seconds: number) {
  const duration = animalClipDuration(clip);
  let remaining = ((seconds % duration) + duration) % duration;
  const timings = ANIMAL_FRAME_SECONDS[clip];
  for (let index = 0; index < timings.length; index++) {
    if (remaining < timings[index]) return index;
    remaining -= timings[index];
  }
  return 0;
}

const IDLE_CLIPS: Record<AnimalKind, AnimalClip> = {
  hen: "henPeck", dog: "dogBark", calf: "calfGraze", rabbit: "rabbitGraze",
  cat: "catIdle", squirrel: "squirrelEat", butterfly: "butterflyFly",
};

/** A bounded habitat controller, independent of rendering. Only walking clips translate feet. */
export function createAnimalMotion(placement: AnimalPlacement, random: () => number = Math.random,
  canMove: (point: PikoPoint) => boolean = () => true) {
  const roaming = Boolean(placement.route?.length);
  let routeIndex = 0;
  let walking = roaming && placement.initialPauseSeconds === undefined;
  let elapsed = (walking ? 0 : random() * animalClipDuration(IDLE_CLIPS[placement.kind]))
    + (placement.animationOffsetSeconds ?? 0);
  let remaining = placement.initialPauseSeconds !== undefined
    ? placement.initialPauseSeconds + random() * 1.2 : 10 + random() * 9;
  const state = { position: { ...placement.position }, facing: placement.facing ?? 1,
    clip: walking ? (placement.kind === "dog" ? "dogWalk" : "henWalk") as AnimalClip : IDLE_CLIPS[placement.kind],
    frame: 0, lift: placement.kind === "butterfly" ? 18 : 0 };
  const phase = random() * Math.PI * 2;
  const tempo = placement.kind === "butterfly" ? 0.85 + random() * 0.3 : 0.94 + random() * 0.12;
  const pause = () => {
    walking = false;
    state.clip = IDLE_CLIPS[placement.kind];
    elapsed = 0;
    remaining = animalClipDuration(state.clip) * (placement.kind === "dog" ? 2 : 1 + Math.floor(random() * 3));
  };
  return { state, update(delta: number) {
    const previousElapsed = elapsed;
    elapsed += delta * tempo;
    if (roaming) {
      if (walking) {
        const target = placement.route![routeIndex];
        const dx = target.x - state.position.x, dy = target.y - state.position.y;
        const distance = Math.hypot(dx, dy);
        const step = Math.min(distance, delta * (placement.kind === "dog" ? 23 : 11));
        if (Math.abs(dx) > 0.5) state.facing = dx > 0 ? 1 : -1;
        const next = distance > 0 ? { x: state.position.x + dx / distance * step,
          y: state.position.y + dy / distance * step } : { ...state.position };
        if (canMove(next)) state.position = next;
        else { routeIndex = (routeIndex + 1) % placement.route!.length; pause(); }
        if (walking && distance <= step) {
          routeIndex = (routeIndex + 1) % placement.route!.length;
          pause();
        }
      } else {
        remaining -= delta * tempo;
        if (remaining <= 0) {
          walking = true;
          state.clip = placement.kind === "dog" ? "dogWalk" : "henWalk";
          elapsed = 0;
        }
      }
    } else if (placement.kind === "calf") {
      remaining -= delta;
      // Switch only at a completed loop so the head does not snap out of a bite.
      if (remaining <= 0 && Math.floor(elapsed / animalClipDuration(state.clip))
        > Math.floor(previousElapsed / animalClipDuration(state.clip))) {
        state.clip = state.clip === "calfGraze" ? "calfChew" : "calfGraze";
        remaining = state.clip === "calfGraze" ? 12 + random() * 10 : 5 + random() * 5;
        elapsed = 0;
      }
    } else if (placement.kind === "butterfly") {
      const angle = elapsed * 0.46 + phase;
      state.position = { x: placement.position.x + Math.sin(angle) * 23,
        y: placement.position.y + Math.sin(angle * 0.73 + phase) * 12 };
      state.lift = 18 + Math.sin(elapsed * 1.8 + phase) * 5;
      state.facing = Math.cos(angle) >= 0 ? 1 : -1;
    }
    state.frame = animalFrameAt(state.clip, elapsed);
  } };
}
