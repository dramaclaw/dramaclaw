# 桥下河面动态小样 v1

## 当前调整（revision 25）

用户确认桥下小样风格，反馈流速偏快并要求补齐上游、下游。三段河面统一改为 2 fps、16 帧、8 秒循环，喷泉保持原速。新增建筑右侧上游与柳树旁下游多边形水域，复用已验收的 river-water-v1.png，不另生成素材。遮罩绕开建筑与主要树冠，下游上缘沿用桥下区域的共享边界；岸边细节和分段接缝待用户实走验收。

## 初版记录

地图 revision 24。仅接入东侧石桥下方、柳树上方的一段河面，使用多边形遮罩保留桥体和河岸。素材由内置 imagegen 参考 base.png 生成，原样保存为 `frontend/public/piko/world/maps/welcome-courtyard/effects/river-water-v1.png`。

采用 4×4 图集、16 帧、4 fps，4 秒循环，每格内缩 3 px；复用环境精灵播放器，页面隐藏暂停、减少动态时显示首帧。没有修改全局设计变量或碰撞区域。此次为局部小样，水色、与静态河面的接缝、纹理尺度及循环流畅程度交由用户视觉验收，尚未扩展到全河。

## 生成提示词（内置 imagegen）

Use case: stylized-concept. Create a production game river water animation sprite atlas derived from the reference map's far-right river below the stone bridge. Reference is color and pixel-art style guidance only. Output a single PNG 1024x1024, strict 4 columns by 4 rows, 16 equal square frames edge-to-edge, zero gutters, zero borders, zero labels. Every cell is entirely opaque water texture, no scenery, no shoreline, no bridge, no trees, no objects. Fixed top-down texture plane. Match muted deep petrol blue and teal water in the bridge shadow, with restrained lighter turquoise short irregular horizontal ripple strokes and sparse warm pale cyan highlights; painterly pixel clusters matching the reference. Darker teal toward left, slightly lighter blue toward right, stable across all frames. All cells show the SAME surface evolving sequentially in row-major order, tiny ripples drifting downward, gentle slow flowing river, seamless 4-second loop at 4 fps; last frame leads naturally into first. No concentric fountain rings, no large white foam, no glow, no photorealism, no camera motion, no color flicker. Full opaque water fills every cell so the game can mask it to the existing river shape.
