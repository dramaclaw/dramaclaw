# 玩家动作素材与构建

## 当前正式版本

- 男角色：`frontend/public/piko/world/characters/player-male-motion-v5.png`。
- 女角色：`frontend/public/piko/world/characters/player-female-motion-v6.png`。
- 男女坐姿：同目录 `player-{male,female}-sit-{front,idle}-v2.png`。
- 配饰锚点：`frontend/src/features/piko-world/runtime/player-head-anchors.json`。

每个角色图集1536×1024，四方向按正面、向左、向右、背面排列，每方向6列：自然站立、轻微肢体动作、眨眼、迈步A、收腿、迈步B。物理单帧256×256映射64×64逻辑尺寸，高清原稿直接缩小，以线性采样显示。主体最高224像素，脚底232，锚点(128,228)。

行走按[3,4,5,4]循环，随移动距离推进；速度153.9地图像素/秒，完整步态56源像素。待机为8秒周期，眨眼和肢体动作时间表见 `DESIGN.md`；背面不眨眼。坐姿主体最高200像素，脚底216、臀部锚点(128,128)，4秒周期中短暂眨眼180毫秒。

## 头脸稳定

每方向三张行走帧共用第4列收腿帧的头脸纹理，完整复制透明边缘，保留颈部以下身体动作。裁切边界依正面、左、右、背顺序：男(90,88,90,94)，女(90,88,88,90)。配饰锚点从正式图集采样，同方向行走帧的锚点相同。水平对齐值固定在编译器中，不再依赖旧版低清图集。待机、坐姿保留已确认像素。

## 原稿与可复现构建

原稿存放在 `piko-world/art/source/`，不进入前端发布包：

- `walk-three-source-v1/female-{south,west,east,north}.png`：女角色三帧行走。
- `motion-source-v2/male-{south,west,east,north}.png`：重新生成的男角色三帧行走。
- `motion-source-v2/{male,female}-idle-body.png`：四方向三帧待机。
- `motion-source-v2/{male,female}-sit.png`：基础坐姿与眨眼。
- 构建清单位于原稿目录；NPC 原稿、运行图集与脚本见 [城镇 NPC](town-npcs-hd.md)。

```sh
.venv/bin/python scripts/build_piko_player_three_frame_motion.py
.venv/bin/python scripts/build_piko_player_seated.py
.venv/bin/python scripts/build_piko_player_head_anchors.py
```

上述命令均支持 `--check`，按像素和清单校验已有产物而不写入文件。构建失败时不会覆盖尚未验证的图集。旧八帧构建脚本、中间版本、试稿与评审页面已退出当前工程；9月17日版本的过程记录保留在 `history/`，不作为当前构建说明。

## 正式素材生成提示词

以下保留最终使用原稿的提示词，均通过内置 imagegen 生成。造型参考来自 `piko-world/art/source/player-{male,female}-directions-v1.png`。

## 女角色行走提示词

### female-south

Create a three-pose transparent walking sprite sheet of the SAME girl in the reference's FRONT view (top-left reference). All poses face directly toward viewer, walking DOWN toward camera. Preserve brown bob, face, white collared shirt with pink flower, sage knee-length pleated skirt, brown Mary Jane shoes, proportions and clean high-resolution illustrated style. Layout 2x2 equal cells: top-left A left leg forward/right leg back with opposite arm swing; top-right B both legs naturally close together under hips, arms relaxed vertical, reusable neutral passing stance; bottom-left C right leg forward/left leg back with opposite arm swing. Bottom-right EMPTY transparent. Loop A B C B. Distinguish A/C by which shoe is lower/forward and arm swing, no sideways wide stance. Lock head, torso, size, camera and baseline across poses. Modest steps, no high knees, no running. Genuine alpha background, no ground, shadows, text or grid. Generous transparent margins around each figure.

### female-south correction

Edit ONLY bottom-left girl pose in this transparent three-pose front-facing sprite sheet. TOP LEFT and TOP RIGHT stay exactly unchanged. Bottom-left must be OPPOSITE stride from top-left: viewer-RIGHT leg extends forward with shoe LOWER and sole planted; viewer-LEFT leg goes back, shoe HIGHER. Viewer-LEFT arm swings FORWARD with bent elbow and larger visible hand; viewer-RIGHT arm goes BACK nearly straight. Current bottom-left wrongly repeats top-left leg. Swap the leg depth and arm swing ONLY, do not mirror face/hair/flower/shirt, all those remain identical. Keep head/torso upright frontal, no head movement, same stature and ground baseline. Neutral relaxed walk. Bottom-right stays empty. Preserve genuine transparent alpha and no background.

### female-east

