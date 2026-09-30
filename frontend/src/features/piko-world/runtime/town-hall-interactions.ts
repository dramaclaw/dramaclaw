// SPDX-License-Identifier: Elastic-2.0
import type { Point } from "./character-movement";
export const TOWN_HALL_NOTICES: Record<string, { approach: Point; message: string }> = {
  "hall-noticeboard": { approach: { x: 285, y: 460 }, message: "欢迎来到小镇。走累了，就在炉边坐一会儿吧。" },
  "hall-reading": { approach: { x: 495, y: 670 }, message: "书页里夹着一片干叶，窗边正是读书的好时候。" },
  "hall-reception": { approach: { x: 1230, y: 490 }, message: "来访簿摊在桌上，镇长正在庭院里迎接新朋友。" },
};
