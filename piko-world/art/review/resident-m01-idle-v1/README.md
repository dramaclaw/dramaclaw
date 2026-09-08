# 居民 m01 正面母帧候选

候选已确认，现已从候选确定性制作三帧 SOUTH 待机图集，并接入初遇庭院镇长右侧供实机验收。此处为首位居民动作验证，不改变已有居民选择器，不代表其余九套外观或行走已完成。
保留 m01 的侧梳黑发、耳环、蓝绿色金纹衣装、玉饰及空手站姿。

`master-candidate-v1.png` 是保留的 RGB 参考，不能直接运行。`scripts/build_piko_resident_idle.py` 已移除边缘连通的浅色棋盘格，规范为 64×64、脚底 y=57 的真透明帧；正式文件为 `resident-m01-idle-sheet.png`。包含站立、上身抬升 1 像素、眨眼三姿态，4800 ms 循环，脚部固定。母帧仍待用户实机视觉验收。

共用运行时为 `character-actor.ts` 与 `character-shadow.ts`，镇长也已改为调用同一播放器；居民只配置帧数、时间轴、站位及 24×8 阴影。源稿和已有镇长图集未被覆盖。当前合成衣装不承诺支持换装；可换装分层将在共享人类骨架确定后派生。

后续顺序：确认像素化外观 → 真透明与 64×64 母帧生产（居民高 56 px，脚底轴心 32,57）→ 确定性呼吸、眨眼帧 → 复用角色时间轴与 character-shadow → 地图内验收。方向与行走在正面母帧确定后扩展。不建立单独验收网站，不逐帧用生成模型重画。

## 本轮生成提示词

Use case: style-transfer. Asset type: Piko Piko resident m01 SOUTH idle master candidate. Image 1 is identity and outfit reference; image 2 is ONLY pixel density, outline and shading style reference, do NOT draw the mayor. Produce ONE full-body front-facing human resident on genuinely transparent background, no ground shadow, no text, no grid or labels. Preserve image 1 black side-swept asymmetric hair and shaved side, warm tan skin, gold ear ring, teal Chinese-inspired tunic with simplified gold pattern, cream cuffs, belt and jade hanging accessory, dark trousers and shoes. Preserve male facial structure and friendly neutral expression. Arms relaxed downward, empty hands, feet planted level, neutral symmetrical skeletal stance for future animation. Rebuild as strict chunky low-resolution pixel art matching image 2: intended logical canvas 64x64, visible human height56 pixels, foot baseline57, centered x32; render enlarged nearest-neighbor for inspection. Flat limited palette, crisp navy stepped outlines, no anti-aliasing, no gradients, no texture noise. Compact rectangular dark eyes each with single pixel glint, no large anime white eyes. Human silhouette slightly taller than mayor, not broader or mascot-shaped. Enough transparent padding to keep all hair/shoes visible. This is one master pose not a sprite sheet. Simplify ornamentation into readable pixel clusters without changing clothing identity.

参考：`../../source/residents/resident-m01-front-transparent-v1.png`（身份），`../mayor-idle-v1/master-preview-8x.png`（像素风格）。