Generate THREE walking poses of the reference GIRL facing RIGHT, using bottom-left reference for exact identity and orientation. Same brown bob, white blouse with pink flower, sage knee-length skirt, brown Mary Jane shoes. HIGH RESOLUTION sharp clean illustration, same proportions. 2x2 transparent sprite sheet: top-left A near leg extends forward RIGHT and far leg back LEFT, near arm swings BACK LEFT; top-right B both legs naturally close beneath hips, arms relaxed straight down, feet nearly together; bottom-left C near leg extends BACK LEFT and far leg forward RIGHT, near arm swings FORWARD RIGHT. C MUST have opposite near/far overlap and opposite arm from A, do not duplicate. Bottom-right entirely empty. All three look RIGHT, no mirroring entire body between frames. Loop A B C B. Modest relaxed stride, no high knee or run. Head and torso stay identical in size, orientation and position relative to cell, foot baseline stable. Equal cells with transparent margins. Genuine transparent alpha, no ground shadow, no grid, no labels, no background.

### female-north

Three-frame walk sprite sheet of SAME girl from reference, BACK view (reference bottom-right). Every frame shows back of head, NO face, white blouse back, sage knee-length pleated skirt, brown Mary Jane shoes, brown bob. Walking AWAY from viewer/up-screen. Exactly THREE characters in 2x2 equal cells, bottom-right EMPTY. Top-left A: viewer-LEFT foot trailing DOWN screen with heel lifted, viewer-RIGHT foot forward UP screen; viewer-left arm swings forward/up-screen and right arm backward toward viewer. Top-right B: neutral, feet close side by side directly below hips, arms hanging down naturally, no raised knee. Bottom-left C: OPPOSITE, viewer-RIGHT foot trailing DOWN screen heel lifted, viewer-LEFT foot forward UP screen; arm swing opposite A. A and C MUST NOT repeat same leg. Show back-facing shoe heels/soles appropriately. Gentle modest walking, no run or wide sideways step. Same head, torso, proportions and clothing in all frames, fixed camera, head position and support baseline. High-resolution clean illustrated style as reference. Actual transparent alpha; no checkerboard, no scenery, shadows, text or grid. Generous transparent gutters.

### female-north correction

Change ONLY the arms of the BOTTOM LEFT back-facing girl. Her viewer-LEFT arm must bend forward AWAY from viewer, hand partly hidden beside torso, like the viewer-right arm currently does. Her viewer-RIGHT arm must swing backward TOWARD viewer, extending down/outward with visible hand, like viewer-left currently does. Thus bottom-left arms are OPPOSITE of top-left arms, matching opposite legs. Keep all heads, torso, legs, shoes, skirt, other cells, proportions and transparency EXACTLY as they are. No other changes.

### 女角色向左样稿

Edit this transparent female left-facing walk sprite sheet. Preserve top-left and bottom-left stride poses exactly. Replace TOP RIGHT pose with one neutral passing pose: both legs naturally close together beneath hips, knees relaxed almost straight, shoes beside each other with tiny front-back offset, NO bent-back lifted leg, NO raised knee. Arms hanging naturally almost vertically close to torso, hands relaxed. Match identical head, face, brown bob, white collared shirt with pink flower, sage knee-length skirt, brown shoes, proportions, scale and ground baseline. Remove bottom-right figure entirely leaving that cell transparent. Output same 2x2 layout containing exactly THREE poses: top-left stride A, top-right neutral passing B, bottom-left opposite stride C, bottom-right completely empty. Intended loop A B C B. Keep existing high-resolution clean hand-drawn art, genuine transparent alpha, no ground shadow, no text, no grid, no checkerboard. All heads face LEFT.


## 男角色行走与男女坐姿提示词

### Male seated

Generate a NEW two-frame seated game sprite sheet using the original boy design reference. TWO full-body FRONT-facing seated poses side by side. He sits upright on an INVISIBLE bench, thighs toward camera, knees bent 90 degrees, lower legs hanging vertically, both shoes visible below knees. Hands resting relaxed on thighs, elbows beside torso. Left pose eyes open, right pose brief natural blink with eyes closed. Otherwise poses identical: same head outline and dimensions, same hair, same body size, identical hands, knees, feet and hip positions. Preserve original boy white leaf shirt, slate cargo shorts, brown sneakers and brown swept hair. Match original head/body proportions, crisp high-resolution illustration. Transparent alpha background. Draw only character, NO bench, chair, ground, shadow or text. Equal scale and foot baseline in both cells.

### Female seated

Generate a NEW two-frame seated game sprite sheet using attached ORIGINAL girl character design reference. TWO full-body FRONT-facing seated poses side by side. She sits upright on an invisible bench, thighs toward camera, knees bent 90 degrees, lower legs hanging vertically, brown Mary Jane shoes visible below knees. Sage green skirt drapes naturally over seated thighs and covers them, knees together. Hands resting gently on skirt above knees. Left pose eyes open, right pose short natural blink with eyes closed. All other features identical across frames: same head size and outline, same hair, torso, hands, skirt, feet and hip positions. Preserve original brown bob haircut, white pink-flower blouse, sage skirt and brown shoes. Match original proportions and clean outlined high resolution illustration. Isolated characters on actual transparent alpha background. No visible chair, bench, scenery or text.

