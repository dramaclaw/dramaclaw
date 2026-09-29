# 琥珀原野草丛动态 v1

## 当前配置

- 地图 revision 7；用户确认首版素材后，将3簇扩至12簇，不改变底图、碰撞或动物配置。
- 正式图集：`frontend/public/piko/world/maps/amber-wilds/effects/golden-grass-breeze-v1.png`。
- 内置 imagegen 生成并修正后原样复制，1774×887 RGBA，4列×2行，共8帧；透明背景，无地块或底座。
- SHA256：`1addd5dcfdfdb2cacd60fb7410944557956e760871c626345267b4eb10e91b03`。
- 复用 `environment-effect-runtime.ts` 和 `environment-sprite.ts`，同图集只加载一次。2fps循环，4秒一轮；后台暂停，减少动态时固定各自起始帧。

| 位置 | 显示框左上角 | 显示框大小 | 起始帧 |
|---|---|---|---|
| 遗迹上方西侧草坡（保留） | (474, 245) | 112×112 | 0 |
| 道路右侧中部草坡（保留） | (1220, 258) | 112×112 | 3 |
| 右下草地（保留） | (1768, 690) | 136×136 | 6 |
| 西北远处缓坡 | (240, 116) | 80×80 | 5 |
| 西北中段草坡 | (441, 159) | 88×88 | 2 |
| 北侧开阔草坡 | (996, 129) | 88×88 | 7 |
| 东北缓坡 | (1562, 237) | 96×96 | 1 |
| 西侧中段空地 | (174, 384) | 112×112 | 4 |
| 遗迹东侧草地 | (894, 424) | 112×112 | 6 |
| 南侧开阔草坡 | (1086, 725) | 128×128 | 2 |
| 东侧中段空地 | (1670, 537) | 120×120 | 0 |
| 东南边缘内侧草地 | (1916, 760) | 128×128 | 5 |

显示框含透明留白，实际草丛小于框尺寸。首版后半段朝向翻转的候选未接入项目，改用同向弯摆版本。用户已确认首版素材及动态效果。本轮保留原三处，新增九处：远景略小、近景略大，避开道路、遗迹、岩石和动物落点；左下密集长草区保持原样。

## 最终修正提示词（内置 imagegen）

Edit target: this transparent grass animation sheet. Preserve its warm ochre hand-painted style, 4 columns by 2 rows, eight equal square cells, actual transparent alpha background. Correct the animation consistency: the current cells 6 and 7 are mirrored and MUST NOT be mirrored. Use cell 1 as the exact plant identity for ALL eight cells, with exactly the same roots, leaf structure and seed stalks in exactly the same scale and cell-relative position. All seed stalks maintain their basic rightward lean in every frame. The root/footprint pixel region in the lower 25% of the plant should be IDENTICAL across frames and rooted at exactly the same cell-relative point. ONLY the upper half bends very gently right and recovers, never bends left of its neutral pose. Specify phases: frame1 neutral rightward lean; frame2 tiny additional rightward bend; frame3 slightly more rightward; frame4 maximum bend no more than 8 pixels from frame1; frame5 same as frame4; frame6 returns to frame3; frame7 returns to frame2; frame8 matches frame1. NO horizontal flip, NO rotation or rescaling, NO regenerating a different plant per frame, NO root movement, NO extra leaves. Make the root edge softly irregular with transparent gaps, no dark solid base, no soil or ground shadow. Retain all empty padding and true transparency. The grass should feel low and loose; preserve clear transparent gaps between outer leaves. Deliver one corrected eight-frame atlas, no labels, no added background.
