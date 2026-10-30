# 草丛微风小样 v1

## 路边草丛删除（revision 32）

按用户截图删除 northwest-grove，现为 26 簇；草丛尺寸与播放频率不变。同轮按用户要求将喷泉水面及四股水柱从 4 降至 3 fps、三段河面从 2 降至 1.5 fps，均降低 25%。

## 道路避让（revision 31）

按用户截图，将 north-hall-west、west-pavilion、east-path-shrub 三簇移至绿色草地，删除压在东北树上的 north-hall-east。现共 27 簇。后续选点必须在绿色地面，不能放在道路或树冠上。尺寸与节奏不变，等待位置验收。

## 树丛边缘扩展（revision 30）

用户反馈六簇偏少，要求每片树丛一至两簇。保留六簇，补充 22 簇，总计 28 簇，覆盖西北与北侧林缘、东北林缘、西亭和西花园、西侧松树及内花园、东侧树丛与柳树岸边、南侧林缘。均为 96×96、3 fps 往返播放，共享同一素材，起始相位分散到 14 个播放步。按树丛外围草地选点，具体贴合与密度待用户实走验收。

## 六簇布置（revision 29）

用户已确认 revision 28 的素材、尺寸与节奏，授权先放六簇。保留喷泉右下方，新增喷泉左侧、东侧石凳右侧草地、西侧地图牌右侧、南入口左右两侧，共六簇。统一 96×96、前 8 帧、3 fps 往返，复用同一图集，不新增碰撞。startStep 分别为 0、2、4、6、9、11，错开摆动相位；减少动态时各自保持起始帧。布置疏密与位置待用户验收。

## 尺寸与节奏调整（revision 28）

用户认可往返播放改善，反馈尺寸略大、频率偏快。范围缩至 96×96，坐标 (1198,626) 至 (1294,722)，保持根部位置基本不变；速度由 6 fps 降到 3 fps，14 步往返循环约 4.67 秒。后续环境动态默认舒缓节奏，先小样验收，不默认沿用较快播放速度。

## 修正（revision 27）

用户反馈原图集第三排朝向跳变、2 fps 播放生硬、尺寸和动态识别度偏低。尝试内置 imagegen 重生成后仍存在朝向不一致，未采用该候选。当前复用 v1 图集前 8 帧，排除后两排，使用 0→7→0 往返播放，端点不重复；6 fps、14 步约 2.33 秒循环。播放范围由 72×72 放大至 112×112，坐标 (1190,612) 至 (1302,724)，大致保持原根部位置。素材内部帧间差异仍需用户视觉验收，往返播放不等于重新绘制了连续中间帧。

播放器新增可选 playback 配置，默认仍循环；河面和喷泉不改变。测试覆盖往返端点、相邻步进和原循环模式。

地图 revision 26。河面 revision 25 已获用户视觉验收，开始少量草木动态节点。

喷泉右下方草地新增一簇低矮草丛小样，图集绘制范围为地图坐标 (1210,648) 至 (1282,720)，含透明留白。内置 imagegen 参考 base.png 风格生成，素材原样保存至 `frontend/public/piko/world/maps/welcome-courtyard/effects/grass-breeze-v1.png`。它是新增点缀，并非替换地图原有树木。

4×4 图集、16 帧、2 fps、8 秒循环。复用现有播放器与减少动态、页面隐藏暂停逻辑，不新增碰撞。摆幅、草叶尺度、透明边缘和循环连续性待用户验收，尚未铺到其他区域。

## 生成提示词（内置 imagegen）

Use case: stylized-concept. Asset type: transparent pixel-art grass animation sprite sheet for the referenced cozy top-down village game. Reference map is STYLE AND PALETTE guidance only. Create ONE small low wild grass tuft with a few tiny pale yellow flower buds, olive green and warm sunlit yellow-green, dark muted green leaf bases, painterly crisp pixel clusters. Output one PNG with REAL transparent alpha background, 1024x1024, a strict 4 by 4 grid of 16 equal 256x256 cells, no gutters or grid lines. Each cell contains exactly the SAME single tuft in identical scale, rooted at local (128,210), occupying about 180x130 pixels with generous transparent padding. Fixed top-down three-quarter game view matching map. Sixteen successive frames row-major of a gentle breeze loop: only upper leaf tips bend slightly right then return then slightly left then return, amplitude at most 6 pixels; roots, flower count, colors, lighting and size stable. All frames are consecutive phases, not different plants. Last frame seamlessly leads to first. No ground, no soil patch, no pot, no shadow ellipse, no scenery, no text, no labels, no checkerboard baked in. Transparent outside the blades. Restrained motion, not bouncing or scaling.