### Male east

Create a NEW animation sheet based on the original boy design attached. Three right-facing profile figures side by side on transparent background. Same head size, body proportions, clothes, hairstyle and scale in every frame. Important: frame 1 and frame 3 must have OPPOSITE ARM POSITIONS, not duplicates. Frame 1: visible near arm extends BACKWARD toward LEFT edge, opposite arm extends FORWARD toward RIGHT edge; near leg reaches forward right. Frame 2: feet together, arms down, neutral standing profile. Frame 3: visible near arm extends FORWARD toward RIGHT edge, opposite arm extends BACKWARD toward LEFT edge; near leg reaches backward left. Natural modest walking stride. Clean original illustration style, white leaf shirt, gray cargo shorts, brown shoes. Exactly three full figures, one head each, no extra art or text, no shadows.

### Male south

Draw a new transparent game sprite strip of original boy from attached reference, FRONT VIEW. Exactly 3 full-body figures horizontally. First figure: arm on IMAGE LEFT hangs down behind, arm on IMAGE RIGHT bends forward at waist; leg on IMAGE LEFT steps forward, leg on IMAGE RIGHT behind. Middle figure: neutral symmetrical standing, feet side by side, arms down. Third figure: arm on IMAGE RIGHT hangs down behind, arm on IMAGE LEFT bends forward at waist; leg on IMAGE RIGHT steps forward, leg on IMAGE LEFT behind. First and third poses must visibly have OPPOSITE arm and leg positions. All three heads identical size, same face, hair, same body proportions and camera scale. Preserve original boy clothing and design. Transparent background only, no glow or shadows. Crisp outline high-resolution sprites, generous space between figures.

### Male north

Final regeneration prompt:

Transparent-background sprite sheet for a game. Use attached boy only as character design reference. Draw three new BACK-facing walking frames in a horizontal row, same scale and same head dimensions. Left: left foot steps ahead, right arm swings ahead. Center: standing neutral, feet together, hands down. Right: right foot steps ahead, left arm swings ahead. Opposite arms and legs in left/right poses. All figures face directly away from camera, brown hair rear view, white shirt, gray cargo shorts, brown sneakers. Match reference style. Isolated cutout sprites with actual transparent alpha between and around them.

### Male west

Create a NEW game animation sheet from attached ORIGINAL boy design. Three LEFT-facing profile figures side by side on transparent background. Preserve original identity, hairstyle, white leaf shirt, gray cargo shorts and brown shoes. Identical head size, torso proportions and scale for all poses. Pose A: near leg extends LEFT forward, near arm swings RIGHT backward, far arm forward visibly. Pose B: neutral upright standing with FEET TOGETHER, arms down. Pose C: near leg extends RIGHT backward, near arm swings LEFT forward, far arm backward visibly. A and C must be opposite strides, with opposite arm positions. Natural modest walk, consistent head outline and anatomy. Aligned baseline, uniform margins, one head per person. Crisp high-resolution original illustration style. No text, no shadows, no additional objects.

## 男女待机提示词



### Male layout constrained

Edit this exact sprite layout. Keep all twelve figures, dimensions, proportions, heads, hairstyles, legs, shoes and foot placements exactly as shown. FIRST ROW stays unchanged. SECOND ROW ONLY: create tiny idle arm movements, one elbow bends slightly so the hand rests lightly at the trouser side seam; other arm relaxes, eyes stay open. Change arms only, not heads or body size. THIRD ROW ONLY: close the visible eyes for a natural blink; otherwise identical to first row; back view stays unchanged. Preserve original canvas layout, 4 columns x 3 rows, transparent alpha and original linework. No rescaling, no enlarged heads, no shorter bodies, no pose-dependent zoom. Do not introduce shadows or a background.

### Female layout constrained

Edit this exact sprite layout. Keep all twelve girl figures, dimensions, proportions, heads, hairstyles, skirts, legs, shoes and foot placements exactly as shown. FIRST ROW stays unchanged. SECOND ROW ONLY: tiny natural idle arm movements, one elbow bends gently so the hand rests beside the skirt seam; other hand loosens slightly outward, eyes stay open. Change arms only, no skirt lifting, no head or body resizing. THIRD ROW ONLY: close visible eyes for a natural blink; otherwise identical to first row; back view unchanged. Preserve canvas layout, 4 columns x 3 rows, transparent alpha and original linework. No rescaling, enlarged heads, shortened bodies, pose-dependent zoom, shadows or background.

### Female alpha correction

Remove the entire baked gray-and-white checkerboard background from this sprite sheet. Return actual transparent alpha pixels everywhere outside the twelve girl sprites, including between arms and torso, between legs and inside empty regions. Preserve each character's artwork, proportions, poses, face expressions and positions exactly. Do not redraw, resize or alter the sprites. Do not draw a checkerboard or any background. Transparent PNG cutout only.
