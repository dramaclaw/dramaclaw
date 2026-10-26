// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export type LoginCommunityWork = {
  id: string;
  /** Literal display title (the source video's name). */
  title: string;
  /** Literal short description (from the work's 简介.txt; empty if none). */
  description: string;
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

// i18n-exempt-start —— title / description 是作品自己的片名和简介（见类型上的
// “Literal …” 注释），属于展示内容而非界面文案。
export const loginCommunityWorks: LoginCommunityWork[] = [
  {
    id: "neon-patrol",
    title: "鲁班",
    description: "",
    likes: 124,
    cover: cdn("luban/luban-cover.png"),
    preview: cdn("luban/luban-ep01.mp4"),
    gradient: "linear-gradient(135deg, #132674 0%, #e52c3b 48%, #1a0d23 100%)",
  },
  {
    id: "glass-signal",
    title: "归灵司",
    description:
      "全城反光物同时作祟，人脸凭空消融！归灵司最强收灵人陆灵犀奉命调查，却发现自己竟是这场灵祸的源头——镜灵千年寻主",
    likes: 33,
    cover: cdn("guilingsi/guilingsi-cover.png"),
    preview: cdn("guilingsi/guilingsi-ep01.mp4"),
    gradient: "linear-gradient(135deg, #dfe8ec 0%, #61a8b8 42%, #21313e 100%)",
  },
  {
    id: "silent-arcade",
    title: "师兄你怎么不舔了",
    description: "堂堂天道宗掌门林渊，重生第一件事，就是拒绝当舔狗！",
    likes: 71,
    cover: cdn("shixiong-butianle/shixiong-butianle-cover.png"),
    preview: cdn("shixiong-butianle/shixiong-butianle-ep01.mp4"),
    gradient: "linear-gradient(135deg, #1b1730 0%, #b7477e 44%, #1a8baa 100%)",
  },
  {
    id: "floating-market",
    title: "天命不可欺",
    description:
      "大婚当日，内忧外患同时爆发，太庙送上一本回到现代的“归乡之法”，并告诉了云知之一个惊人的秘密……",
    likes: 95,
    cover: cdn("tianmingbukeqi/tianmingbukeqi-cover.png"),
    preview: cdn("tianmingbukeqi/tianmingbukeqi-ep02.mp4"),
    gradient: "linear-gradient(135deg, #233a2b 0%, #d69d55 48%, #1b1e28 100%)",
  },
  {
    id: "last-take",
    title: "乌龙仙途",
    description: "穿越十八年终于激活了飞升系统，结果系统是个坑货",
    likes: 118,
    cover: cdn("wulongxiantu/wulongxiantu-cover.png"),
    preview: cdn("wulongxiantu/wulongxiantu-ep01.mp4"),
    gradient: "linear-gradient(135deg, #2e1020 0%, #d65041 44%, #f4c16e 100%)",
  },
  {
    id: "paper-city",
    title: "非遗㑇舞",
    description: "",
    likes: 57,
    cover: cdn("feiyi-zhouwu/feiyi-zhouwu-cover.png"),
    preview: cdn("feiyi-zhouwu/feiyi-zhouwu.mp4"),
    gradient: "linear-gradient(135deg, #e9d6b8 0%, #a4574b 45%, #25253a 100%)",
  },
  {
    id: "rainy-night",
    title: "3D动漫混剪",
    description: "",
    likes: 42,
    cover: "/login-community/rainy-night.jpg",
    preview: cdn("3d-anime-montage-demo/3d-anime-montage-demo.mp4"),
    gradient: "linear-gradient(135deg, #0d5877 0%, #48c2d7 42%, #1a2535 100%)",
  },
  {
    id: "ember-crown",
    title: "动态打斗",
    description: "",
    likes: 86,
    cover: "/login-community/ember-crown.jpg",
    preview: cdn("dongtai-dadou/dongtai-dadou.mp4"),
    gradient: "linear-gradient(135deg, #1f1b2e 0%, #8d3b2f 48%, #f0a23a 100%)",
  },
];
// i18n-exempt-end
