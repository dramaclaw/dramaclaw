// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

const MAP_TITLE_ROOT = "/piko/world/ui/map-titles";

export const PIKO_MAP_TRANSITIONS = {
  "welcome-courtyard": {
    title: "初遇庭院",
    subtitle: "风从泉水边带来问候",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-welcome-courtyard-v1.png`,
  },
  "artisan-market": {
    title: "匠作市集",
    subtitle: "木香与笑声落在棚影间",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-artisan-market-v1.png`,
  },
  "lantern-canal-street": {
    title: "灯河街",
    subtitle: "灯火沿着水声醒来",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-lantern-canal-street-v1.png`,
  },
  "wind-garden-gate": {
    title: "风庭门",
    subtitle: "风从花架吹向远方",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-wind-garden-gate-v1.png`,
  },
  "starlight-dock": {
    title: "星灯码头",
    subtitle: "微光随晚潮靠岸",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-starlight-dock-v1.png`,
  },
  "whispering-meadow": {
    title: "低语草甸",
    subtitle: "风声漫过高草与长天",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-whispering-meadow-v1.png`,
  },
  "starfall-tidal-wetland": {
    title: "星落潮汐湿地",
    subtitle: "星光停在潮池之间",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-starfall-tidal-wetland-v1.png`,
  },
  "cloudtop-slope": {
    title: "云顶坡",
    subtitle: "云影走远，星光抵达",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-cloudtop-slope-v1.png`,
  },
  "amber-wilds": {
    title: "琥珀原野",
    subtitle: "金色草浪守着旧时光",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-amber-wilds-v1.png`,
  },
  "startrace-coast": {
    title: "星痕海岸",
    subtitle: "潮水退去，星光仍在",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-startrace-coast-v1.png`,
  },
  "changfeng-sea": {
    title: "长风海境",
    subtitle: "长风渐远，海天无声",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-changfeng-sea-v1.png`,
  },
  "boundless-sea": {
    title: "无垠海域",
    subtitle: "小帆驶向海天尽头",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-boundless-sea-v1.png`,
  },
  "whispering-forest": {
    title: "低语森林",
    subtitle: "风声在树环间停留",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-whispering-forest-v1.png`,
  },
  "frostmoon-tundra": {
    title: "霜月苔原",
    subtitle: "月光让冰原安静发亮",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-frostmoon-tundra-v1.png`,
  },
  "crimson-canyon": {
    title: "赤霞峡谷",
    subtitle: "夕光沿着岩壁远行",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-crimson-canyon-v1.png`,
  },
  "whalesong-skyport": {
    title: "鲸歌天港",
    subtitle: "鲸歌从云海深处传来",
    src: `${MAP_TITLE_ROOT}/piko-world-map-title-whalesong-skyport-v1.png`,
  },
} as const;

export type PikoMapId = keyof typeof PIKO_MAP_TRANSITIONS;

export function isPikoMapId(mapId: string): mapId is PikoMapId {
  return Object.prototype.hasOwnProperty.call(PIKO_MAP_TRANSITIONS, mapId);
}
