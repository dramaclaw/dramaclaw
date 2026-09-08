# m01 方向母稿

## 当前运行版本（v5）

当前运行图集为 `resident-m01-motion-v5.png`：近/远臂摆幅分别为 6/8 原始像素，侧面摆动端点抬手 1 像素形成浅弧；正背面保持原幅度。腿部、待机和尺寸不变。下方为旧版记录。

当前为 `resident-m01-motion-v4.png`。侧面采用远臂、躯干、近臂三层合成，远臂相位相差半周期，肩部内收 2 像素，远臂摆幅 7 像素以在轮廓外可读；近臂及腿部不变。新增检查确认远臂露出且不覆盖原有前景。以下 v3 为历史说明。

运行时已切换 `resident-m01-motion-v3.png`。侧面步幅从 ±3 调整为 ±5 原始像素；增加固定肩部的反向摆臂，正背面幅度为 ±2 像素。保持头部、待机、尺寸、速度和阴影。检查涵盖手臂/腿脚连通、摆臂帧差异、侧面步幅及头部保真。制作脚本产出 v3；下面的 v2 内容仅作历史记录。

## v2 历史记录

当前已切换为 `resident-m01-motion-v2.png`，v1 保留作历史对照。v2 使用 `scripts/piko_leg_rig.py` 的方向专属髋、膝、踝连接与完整鞋轮廓，替代 v1 的按画面中线切块位移。正背面减小抬脚幅度，侧面区分前后腿绘制顺序。上半身及待机保持原稿，未增加摆臂。新增逐帧腿脚四邻域连通性与衣摆以上保真检查；这不代替实际步态观感验收。

- 已用 `scripts/build_piko_resident_walk.py` 从方向参考确定性生产四方向母帧及 `resident-m01-motion-v2.png`；未再次调用生成模型。
- 图集为 448×256，每格 64×64，方向按 SOUTH / WEST / EAST / NORTH 排列，每行前 3 格为待机、后 4 格为行走，行走每帧 125 ms。正面待机前三帧与已验收版本逐字节一致。非正面第三待机格暂为静态，不伪造背面眨眼。
- 使用与正面一致的有限调色板、二值透明和脚底轴心 (32,57)。左右方向从独立母稿取得，不镜像饰品。四拍步态共用关节绘制流程、各方向配置连接点，不代表换装分层已经完成。
- 已接入地图移动，保持居民放大 15% 后的尺寸和共用阴影。以实机动作验收为准，不另建预览页。
- 自动检查：`scripts/test_build_piko_resident_walk.py` 覆盖帧尺寸、透明、脚底基线、正面保真及逐帧可复现。

以下为此前方向候选记录：

`directions-candidate-v1.png`：内置 imagegen 生成的 WEST / EAST / NORTH 三方向参考候选（从左到右），尚未作为动画图集接入。SOUTH 使用已验收的 `../resident-m01-idle-v1/resident-m01-south-master-64.png`，不得用新图替换。

方向细节：角色解剖左侧有剃短发、耳环和玉饰；向屏幕左看时可见，向屏幕右看时不镜像复制；背面保持左侧挂饰与素色衣背。

后续须统一到 64×64、角色高 56 px、脚底轴心 (32,57)，锁定四方向衣摆与头身比例，再以确定性像素编辑制作四帧步态。保持已验收运行时缩放 `(82/48)*1.15`，复用 character-actor 和 character-shadow，不新建预览网站。

## 生成提示词

Use case: identity-preserve. Asset type: Piko Piko resident m01 three-direction turnaround reference sheet, NOT animation frames. Image 1 defines exact identity/outfit, Image 2 defines runtime pixel simplification. Produce a single wide sheet with THREE equally sized full body figures in separate equal columns, same height and foot baseline: left column strict profile looking SCREEN LEFT (WEST); middle column strict profile looking SCREEN RIGHT (EAST); right column straight BACK view (NORTH). No front view. All in neutral planted idle stance, arms at sides, empty hands. Preserve black asymmetrical side-swept hair, warm tan skin, teal tunic, cream cuffs, gold hem, dark trousers/shoes. Anatomical LEFT side (screen right in the supplied front reference) has shaved temple, gold earring and jade belt pendant. In WEST profile this anatomical LEFT side faces camera, so shaved side/earring/jade visible. In EAST profile show opposite anatomical side, long swept hair and NO mirrored earring or jade ornament. Back view: shaved region on screen LEFT, longer swept hair on screen RIGHT, plain teal back without invented front chest embroidery/buckle; jade may peek at left hip. Keep same compact human body, head proportions and consistent hair volume across views, subtle game top-down angle matching reference, not isometric or 3/4. Strict chunky pixel art intended for 64x64 frames and 56px figure height, simple flat limited palette, clear stepped navy outlines, no gradients, no blur. Generous gaps and margins for slicing. Genuinely transparent background, no checkerboard pattern, no ground or shadow, no text, no labels, no props, no new accessories.
