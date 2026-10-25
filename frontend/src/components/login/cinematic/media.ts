const CDN_BASE = "https://nfg-web-assets.cdnfg.com/dramaclaw";

/** 登录页所有外链资源的唯一拼装口子 —— 换 CDN 只改 `CDN_BASE` 一处。 */
export const cdn = (path: string) => encodeURI(`${CDN_BASE}/${path}`);

export const businessWechatQrUrl = cdn("contact/wechat.png");

export const cinematicVideoLibrary = [
  {
    id: "luban",
    titleKey: "loginCinematic.works.luban.title",
    type: "TRAILER",
    stat: "12 SHOTS",
    loglineKey: "loginCinematic.works.luban.logline",
    video: cdn("luban/luban-ep01.mp4"),
  },
  {
    id: "guilingsi",
    titleKey: "loginCinematic.works.guilingsi.title",
    type: "SCENE",
    stat: "08 SHOTS",
    loglineKey: "loginCinematic.works.guilingsi.logline",
    video: cdn("guilingsi/guilingsi-ep01.mp4"),
  },
  {
    id: "shixiong-butianle",
    titleKey: "loginCinematic.works.shixiongButianle.title",
    type: "CHARACTER",
    stat: "09 SHOTS",
    loglineKey: "loginCinematic.works.shixiongButianle.logline",
    video: cdn("shixiong-butianle/shixiong-butianle-ep01.mp4"),
  },
  {
    id: "tianmingbukeqi",
    titleKey: "loginCinematic.works.tianmingbukeqi.title",
    type: "WORLD",
    stat: "14 SHOTS",
    loglineKey: "loginCinematic.works.tianmingbukeqi.logline",
    video: cdn("tianmingbukeqi/tianmingbukeqi-ep02.mp4"),
  },
  {
    id: "wulongxiantu",
    titleKey: "loginCinematic.works.wulongxiantu.title",
    type: "TRAILER",
    stat: "11 SHOTS",
    loglineKey: "loginCinematic.works.wulongxiantu.logline",
    video: cdn("wulongxiantu/wulongxiantu-ep01.mp4"),
  },
  {
    id: "feiyi-zhouwu",
    titleKey: "loginCinematic.works.feiyiZhouwu.title",
    type: "WORLD",
    stat: "07 SHOTS",
    loglineKey: "loginCinematic.works.feiyiZhouwu.logline",
    video: cdn("feiyi-zhouwu/feiyi-zhouwu.mp4"),
  },
  {
    id: "3d-anime-montage-demo",
    titleKey: "loginCinematic.works.3dAnimeMontage.title",
    type: "SCENE",
    stat: "10 SHOTS",
    loglineKey: "loginCinematic.works.3dAnimeMontage.logline",
    video: cdn("3d-anime-montage-demo/3d-anime-montage-demo.mp4"),
  },
  {
    id: "dongtai-dadou",
    titleKey: "loginCinematic.works.dongtaiDadou.title",
    type: "ACTION",
    stat: "06 SHOTS",
    loglineKey: "loginCinematic.works.dongtaiDadou.logline",
    video: cdn("dongtai-dadou/dongtai-dadou.mp4"),
  },
] as const;

/** 登录弹窗左侧主视觉使用独立成片，不影响落地页作品库。 */
export const loginModalShowcaseVideo = cdn("login/login20260826-174426.mp4");

export const cinematicVideos = {
  cs: cinematicVideoLibrary[7].video,
  jqr: cinematicVideoLibrary[1].video,
  pk: cinematicVideoLibrary[0].video,
} as const;
