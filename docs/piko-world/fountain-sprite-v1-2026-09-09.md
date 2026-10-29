# 喷泉精灵图小样 v1

## 当前调整（revision 20）

按用户反馈将播放速度由 8 fps 降到 4 fps，16 帧循环约 4 秒。新增 fountain-statue-foreground 静态前景配置，从 base.png 原位复用雕塑和底座像素，使用共用 createMapOccluder 裁出轮廓并放在水面之上（-0.5，高于水面 -1，低于角色）。未重新生成雕塑，也未加入水柱。已在 Canvas 实际渲染中确认层级；8 项定向测试、类型检查和差异检查通过，轮廓细节交由用户验收。

## 初版记录

用户决定环境动态统一采用序列帧/精灵图，代码只负责播放控制。地图 revision 19 已替换上一版代码椭圆涟漪；采用 16 帧、4×4 图集、8 fps 的水面动画，2 秒循环。运行时按图集实际尺寸划分网格，单元内缩 3 px 避开生成图集网格线。

素材：frontend/public/piko/world/maps/welcome-courtyard/effects/fountain-water-v1.png。使用内置 imagegen，以喷泉局部截图作为颜色与风格参考生成。图集为不透明水纹，运行时沿水面轮廓裁切成透明形状，并直接覆盖旧水面；雕塑和池沿仍来自底图，不移动或重复绘制。它是水面涟漪/水花小样，不包含独立下落水柱动画。

播放支持页面隐藏暂停、减少动态时显示首帧，卸载释放派生帧而保留共享图集直到 Assets.unload。环境模块从 water-ripples 替换为通用 environment-sprite。自动化覆盖真实帧推进、暂停恢复、区域遮罩与资源释放；类型检查通过。已在本地 Canvas 渲染预览检查贴合，视觉节奏最终由用户验收。

## 生成提示词

Create a production pixel-art WATER ANIMATION SPRITE SHEET for the referenced fountain pool. Reference image is style/color guidance only; DO NOT draw the golden statue, stone rim, grass, or any objects. Output one PNG atlas exactly 1024x1024, a strict 4 columns by 4 rows grid of 16 frames, each exactly 256x256, no margins, no gutters, no labels. Each entire cell is an OPAQUE seamless turquoise water texture (not a picture of a circular pool). The game clips these textures to its existing pool outline and excludes the statue. Restrained hand painted pixel art matching the reference teal blue water, mossy green caustics, creamy pale highlights. Camera fixed straight texture plane, no horizon. All 16 cells show the SAME water surface across successive steps of a seamless 2 second loop: concentric elliptical ripple rings expand away from center (128,128), small white water splash flecks near center drift outward and disappear. Clearly readable animation, moderate ripples; no huge waves, no sparkly noise, no glow. Keep average water color and positions stable across cells; change only ripple wave phase and little splash shapes. Flat low resolution pixel clusters, no photorealism. IMPORTANT 4x4 equal cells fill whole image edge-to-edge, full opaque turquoise water in every cell so original static water is replaced completely. Frame order row-major, last frame naturally leads into first.

实际工具输出为 1254×1254，保留原图；运行时使用实际网格尺寸，不假定输出遵守请求的 1024×1024。
