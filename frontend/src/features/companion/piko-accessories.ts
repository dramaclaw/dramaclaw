// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { MyBuddyAction } from "@/features/companion/mybuddy-actions";

export type PikoAccessoryId =
  | "none"
  | "piko-accessory-golden-hoop-staff"
  | "piko-accessory-little-king"
  | "piko-accessory-bubble-balloon"
  | "piko-accessory-cyan-energy-sword"
  | "piko-accessory-mengnan-wand"
  | "piko-accessory-odin-hammer"
  | "piko-accessory-fire-tipped-spear"
  | "piko-accessory-dumbbell"
  | "piko-accessory-thumbs-up"
  | "piko-accessory-code-ling"
  | "piko-accessory-code-yu"
  | "piko-accessory-code-xia"
  | "piko-accessory-code-ning"
  | "piko-accessory-founder-medal"
  | "piko-accessory-red-star"
  | "piko-accessory-dark-knight-mask"
  | "piko-accessory-azu-mask"
  | "piko-accessory-red-bow"
  | "piko-accessory-minion-goggles"
  | "piko-accessory-diver-goggles"
  | "piko-accessory-gourd"
  | "piko-accessory-judy-carrot"
  | "piko-accessory-pacifier"
  | "piko-accessory-wizard-hat"
  | "piko-accessory-bamboo-hat"
  | "piko-accessory-asgard-horns"
  | "piko-accessory-gary-snail"
  | "piko-accessory-captain-shield"
  | "piko-accessory-luban-compass"
  | "piko-accessory-luban-talisman"
  | "piko-accessory-red-cape"
  | "piko-accessory-ufo-pet"
  | "piko-accessory-ghost-pet";
export type PikoAccessorySlot = "hand" | "face" | "head" | "body" | "mouth" | "back" | "front";

export type PikoAccessoryLayer = {
  src: string;
  slot: PikoAccessorySlot;
  x: number;
  y: number;
  size: number;
  rotate?: number;
};

export type PikoAccessoryConfig = PikoAccessoryLayer & {
  disabledActions?: readonly MyBuddyAction[];
  attachments?: readonly PikoAccessoryLayer[];
};

export const PIKO_ACCESSORY_DISPLAY_OPTIONS = [
  { id: "none", labelKey: "myBuddy.debug.accessories.none" },
  {
    id: "piko-accessory-golden-hoop-staff",
    labelKey: "myBuddy.debug.accessories.goldenHoopStaff",
  },
  {
    id: "piko-accessory-little-king",
    labelKey: "myBuddy.debug.accessories.littleKing",
  },
  {
    id: "piko-accessory-bubble-balloon",
    labelKey: "myBuddy.debug.accessories.bubbleBalloon",
  },
  {
    id: "piko-accessory-cyan-energy-sword",
    labelKey: "myBuddy.debug.accessories.cyanEnergySword",
  },
  {
    id: "piko-accessory-mengnan-wand",
    labelKey: "myBuddy.debug.accessories.mengnanWand",
  },
  {
    id: "piko-accessory-odin-hammer",
    labelKey: "myBuddy.debug.accessories.odinHammer",
  },
  {
    id: "piko-accessory-fire-tipped-spear",
    labelKey: "myBuddy.debug.accessories.fireTippedSpear",
  },
  { id: "piko-accessory-dumbbell", labelKey: "myBuddy.debug.accessories.dumbbell" },
  {
    id: "piko-accessory-thumbs-up",
    labelKey: "myBuddy.debug.accessories.thumbsUp",
  },
  { id: "piko-accessory-code-ling", labelKey: "myBuddy.debug.accessories.codeLing" },
  { id: "piko-accessory-code-yu", labelKey: "myBuddy.debug.accessories.codeYu" },
  { id: "piko-accessory-code-xia", labelKey: "myBuddy.debug.accessories.codeXia" },
  { id: "piko-accessory-code-ning", labelKey: "myBuddy.debug.accessories.codeNing" },
  {
    id: "piko-accessory-founder-medal",
    labelKey: "myBuddy.debug.accessories.founderMedal",
  },
  {
    id: "piko-accessory-red-star",
    labelKey: "myBuddy.debug.accessories.redStar",
  },
  {
    id: "piko-accessory-dark-knight-mask",
    labelKey: "myBuddy.debug.accessories.darkKnightMask",
  },
  { id: "piko-accessory-azu-mask", labelKey: "myBuddy.debug.accessories.azuMask" },
  { id: "piko-accessory-red-bow", labelKey: "myBuddy.debug.accessories.redBow" },
  {
    id: "piko-accessory-minion-goggles",
    labelKey: "myBuddy.debug.accessories.minionGoggles",
  },
  {
    id: "piko-accessory-diver-goggles",
    labelKey: "myBuddy.debug.accessories.diverGoggles",
  },
  { id: "piko-accessory-gourd", labelKey: "myBuddy.debug.accessories.gourd" },
  { id: "piko-accessory-judy-carrot", labelKey: "myBuddy.debug.accessories.judyCarrot" },
  { id: "piko-accessory-pacifier", labelKey: "myBuddy.debug.accessories.pacifier" },
  {
    id: "piko-accessory-wizard-hat",
    labelKey: "myBuddy.debug.accessories.wizardHat",
  },
  {
    id: "piko-accessory-bamboo-hat",
    labelKey: "myBuddy.debug.accessories.bambooHat",
  },
  {
    id: "piko-accessory-asgard-horns",
    labelKey: "myBuddy.debug.accessories.asgardHorns",
  },
  { id: "piko-accessory-gary-snail", labelKey: "myBuddy.debug.accessories.garySnail" },
  {
    id: "piko-accessory-captain-shield",
    labelKey: "myBuddy.debug.accessories.captainShield",
  },
  {
    id: "piko-accessory-luban-compass",
    labelKey: "myBuddy.debug.accessories.lubanCompass",
  },
  {
    id: "piko-accessory-luban-talisman",
    labelKey: "myBuddy.debug.accessories.lubanTalisman",
  },
  { id: "piko-accessory-red-cape", labelKey: "myBuddy.debug.accessories.redCape" },
  {
    id: "piko-accessory-ufo-pet",
    labelKey: "myBuddy.debug.accessories.ufoPet",
  },
  {
    id: "piko-accessory-ghost-pet",
    labelKey: "myBuddy.debug.accessories.ghostPet",
  },
] as const satisfies readonly { id: PikoAccessoryId; labelKey: string }[];

