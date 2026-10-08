// SPDX-License-Identifier: Elastic-2.0
import type { PikoResidentId } from "./piko-residents";
import type { Point } from "./runtime/character-movement";

export type PikoTownNpc = {
  id: string;
  residentId: PikoResidentId;
  nickname: string;
  bio: string;
  greeting: string;
  mapId: string;
  position: Point;
  idleOffsetMs: number;
  scale?: number;
};

export const PIKO_TOWN_NPCS: readonly PikoTownNpc[] = [
  { id: "town-m01", residentId: "m01", nickname: "阿砚", bio: "住在市集，喜欢手作和热闹的街坊生活。",
    greeting: "刚做好一件小玩意儿，要来工坊看看吗？",
    mapId: "artisan-market", position: { x: 810, y: 435 }, idleOffsetMs: 0 },
  { id: "town-f01", residentId: "f01", nickname: "小苔", bio: "喜欢庭院里的花，也喜欢认识新朋友。",
    greeting: "今天的花开得真好，真想分你一缕花香。",
    mapId: "artisan-market", position: { x: 1230, y: 430 }, idleOffsetMs: 2700 },
  { id: "town-m02", residentId: "m02", nickname: "阿川", bio: "住在灯河街，随身带着修补工具。",
    greeting: "河边风大，我再去看看灯笼挂牢了没有。",
    mapId: "lantern-canal-street", position: { x: 1420, y: 432 }, scale: 0.9, idleOffsetMs: 1300 },
  { id: "hall-bookkeeper", residentId: "f02", nickname: "书禾", bio: "照看大厅的书架，喜欢收集小镇的旧故事。",
    greeting: "这本书里藏着小镇的旧故事，要不要一起翻几页？",
    mapId: "town-hall-interior", position: { x: 1630, y: 425 }, idleOffsetMs: 700 },
];

export const townNpcsForMap = (mapId: string) => PIKO_TOWN_NPCS.filter(npc => npc.mapId === mapId);
export const townNpcIdleSrc = (npc: PikoTownNpc) => `/piko/world/characters/town-npcs-hd-v1/${npc.residentId}-idle.png`;
