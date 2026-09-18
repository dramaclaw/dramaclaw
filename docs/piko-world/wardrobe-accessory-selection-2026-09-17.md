# 首批角色配饰确认

用户已确认以下六件来自搭子道具池的配饰，男女角色共用；已接入装扮预览、确认保存和地图角色。

| 道具 | 素材 | 目标位置 |
| --- | --- | --- |
| 薄暮 | mask-dark-knight.png | 额头附近，头戴面具 |
| 粉红色回忆 | bow-red.png | 头发侧上方 |
| 深潜护目镜 | goggles-diver.png | 额头 |
| 侠之大者 | hat-bamboo.png | 头顶 |
| 小蜗牛 | snail-gary.png | 头顶 |
| 魔法帽 | hat-wizard.png | 头顶 |

素材目录：`frontend/public/piko/accessories/`。用户所说“深浅护目镜”对应现有“深潜护目镜”。薄暮和粉红色回忆也要靠近头部，不放在胸前。

单件互斥佩戴，再点已选项摘下；确认保存到当前账号的本地存储，关闭弹窗丢弃草稿。六件均为头部配饰。地图使用男女动作图集逐帧头顶锚点；侧向面具、护目镜收窄，背向隐藏；蝴蝶结背向也隐藏，帽子和蜗牛保留。素材目前复用道具池二维图，并非新绘制的四向配饰。

头部锚点文件：`runtime/player-head-anchors.json`，按 south/west/east/north 各 11 帧排列，来源为男 v2、女 v3 图集 alpha > 64 的头顶与上方 12 行头部包围盒，坐标相对脚点 (32,57)。动作图集更新时需同步重新测量。

锚点生成与校验：`.venv/bin/python scripts/build_piko_player_head_anchors.py`；只验证用 `--check`。

最终微调统一在 `piko-player-accessories.ts`：薄暮宽 15、偏移 (-1,-1)，斗笠宽 24、偏移 (0,-5)；装扮预览与地图共用。地图昵称间距 28 世界像素，预览帽子空间 28 CSS 像素。