export type PikoAccessoryDisplayId = (typeof PIKO_ACCESSORY_DISPLAY_OPTIONS)[number]["id"];

export const PIKO_ACCESSORIES = {
  "piko-accessory-golden-hoop-staff": {
    src: "/piko/accessories/staff-golden-hoop.png",
    slot: "hand",
    x: -16,
    y: -4,
    size: 44,
    rotate: -90,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
    attachments: [
      {
        src: "/piko/accessories/plume-wukong.png",
        slot: "head",
        x: 13,
        y: -11,
        size: 30,
      },
    ],
  },
  "piko-accessory-little-king": {
    src: "/piko/accessories/scepter-little-king.png",
    slot: "hand",
    x: -16,
    y: -2,
    size: 42,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
    attachments: [
      {
        src: "/piko/accessories/crown-little-king.png",
        slot: "head",
        x: 13,
        y: -9,
        size: 30,
      },
      {
        src: "/piko/accessories/mustache-little-king.png",
        slot: "mouth",
        x: 18,
        y: 16,
        size: 25,
      },
    ],
  },
  "piko-accessory-bubble-balloon": {
    src: "/piko/accessories/balloon-bubble.png",
    slot: "hand",
    x: -20,
    y: -6,
    size: 42,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
  },
  "piko-accessory-cyan-energy-sword": {
    src: "/piko/accessories/sword-cyan.png",
    slot: "hand",
    x: 46,
    y: 5,
    size: 22,
    rotate: -8,
    disabledActions: ["count-stars", "watch-meteor", "fish", "blow-bubbles", "flag", "repair"],
    attachments: [
      {
        src: "/piko/accessories/pet-boar-yuntianhe.png",
        slot: "front",
        x: 64,
        y: 12,
        size: 38,
      },
    ],
  },
  "piko-accessory-mengnan-wand": {
    src: "/piko/accessories/wand-mengnan.png",
    slot: "hand",
    x: 42,
    y: 1,
    size: 30,
    rotate: -8,
    disabledActions: ["count-stars", "watch-meteor", "fish", "blow-bubbles", "flag", "repair"],
    attachments: [
      {
        src: "/piko/accessories/headband-mengnan.png",
        slot: "head",
        x: 7,
        y: -6,
        size: 36,
      },
    ],
  },
  "piko-accessory-odin-hammer": {
    src: "/piko/accessories/hammer-odin.png",
    slot: "hand",
    x: 43,
    y: -1,
    size: 32,
    rotate: -8,
    disabledActions: ["count-stars", "watch-meteor", "fish", "blow-bubbles", "flag", "repair"],
  },
  "piko-accessory-fire-tipped-spear": {
    src: "/piko/accessories/spear-fire-tip.png",
    slot: "hand",
    x: -19,
    y: -2,
    size: 48,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
  },
  "piko-accessory-dumbbell": {
    src: "/piko/accessories/dumbbell.png",
    slot: "hand",
    x: -19,
    y: 0,
    size: 42,
    rotate: 90,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
  },
  "piko-accessory-thumbs-up": {
    src: "/piko/accessories/thumbs-up.png",
    slot: "hand",
    x: 44,
    y: 7,
    size: 28,
    rotate: -8,
    disabledActions: ["count-stars", "watch-meteor", "fish", "blow-bubbles", "flag", "repair"],
  },
  "piko-accessory-code-ling": {
    src: "/piko/accessories/code-ling.png",
    slot: "hand",
    x: -16,
    y: 6,
    size: 26,
    rotate: -10,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
  },
  "piko-accessory-code-yu": {
    src: "/piko/accessories/code-yu.png",
    slot: "hand",
    x: -16,
    y: 6,
    size: 26,
    rotate: -10,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
  },
  "piko-accessory-code-xia": {
    src: "/piko/accessories/code-xia.png",
    slot: "hand",
    x: -16,
    y: 6,
    size: 26,
    rotate: -10,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
  },
  "piko-accessory-code-ning": {
    src: "/piko/accessories/code-ning.png",
    slot: "hand",
    x: -16,
    y: 6,
    size: 26,
    rotate: -10,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
  },
  "piko-accessory-founder-medal": {
    src: "/piko/accessories/medal-founder.png",
    slot: "face",
    x: 2,
    y: -6,
    size: 28,
    rotate: -18,
  },
  "piko-accessory-red-star": {
    src: "/piko/accessories/red-star-sparkle.png",
    slot: "face",
    x: 2,
    y: -6,
    size: 28,
    rotate: -18,
  },
  "piko-accessory-dark-knight-mask": {
    src: "/piko/accessories/mask-dark-knight.png",
    slot: "face",
    x: 6,
    y: -3,
    size: 32,
    rotate: -18,
  },
  "piko-accessory-azu-mask": {
    src: "/piko/accessories/mask-azu.png",
    slot: "face",
    x: 4,
    y: -2,
    size: 32,
    rotate: -18,
  },
  "piko-accessory-red-bow": {
    src: "/piko/accessories/bow-red.png",
    slot: "face",
    x: 4,
    y: -2,
    size: 32,
    rotate: -18,
  },
  "piko-accessory-minion-goggles": {
    src: "/piko/accessories/goggles-minion.png",
    slot: "face",
    x: 8,
    y: -4,
    size: 26,
    rotate: -12,
  },
  "piko-accessory-diver-goggles": {
    src: "/piko/accessories/goggles-diver.png",
    slot: "face",
    x: 6,
    y: -4,
    size: 34,
    rotate: -10,
  },
  "piko-accessory-gourd": {
    src: "/piko/accessories/gourd.png",
    slot: "face",
    x: 6,
    y: -8,
    size: 28,
    rotate: -12,
  },
  "piko-accessory-judy-carrot": {
    src: "/piko/accessories/carrot-judy.png",
    slot: "face",
    x: 7,
    y: -7,
    size: 28,
    rotate: -14,
  },
  "piko-accessory-pacifier": {
    src: "/piko/accessories/pacifier.png",
    slot: "mouth",
    x: 21,
    y: 24,
    size: 20,
    rotate: -8,
    disabledActions: ["read-map", "blow-bubbles", "typing"],
  },
  "piko-accessory-wizard-hat": {
    src: "/piko/accessories/hat-wizard.png",
    slot: "head",
    x: 5,
    y: -13,
    size: 34,
    rotate: -10,
  },
  "piko-accessory-bamboo-hat": {
    src: "/piko/accessories/hat-bamboo.png",
    slot: "head",
    x: 8,
    y: -16,
    size: 42,
  },
  "piko-accessory-asgard-horns": {
    src: "/piko/accessories/horns-asgard.png",
    slot: "head",
    x: 10,
    y: -17,
    size: 38,
  },
  "piko-accessory-gary-snail": {
    src: "/piko/accessories/snail-gary.png",
    slot: "head",
    x: 16,
    y: -10,
    size: 26,
  },
  "piko-accessory-captain-shield": {
    src: "/piko/accessories/shield-captain.png",
    slot: "body",
    x: -3,
    y: 16,
    size: 24,
    rotate: -8,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
  },
  "piko-accessory-luban-compass": {
    src: "/piko/accessories/luban-compass.png",
    slot: "body",
    x: -3,
    y: 16,
    size: 24,
    rotate: -8,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
  },
  "piko-accessory-luban-talisman": {
    src: "/piko/accessories/luban-talisman.png",
    slot: "body",
    x: -3,
    y: 16,
    size: 24,
    rotate: -8,
    disabledActions: ["sleep", "carry-box", "read-map", "typing"],
  },
  "piko-accessory-red-cape": {
    src: "/piko/accessories/cape-red.png",
    slot: "back",
    x: -21,
    y: 7,
    size: 42,
    rotate: -6,
  },
  "piko-accessory-ufo-pet": {
    src: "/piko/accessories/pet-ufo.png",
    slot: "back",
    x: -23,
    y: -9,
    size: 32,
  },
  "piko-accessory-ghost-pet": {
    src: "/piko/accessories/pet-ghost.png",
    slot: "back",
    x: -21,
    y: -11,
    size: 31,
  },
} as const satisfies Record<Exclude<PikoAccessoryId, "none">, PikoAccessoryConfig>;
