# 单树序列帧小样 — revision 41

> 历史记录：本图集已由 v2 替换；2026-09-09 审计移除了 public 下无运行时引用的 v1 成品，原始生成记录保留。

按用户最后反馈，将大厅右侧石凳后大树的实时剪切形变改为实际图集换帧。内置 imagegen 生成 4×4、16 帧图集，原始输出 1327×1185，保存于 frontend/public/piko/world/maps/welcome-courtyard/effects/east-tree-canopy-atlas-v1.png。

运行时每格只采样树冠部分（相对格宽高 x=0.235、y=0.13、width=0.70、height=0.57），映射至原树冠的包围框，用原遮挡轮廓裁剪。2 fps，8 秒循环，不再对树冠做旋转或剪切。图集树冠为生成素材，叶形纹理与原图存在差异，贴合程度和实际动感待用户视觉验收。

保留已有 east-tree-clean-plate-v1.png 背景补片、y=435 以下的原图树干、原碰撞和固定遮挡轮廓；石凳不替换。暂停后台动画，减少动态时显示首帧，退出释放帧纹理但不销毁共享图集源。固定轮廓无需每帧更新人物遮挡几何。

## 生成提示词（内置 imagegen，无 CLI）

Use case: precise-object-edit. Create a production game animation atlas using the attached map as reference. Target ONLY the broad round deciduous tree immediately right of town hall, behind the stone bench: map rectangle x=1380,y=250,width=280,height=250 in the 2048x1152 reference. Output a 4-column by 4-row sprite sheet, 1120x1000 pixels, 16 equally sized 280x250 cells with no gutters or labels. Every cell reproduces this SAME crop with same scale, alignment, tree silhouette, colors, light direction and stationary trunk. OPAQUE full rectangular cells including original scenery behind tree, not transparency. Animate ONLY leaf clusters inside the canopy with gentle organic breeze: 16 successive frames looping seamlessly, small 2-4 pixel local leaf motions with staggered phases, NO whole-tree rotation/shear/translation. Keep canopy outer silhouette stationary, trunk and bottom 65 pixels completely identical in all cells. Match painterly pixel art faithfully: broad low irregular crown, yellow green upper-left highlights, dark blue green right shadows. No redesign, no new tree, no grid lines, no numbers, no checkerboard. This atlas will replace the canopy inside the exact original outline, original trunk retained separately. Frame sequence row-major.


revision 43：用户反馈 16 帧造型变化复杂、抢戏。比较采样树冠的像素差异后，选用较一致的连续第 2、3、4 帧（零基索引 1、2、3），按 2→2→3→4→4→4→3→2、每步一秒播放。8 秒循环，仅四次画面切换，往返且两端停留。继续使用实际序列帧；原图集保留，未新增或重生成素材。树干、轮廓、遮挡及环境声不变。克制程度待用户视觉验收。
