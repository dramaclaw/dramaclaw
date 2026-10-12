# 高清城镇 NPC

市集：m01 在左侧建筑门前 (810,435)，f01 / 小苔迁至右侧 (1230,430)，庭院不再放置。灯河街：用户选定现有 m02，放在右岸蓝顶建筑前 (1420,432)，显示尺寸缩小至默认角色的90%。大厅：书架前新增f02 / 书禾，站位(1630,425)，与室内玩家共用1.26倍透视显示。

## 素材和运行

参考 `frontend/public/piko/world/residents/resident-{id}-front-transparent-v1.png` 的现有造型，用内置 imagegen 重新生成透明高清三帧。选用结果保存在 `piko-world/art/source/town-npcs-hd-v1/`；每帧直接从高清原稿缩小至256像素，禁止经过64像素中间图。脚底232、锚点(128,228)、主体最高224像素。`scripts/build_piko_town_npc_idle.py --check` 可验证图集可复现。

通过独立静态 NPC actor 接入，不使用旧居民64像素行走图集或玩家输入控制器。自然站立、轻微肢体动作、眨眼三帧复用8秒待机时间表；书禾三帧均手持打开的书，第二帧轻微调整书页，第三帧短促眨眼，错开相位，减少动态效果时静止。按地图加载、离开释放，复用深度遮挡、昵称和阴影。书禾的身体、阴影、点击范围和气泡统一使用室内透视倍率。点击 NPC 直接在头顶显示一句人设台词，3秒后消失，重复点击重新计时。其他角色继续使用原有选择菜单。

## 验证

- 站位回归：从地图各入口可寻路到 NPC，脚底可站立，头部不被建筑遮挡。
- 图集回归：256像素物理帧映射64逻辑像素，线性采样；减少动态效果时复位，销毁实例保留共享纹理所有权。
- 浏览器：正式 PikoWorldCanvas 渲染市集、灯河街与庭院，验证 NPC 数量和站位；头顶台词交互另由组件回归验证。
- 前端构建通过；设计检查0错误，保留原有15条警告。

## 生成记录

内置生成目录：`$CODEX_HOME/generated_images/01a0e5a8-557d-7172-8e4f-f5e73c7a4c82/`。

- m01：`exec-f5339fc2-efc9-436c-815d-7bf068086539.png`
- f01：`exec-9c5a3b21-ec0c-4b77-b004-927fa9575dbd.png`
- m02：`exec-b99acac4-2e12-4e23-b6ff-d5886e4ed405.png`

### m01

```text
Use case: identity-preserve and style-transfer. Asset: a high-resolution 2D town NPC idle animation sprite sheet. Input image is the IDENTITY and COSTUME reference for resident m01, not a pixel rendering reference. Recreate this exact male character as clean high-definition hand-drawn chibi game art: swept spiky black hair with shaved right side, warm tan skin, small gold hoop earring, deep teal Chinese-inspired long tunic with tasteful gold embroidery, ivory patterned cuffs, black belt with gold rectangular buckle, jade pendant on belt, dark trousers and black/gold shoes. Preserve recognizable design and proportions. Smooth crisp navy outlines, controlled clean flat colors and restrained painted shading; NO chunky pixels, staircase edges, noise, white halo or magenta fringe.
Output exactly THREE full-body FRONT-facing poses in one horizontal row on a 1536x1024 genuinely transparent RGBA canvas. Equal 512px-wide cells, feet baseline y=900 in all cells, same character scale and ~760px full-body height, ample empty transparent margins. Pose 1: neutral relaxed standing with eyes open, empty hands at sides. Pose 2: same standing figure, tiny relaxed forearm/elbow movement, feet perfectly fixed. Pose 3: exact Pose 1 body and head with eyes gently closed for a short blink. All three heads must be identical in scale, position, facial contours, hair strands and eye placement; closed eyes are the only face change in pose 3. Keep shoulders/body proportions/outfit details and camera identical between poses, no head bob, no squash/stretch, no walking, no turned views. No text, no labels, no guides, no checkerboard drawn, no background, no floor or cast shadow. These poses will be displayed at about 110 pixels body height, so silhouettes and facial detail must remain readable.
```

### f01

