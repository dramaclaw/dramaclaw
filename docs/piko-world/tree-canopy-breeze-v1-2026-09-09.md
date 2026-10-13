# 东侧大树动态小样 — revision 38

对象为大厅右侧、石凳后方的 east-canopy-tree。用户授权先做一棵。

当前接入的是原图叶簇局部位移动画，**不是生成图集**。六处树冠内部叶簇共享 base.png 的纹理源；32 个动画步、4 步/秒，8 秒循环，水平位移不超过 1.5 地图像素，垂直位移为水平的四分之一。相位错开，椭圆分层混合降低局部边界突变。小样不移动树冠外轮廓，不改变树干、根部、石凳、碰撞、人物遮挡或声音。

后台停更新；减少动态时隐藏局部动态层、显示原树；卸载释放纹理视图与监听，保留底图共享纹理。实现见 frontend/src/features/piko-world/runtime/tree-canopy-breeze.ts。当前仅在 welcome-courtyard 初始化，尚未扩展成多树通用配置。

## 素材尝试与调整

使用内置 imagegen 两次，未使用 CLI。第一版不透明图集重画了树干与石凳；第二版树冠图集改变树形且输出 RGB 棋盘格背景，不具备真实 alpha。两版均未接入、未复制到地图资源中。生成候选保留于工具默认目录，当前实现无需新增位图。

原计划的独立背景补片、摆动树缘和逐帧轮廓未交付；当前是保留原树的内部叶簇小样。不可把它描述为已完成完整树木序列帧。后续若需要更明显的整冠摆动，应先取得精确分离的树冠与干净背景素材。

## 内置 imagegen 提示词

第一版：

Use case: precise-object-edit. Asset type: game environment animation atlas. Reference is the exact source map, 2048x1152. Extract ONLY the round broadleaf tree to the right of the central town hall, above the stone bench, source bounding rectangle x=1380 y=250 width=280 height=250. Make a 4 by 4 animation sprite sheet of this EXACT rectangular crop, 16 consecutive frames row-major, output 1120x1000 if possible (otherwise uniformly scaled same ratio). Each cell shows identical crop, same tree size, same trunk location, same ground background, fixed camera. OPAQUE background: reconstruct tiny exposed ground behind moving leaves so each cell completely replaces the original crop without ghosting. Gentle breeze: only canopy leaf clusters shift subtly 2-3 source pixels right then return then left then return in a smooth 16-frame loop. Tree trunk and roots absolutely stationary. Keep original tree silhouette, painterly pixel clusters, colors, lighting, shading and all surrounding grass/path pixels as faithfully as possible. No new tree design, no bench duplication, no objects added. Outer 10 pixel border of each crop must remain perfectly stationary and identical. No text, labels, grid lines, gutters, transparency, global camera movement, zoom, rotating or bouncing trunk. This is a precise in-place animation replacement of ONE existing tree, not sixteen different trees.

第二版：

Use case: precise-object-edit. Create a game sprite atlas for ONLY the leafy CANOPY of the existing broadleaf tree immediately right of town hall and above the stone bench. Source tree canopy occupies map x=1389..1646 y=257..439 on the provided 2048x1152 map. Preserve the EXACT original broad low irregular canopy silhouette, original blue-dark-green right side, yellow-green upper left highlights, same leaf shapes and painterly pixel art. Exclude ALL trunk, roots, ground, bench, buildings, other trees. Real transparent alpha background outside canopy. Output a strict 4x4 grid of 16 equal square cells, 1024x1024 total. Every cell same object same position same scale. Canopy bounding box within each 256x256 cell: x=0..256 y=0..182, leaving lower 74 pixels transparent. Canopy is wider than tall, width/height ratio 257/182. Sixteen successive tiny breeze frames with leaf clusters moving no more than 2 pixels, stationary overall silhouette outline and fixed canopy base; clockwise breeze phases with smooth return to first frame. No rotating camera, no changing tree species, no size changes, no trunk, no ground, no bench, no text, no grid lines, no borders, no baked checkerboard. Only internal leaf movement; exterior silhouette must remain invariant to preserve existing map occlusion.

## 验证

定向测试 38 项通过，覆盖小样循环边界、后台暂停、减少动态、资源释放和已有遮挡/地图契约。视觉由用户实走验收，重点观察叶簇位移是否可辨、边界是否有局部重影以及人物绕树遮挡。未做浏览器视觉验收。

## revision 39：修正动态不可辨

用户反馈看不到动态。上一版最大位移 1.5 像素且叶簇中心混合后仍透出原图，视觉强度不足。现改为水平最大 4 像素、垂直最大 1.4 像素，中心完全不透明，外围三圈 0.35 透明度渐过渡；按 ticker 连续更新，保留 8 秒周期。纹理采样边距扩展至 6 像素，避免移动后露空。测试验证 ticker 推进两秒后核心叶簇实际位移超过 3.5 像素。实际显示仍待用户查看。
