# 单树微风与偶发落叶 — 已定稿

> 当前定稿状态：revision 48；7 个播放帧、8 秒一轮，保留偶发落叶，枝干接合及紫边已修复。用户已确认效果。下文 revision 44–47 为实现与调整历史；审计见 audit-2026-09-09.md。

用户反馈旧图集每帧叶簇造型变化太大，缩减至三帧后又缺少风吹摇摆感；本轮重新制作八帧树冠，并加入偶发落叶。对象仍为大厅右侧石凳后的单棵大树。

## 当前实现

新素材由内置 imagegen 生成，保存在 frontend/public/piko/world/maps/welcome-courtyard/effects/east-tree-canopy-atlas-v2.png，4×2 图集，1983×793 像素，8 帧、6 秒一轮，连续换帧，不再长时间停帧。通过固定的逐帧配准补偿消除生成图集第二行约三像素的上跳，并收敛横向位移；校准后树冠像素重心横向跨度约五个地图像素。仍需用户实走确认帧间叶簇稳定性与风吹观感。

第一次输出将透明背景画成棋盘格，未使用。第二次仅将背景替换为洋红色底，运行时以色键生成逐帧 Graphics 遮罩，不改动图集像素，洋红色不参与可见渲染。树冠图层与遮罩使用同一配准；人物剪影和头部遮挡跟随每帧树冠及固定树干的扫描线外轮廓。该外轮廓保留到一地图像素精度，细小内部叶间空隙仅在可见遮罩中体现，人物遮挡采用外包络。原背景补片、树干与碰撞继续使用。

落叶使用低饱和橄榄黄色的小型像素粒子，约 6×4 地图像素。首片在进入后 5–9 秒出现，此后每隔 12–20 秒掉落一片，每第三次额外延迟 1.4 秒掉落第二片；同时最多两片。单片飘落 6–8 秒，横向缓缓漂移和轻微翻转，下降约 105 像素，末段淡出，无地面堆积。后台暂停；减少动态时树冠回首帧、清空落叶；退出销毁粒子、遮罩与帧纹理并恢复原遮挡配置。

## 内置 imagegen 提示词

Use case: precise-object-edit. Input: reference tree screenshot. Produce an animation sprite atlas of ONLY the canopy of this EXACT tree, on genuine transparent RGBA background. Do NOT include trunk, bench, ground, background, shadows on ground, scenery or falling leaves.
Layout: EXACTLY 4 columns x 2 rows = 8 frames, row-major. Canvas 1280x512 pixels, equal cells 320x256, no gutters, no text, no grid. In every cell canopy occupies x=20..300, y=20..210, with fixed lower central attachment at (160,210). Same broad irregular low crown as reference, warm yellow green highlights upper left, deep green right, painterly pixel-art leaf clusters, identical branch/leaf-cluster identity across frames.
Critical: these are 8 temporal poses of ONE tree, not eight tree variations. Copy the same leaf clusters through ALL frames, do not invent or rearrange leaves, do not change lighting or texture. A gentle wind bends leafy branches slightly sideways while the bottom central attachment stays fixed. Sequence canopy top horizontal offsets in source cell pixels: 0, +2, +4, +2, 0, -2, -4, -2. Lower leaf clusters follow one frame later with only 1-2px movement. Silhouette edges must move a little with coherent breeze. NO major reshape, leaf texture boiling, flashing, bouncing, scaling, whole crown rotation, or changing species. Smooth seamless loop back to frame 1. Keep fixed camera and exact registration. True transparent background outside leaves, never painted checkerboard or scenery.

背景修正：

Edit the attached 8-frame tree canopy atlas. Change ONLY the grey-white checkerboard background and the pale swirls in background to one perfectly flat solid chroma-key MAGENTA color #ff00ff. Preserve all eight green canopies exactly pixel-for-pixel: same frame layout, foliage detail, poses, size, alignment, shading, crisp edges. No magenta inside leaves. No white grey fringe around leaves. Opaque RGB matte sprite sheet for chroma-key rendering in a game. Keep 4 columns and 2 rows. Do not add, remove, reshape, recolor or move any leaf cluster. No checkerboard, transparency simulation, shadows, words or labels. Only replace background with uniform pure #ff00ff.



revision 45：修复树冠与树干脱节。静态原图分界从 y=435 提升到 y=405，保留枝杈连接及下缘枝叶，与动态树冠重叠，避免露出背景补片。图集加载时在画布上解码为 280×212 RGBA 帧，删除洋红色及弱紫边像素，渲染与遮挡使用同一像素源，解决独立缩放遮罩与不透明图集采样错位导致的紫点。帧图和画布在卸载时释放。42 项定向测试、类型检查通过；浏览器逐帧检查八帧均保持树干接合，无明显紫边，截图 /private/tmp/piko-tree-junction-review.png。八帧、6 秒循环与落叶参数不变。


revision 46：右摆三帧配准调整为 -3/-8/-4，右偏峰值约 1.8 地图像素；八帧循环从 6 秒放慢到 8 秒。树干接合、RGBA 帧及落叶保持。


revision 47：按用户反馈跳过树冠最靠右的一帧（图集零基索引 2），播放顺序为 0、1、3、4、5、6、7。保留约 8 秒一轮，7 个播放帧按 0.875 fps 切换，遮挡沿用对应帧；原图集保留。