```text
Use case: identity-preserve and style-transfer. Asset: a high-resolution 2D town NPC idle animation sprite sheet. Input image is the IDENTITY and COSTUME reference for resident f01, not a pixel rendering reference. Recreate this exact female character as clean high-definition hand-drawn chibi game art: long dark brown hair, green floral headband with pale blossom on her left (viewer's right), warm skin, cream blouse with green/gold botanical details, green collar and cuffs, dark belt with square gold buckle, layered forest green skirt and decorative sash, brown shoes. Preserve recognizable design and proportions. Smooth crisp navy outlines, controlled clean flat colors and restrained painted shading; NO chunky pixels, staircase edges, noise, white halo or magenta fringe.
Output exactly THREE full-body FRONT-facing poses in one horizontal row on a 1536x1024 genuinely transparent RGBA canvas. Equal 512px-wide cells, feet baseline y=900 in all cells, same character scale and ~760px full-body height, ample empty transparent margins. Pose 1: neutral relaxed standing with eyes open, empty hands at sides. Pose 2: same standing figure, tiny relaxed forearm/elbow movement, feet perfectly fixed. Pose 3: exact Pose 1 body and head with eyes gently closed for a short blink. All three heads must be identical in scale, position, facial contours, hair strands and eye placement; closed eyes are the only face change in pose 3. Keep shoulders/body proportions/outfit details and camera identical between poses, no head bob, no squash/stretch, no walking, no turned views. No text, no labels, no guides, no checkerboard drawn, no background, no floor or cast shadow. These poses will be displayed at about 110 pixels body height, so silhouettes and facial detail must remain readable.
```

### m02

```text
Use case: identity-preserve and style-transfer. Create a high-resolution 2D town NPC idle animation sprite sheet. Input is the IDENTITY and COSTUME reference for resident m02, not a pixel rendering reference. Recreate this exact male character as clean high-definition hand-drawn chibi game art: dark hair in a low ponytail toward viewer right, orange/gold patterned headband, thick eyebrows, tan skin, cream short-sleeve shirt, dark forest-green Chinese vest with gold toggles, brown belt with gold buckle and hanging small tools/pouches, dark cropped trousers, brown wrist guards/fingerless gloves and brown shoes. Preserve recognizable design and proportions. Smooth crisp dark outlines, controlled clean flat colors and restrained painted shading. NO chunky pixels, staircase edges, noise, white halo or magenta fringe. Output exactly THREE full-body FRONT-facing poses in one horizontal row on a 1536x1024 genuinely transparent RGBA canvas. Equal 512px-wide cells, feet baseline y=900 in all cells, same character scale and about 760px full-body height, ample transparent margins. Pose 1 neutral relaxed standing, eyes open, hands at sides. Pose 2 same figure with tiny relaxed forearm/elbow movement, fixed feet. Pose 3 exact pose 1 with gently closed eyes for blink. All three heads identical scale, position, facial contours, hair and eye placement. Keep shoulders, proportions, outfit and camera identical. No head bob, squash, walking, turned views. No text, labels, guides, drawn checkerboard, background, floor or cast shadow. Must read clearly at 110px body height.
```

## 姓名与欢迎语音

m01 名为阿砚，f01 保留小苔，m02 名为阿川，f02 名为书禾。书禾照看大厅书架，喜欢收集小镇旧故事，台词为「这本书里藏着小镇的旧故事，要不要一起翻几页？」。点击时同步触发头顶台词和欢迎语音，男性角色共用男性录音，女性使用女性录音。语音播放互斥，重复点击重播，切图、组件卸载或页面隐藏时停止。气泡仍显示3秒。

用户提供的 `男性npc欢迎语.wav` 与 `女性npc欢迎语.wav` 实际编码均为 MP3，保留原始音频数据，仅按真实格式保存为 `frontend/public/piko/world/audio/npc-{male,female}-greeting-v1.mp3`。

### f02 / 书禾（2026-09-30）

使用内置imagegen，以既有f02造型为身份参考、f01高清三帧为画风参考，生成双手持书、轻微翻动书页、闭眼眨眼的1536×1024透明三帧原稿。原稿保存为`piko-world/art/source/town-npcs-hd-v1/f02.png`，通过已有`build_piko_town_npc_idle.py`直接生成`frontend/public/piko/world/characters/town-npcs-hd-v1/f02-idle.png`，采用同一256物理像素、64逻辑像素和脚底锚点，未改变前三位NPC图集。

内置生成原稿：`$CODEX_HOME/generated_images/01a0eff0-34a5-7e30-9d85-1125c52b81fa/exec-c3f088c0-b365-4dd4-a9ad-d75a988dea13.png`。完整提示词：`piko-world/art/reference/town-hall-interior/prompt-bookkeeper-f02-v1.txt`。
