# 喷泉水柱序列帧 v1

## 节奏调整（revision 23）

四股水柱由 6 fps 降至与水面相同的 4 fps，均为 16 帧、4 秒一轮。保持现有水柱位置、尺寸与层级，视觉节奏由用户验收。

## 叶尖与水量调整（revision 22）

按用户红框将两股主水柱可见起点对齐左右叶片低垂尖点，计算时计入图集顶部约 13% 的透明留白。主水柱显示宽度由 22 增到 40 地图像素（约 1.8 倍），显示区域分别为 (1016,549,40,54)、(1062,545,40,58)。追加两股宽 30 的外侧流水，位于 (1005,533,30,65)、(1079,531,30,67)，置于雕塑后方。总计四股，共用原图集，无新增运行时代码。水面 4 fps、水柱 6 fps 不变。已检查实际 Canvas 渲染，7 项地图包定向测试及差异检查通过，叶尖贴合与水量由用户验收。

## 初版记录

地图 revision 21。用户授权制作水柱，新增两侧小股落水及落点水花：west 放置于 (1019,538)，east 位于 (1074,538)，两者帧显示范围 22×56 地图像素。透明素材内部留白使实际水柱更细。16 帧、6 fps；已确认的池水保持 4 fps。

素材路径：frontend/public/piko/world/maps/welcome-courtyard/effects/fountain-stream-v1.png。

使用内置 imagegen 生成，实际尺寸 1254×1254，4×4 网格，RGBA，Alpha 范围 0～255。原图直接入库，保留真实透明通道，未通过色键抠图或代码绘制水流。

共用 environment-sprite 播放器；新增可配置 layer：water (-1)、behind-scenery (-0.75)、front-scenery (-0.25)。静态雕塑仍位于 -0.5；本轮两条可见侧面水流放在雕塑前方，避开中间主体，所有环境层位于角色下方。两侧水流共用同一图集缓存。退出释放派生帧与共享资源，页面隐藏时暂停，减少动态时保留首帧。

8 项定向测试、TypeScript 类型检查、差异检查通过。在实际 Canvas 预览中检查了透明背景、落点及雕塑关系；粗细、水量和循环节奏待用户验收。

## 生成提示词

Production game sprite sheet: 4 by 4 grid, sixteen equal square cells, no gutters or lines or labels. TRUE TRANSPARENT ALPHA background, not checkerboard, no opaque background. Every cell shows the SAME small gently falling fountain water stream animation across sixteen successive loop frames. Side/front view: a slender vertical water ribbon descends from fixed nozzle position at cell coordinate (128,32) to impact at (128,200). At bottom a small flattened elliptical splash about 90 px wide, 20 px high with tiny drops. Water pale ivory highlights, translucent light cyan and muted turquoise shadows, crisp painterly pixel art clusters matching a cozy medieval pixel game, not realistic. Each frame has exact same nozzle, impact center, size and bounding box. Only internal descending droplets, broken highlights and little splash lobes change smoothly over time. No fountain, no sculpture, no pool, no stone, no nozzle object, no scenery. Slender calm trickle rather than thick waterfall, avoid huge spray. All sixteen cells fill a 1024x1024 atlas; each cell 256x256. Leave padding around each water stream. Frame sequence left-to-right top-to-bottom, seamless last-to-first loop. Truly transparent background is essential so the stream can be layered over an existing golden fountain statue. Water must be visible against dark or light scenery.
