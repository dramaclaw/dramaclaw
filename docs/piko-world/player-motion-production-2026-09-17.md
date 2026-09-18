# 玩家角色动作：当前构建与维护

当前地图使用男性 `player-male-motion-v2.png`、女性 `player-female-motion-v3.png`，发布位置为 `frontend/public/piko/world/characters/`。创建界面继续使用原有高分辨率正面画像。当前范围为四方向待机与行走，不包含跳跃或可替换衣装图层。

## 构建与校验

在仓库根目录执行：

```sh
.venv/bin/python scripts/build_piko_player_motion_v2.py
.venv/bin/python scripts/build_piko_female_player_motion.py
.venv/bin/python scripts/build_piko_player_head_anchors.py --check
```

动作图集有意更新后，先运行不带 `--check` 的锚点脚本重新生成 `frontend/src/features/piko-world/runtime/player-head-anchors.json`，再校验。脚本依据图集逐帧测量，男女共 88 个锚点。

评审图片分别输出到 `piko-world/art/review/player-male-motion-v2/` 与 `player-female-motion-v3/`，不进入 Git。共用拆帧工具 `scripts/build_piko_player_walk_keys.py` 的默认输入为男性向左行走 v2，默认评审输出为 `piko-world/art/review/player-walk-keys/`；也可显式传入 `--source`、`--direction` 和 `--review`。

## 必需源图

源图位于 `piko-world/art/source/`。下表中的方向对应 south / west / east / north。

| 角色 | 待机输入 | 行走输入 |
| --- | --- | --- |
| 男性 | `player-male-idle-keys-v2.png` | 南、西、东使用 `player-male-{direction}-walk-keys-v2.png`；北使用 v1 |
| 女性 | 南使用 `player-female-south-idle-keys-v2.png`；西、东使用 v3；北使用 v1 | 南、北使用 v1；西、东同时使用 v1 和 v2 |

女性左右行走的八相位顺序为 `v2:0 → v2:1 → v1:2 → v2:2 → v2:5 → v2:4 → v1:5 → v2:3`，因此两张侧向 v1 源图不能移除。男性向上行走 v1 同样仍是当前输入。

男女 `player-{gender}-directions-v1.png` 是造型母稿，保留作美术依据，不参与当前图集像素合成。男女构建均依赖 `build_piko_player_walk_keys.py`；女性构建还复用男性 v2 构建模块的常量、透明分区与校验函数。

## 帧协议与运行时参数

- 单帧 64×64，可见高度 56px，二值透明，最近邻缩放与采样；脚底 y=57，轴心 `(32,57)`。
- 图集 704×256，共 44 帧，行序 south / west / east / north；每行前三列待机、后八列行走，第 2 列复制中性帧。
- 玩家速度 135 地图像素/秒，完整步周期对应 `48×角色缩放` 地图像素，按实际移动距离推进；碰撞停住时不继续迈步。
- 待机周期 8000ms，帧序 `0→1→0→1→0`，时长为 2200/350/3500/350/1600ms。居民保留原 4800ms 周期；减少动态效果时固定第 0 帧。
- 男性待机按方向统一调整横向比例；女性待机等比缩放，并校验侧向待机头宽与行走头宽中位数的差不超过 2px。
- 配饰锚点、方向适配与保存行为见 [角色配饰](wardrobe-accessory-selection-2026-09-17.md)。像素制作约束见 [角色制作规范](default-piko-pixel-production-spec.md)。

构建校验覆盖帧尺寸、透明度、脚底与部分比例约束；源图对近远腿的区分仍有限，连续行走观感需实机验收。

## 历史与清理

[制作历史](history/player-motion-production-2026-09-17.md) 保留旧版本参数、反馈和当时的检查记录；[2026-09-17 审计](history/daily-audit-2026-09-17.md) 仅作为当日记录。

2026-09-18 移除已被替代的女性南、西、东待机 v1、男性南、西、东行走 v1，以及旧版 `build_piko_player_walk.py`、`build_piko_player_masters.py`。这些文件可从 Git 提交 `8dbef968` 恢复；男性北行 v1、女性侧向行走 v1、共用拆帧工具及男女造型母稿继续保留。旧导出和评审目录为本地历史产物，不随版本发布。
