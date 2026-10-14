// SPDX-License-Identifier: Elastic-2.0
import type { Point } from "./character-movement";
export const TOWN_HALL_NOTICES: Record<string, { approach: Point; messageKey: string }> = {
  "hall-noticeboard": { approach: { x: 285, y: 460 }, messageKey: "pikoWorld.hallNotices.hall-noticeboard" },
  "hall-reading": { approach: { x: 495, y: 670 }, messageKey: "pikoWorld.hallNotices.hall-reading" },
  "hall-reception": { approach: { x: 1230, y: 490 }, messageKey: "pikoWorld.hallNotices.hall-reception" },
};
