// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export type LoginCommunityWork = {
  id: string;
  /** i18n key for the display title (the source video's name). */
  titleKey: string;
  /** i18n key for the short description (from the work's 简介.txt; empty if none). */
  descriptionKey: string | null;
  likes: number;
  cover: string;
  preview: string;
  gradient: string;
};

const CDN_BASE = "https://nfg-web-assets.cdnfg.com/dramaclaw";

// Build a CDN media URL from a human-readable path. `encodeURI` percent-encodes
// the CJK characters, spaces and 《》 in the filenames (the CDN serves them
// percent-encoded) while leaving the `https://` and the `/` separators intact.
function cdn(path: string): string {
  return encodeURI(`${CDN_BASE}/${path}`);
}

export const loginCommunityWorks: LoginCommunityWork[] = [
  {
    id: "neon-patrol",
    titleKey: "loginCinematic.works.luban.title",
    descriptionKey: "loginCinematic.works.luban.logline",
    likes: 124,
    cover: cdn("luban/luban-cover.png"),
    preview: cdn("luban/luban-ep01.mp4"),
    gradient: "linear-gradient(135deg, #132674 0%, #e52c3b 48%, #1a0d23 100%)",
  },
  {
    id: "glass-signal",
    titleKey: "loginCinematic.works.guilingsi.title",
    descriptionKey: "loginCinematic.works.guilingsi.logline",
    likes: 33,
    cover: cdn("guilingsi/guilingsi-cover.png"),
    preview: cdn("guilingsi/guilingsi-ep01.mp4"),
    gradient: "linear-gradient(135deg, #dfe8ec 0%, #61a8b8 42%, #21313e 100%)",
  },
  {
    id: "silent-arcade",
    titleKey: "loginCinematic.works.shixiongButianle.title",
    descriptionKey: "loginCinematic.works.shixiongButianle.logline",
    likes: 71,
    cover: cdn("shixiong-butianle/shixiong-butianle-cover.png"),
    preview: cdn("shixiong-butianle/shixiong-butianle-ep01.mp4"),
    gradient: "linear-gradient(135deg, #1b1730 0%, #b7477e 44%, #1a8baa 100%)",
  },
  {
    id: "floating-market",
    titleKey: "loginCinematic.works.tianmingbukeqi.title",
    descriptionKey: "loginCinematic.works.tianmingbukeqi.logline",
    likes: 95,
    cover: cdn("tianmingbukeqi/tianmingbukeqi-cover.png"),
    preview: cdn("tianmingbukeqi/tianmingbukeqi-ep02.mp4"),
    gradient: "linear-gradient(135deg, #233a2b 0%, #d69d55 48%, #1b1e28 100%)",
  },
  {
    id: "last-take",
    titleKey: "loginCinematic.works.wulongxiantu.title",
    descriptionKey: "loginCinematic.works.wulongxiantu.logline",
    likes: 118,
    cover: cdn("wulongxiantu/wulongxiantu-cover.png"),
    preview: cdn("wulongxiantu/wulongxiantu-ep01.mp4"),
    gradient: "linear-gradient(135deg, #2e1020 0%, #d65041 44%, #f4c16e 100%)",
  },
  {
    id: "paper-city",
    titleKey: "loginCinematic.works.feiyiZhouwu.title",
    descriptionKey: "loginCinematic.works.feiyiZhouwu.logline",
    likes: 57,
    cover: cdn("feiyi-zhouwu/feiyi-zhouwu-cover.png"),
    preview: cdn("feiyi-zhouwu/feiyi-zhouwu.mp4"),
    gradient: "linear-gradient(135deg, #e9d6b8 0%, #a4574b 45%, #25253a 100%)",
  },
  {
    id: "rainy-night",
    titleKey: "loginCinematic.works.3dAnimeMontage.title",
    descriptionKey: "loginCinematic.works.3dAnimeMontage.logline",
    likes: 42,
    cover: "/login-community/rainy-night.jpg",
    preview: cdn("3d-anime-montage-demo/3d-anime-montage-demo.mp4"),
    gradient: "linear-gradient(135deg, #0d5877 0%, #48c2d7 42%, #1a2535 100%)",
  },
  {
    id: "ember-crown",
    titleKey: "loginCinematic.works.dongtaiDadou.title",
    descriptionKey: "loginCinematic.works.dongtaiDadou.logline",
    likes: 86,
    cover: "/login-community/ember-crown.jpg",
    preview: cdn("dongtai-dadou/dongtai-dadou.mp4"),
    gradient: "linear-gradient(135deg, #1f1b2e 0%, #8d3b2f 48%, #f0a23a 100%)",
  },
];
