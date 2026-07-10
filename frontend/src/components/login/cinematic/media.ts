const OSS_BASE = "https://nfg-web.oss-cn-chengdu.aliyuncs.com/dramaclaw";

const oss = (path: string) => encodeURI(`${OSS_BASE}/${path}`);

export const cinematicVideoLibrary = [
  {
    id: "luban",
    title: "鲁班",
    type: "TRAILER",
    stat: "12 SHOTS",
    logline: "机械与古法在同一条时间线里重新咬合。",
    video: oss("luban/luban-ep01.mp4"),
  },
  {
    id: "guilingsi",
    title: "归灵司",
    type: "SCENE",
    stat: "08 SHOTS",
    logline: "全城反光物同时作祟，收灵人被迫追查镜中源头。",
    video: oss("guilingsi/guilingsi-ep01.mp4"),
  },
  {
    id: "shixiong-butianle",
    title: "师兄你怎么不舔了",
    type: "CHARACTER",
    stat: "09 SHOTS",
    logline: "重生后的第一件事，是拒绝继续当命运的配角。",
    video: oss("shixiong-butianle/shixiong-butianle-ep01.mp4"),
  },
  {
    id: "tianmingbukeqi",
    title: "天命不可欺",
    type: "WORLD",
    stat: "14 SHOTS",
    logline: "大婚当日，归乡之法与王朝秘密同时浮出水面。",
    video: oss("tianmingbukeqi/tianmingbukeqi-ep02.mp4"),
  },
  {
    id: "wulongxiantu",
    title: "乌龙仙途",
    type: "TRAILER",
    stat: "11 SHOTS",
    logline: "飞升系统终于激活，却把修仙路带向另一个荒唐方向。",
    video: oss("wulongxiantu/wulongxiantu-ep01.mp4"),
  },
  {
    id: "feiyi-zhouwu",
    title: "非遗㑇舞",
    type: "WORLD",
    stat: "07 SHOTS",
    logline: "传统身段、节奏和镜头被重新编排成可观看的片段。",
    video: oss("feiyi-zhouwu/feiyi-zhouwu.mp4"),
  },
  {
    id: "3d-anime-montage-demo",
    title: "3D动漫混剪",
    type: "SCENE",
    stat: "10 SHOTS",
    logline: "多个动画片段被剪进同一组高密度镜头节奏。",
    video: oss("3d-anime-montage-demo/3d-anime-montage-demo.mp4"),
  },
  {
    id: "dongtai-dadou",
    title: "动态打斗",
    type: "ACTION",
    stat: "06 SHOTS",
    logline: "动作、速度线和镜头压迫感在短片里连续推进。",
    video: oss("dongtai-dadou/dongtai-dadou.mp4"),
  },
] as const;

export const cinematicVideos = {
  cs: cinematicVideoLibrary[7].video,
  jqr: cinematicVideoLibrary[1].video,
  pk: cinematicVideoLibrary[0].video,
} as const;
