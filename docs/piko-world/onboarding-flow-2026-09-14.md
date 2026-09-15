# 入场动画与角色创建接入 — 2026-09-14

当前：已接入本地应用，未提交、未部署。入口为 `/piko-world`，前端开发服务为 `http://127.0.0.1:5173`。

## 已完成

- 用户回传的男女透明 PNG 已原样入库，均为 1065×1476 RGBA。男角色使用金色叶片胸针，女角色使用粉色花瓣胸针，保留用户选定的第二版闭嘴微笑。
- 背景使用第二版树屋花园，未使用第一版正式迎新亭。
- 首次进入播放 30.048 秒成片；支持播放被拒后的手动播放、静音、跳过、错误重试、慢加载提示和后台暂停。减少动态效果偏好下不自动播放，仍可主动播放或跳过。
- 视频自然结束或跳过后约 800 ms 淡黑，确认创建素材就绪后切换，约 800 ms 渐显。素材失败时黑场显示重试及返回入口；不会提前激活隐藏表单。
- 创建页只有一步：选择男女、输入昵称、确认进入。复用昵称规范，1–16 字符、首尾空白归一化。
- 保存按账号隔离的角色记录与已有个人资料，存储失败保留表单并允许重试；完成后再次进入跳过视频和创建。旧十人 NPC 选择记录不算新流程完成，已有用户首次使用新版本需创建一次。
- 创建期间不挂载地图，避免场景音频与视频叠加；确认后沿用现有地图加载页及地图名过渡。
- 设置菜单为「修改个人信息」「角色装扮」。装扮窗按左服装格、中间角色、右配饰格排列，确认按钮位于角色下方；显示实际玩家性别和当前昵称。
- 尚无服饰库存，空格位不可交互；当前基础服饰包含母稿中的胸针，尚未拆成可替换配饰。确认仅关闭弹窗，不假装完成不存在的换装。
- 中、英、越三语文案已补齐。手机创建页可纵向滚动，装扮窗保持三列。

## 当前限制与下一步

**地图中的新玩家目前使用正面透明图作为临时显示。** 移动、寻路、碰撞、名称、切图和独立阴影沿用已有逻辑，但尚无转向、摆臂或迈步动画。没有将旧 NPC 偷换为新玩家，也没有把重复正面帧当作行走图集。

下一步制作男女四方向静态图，再派生待机／行走。未来身体、衣服、胸针及其他配饰需统一画布、脚底基线、肩部与髋部挂点和帧序。现有演员合约为每帧 64×64、每方向 11 列、四行，脚底 pivot (32,57)；新素材最终须验证兼容或显式升级合约。

账号和角色数据目前仍为本地存储，与现有个人资料一致，不代表已增加服务器同步。清除浏览器存储会重新走创建流程。

## 素材

运行目录：`frontend/public/piko/world/onboarding/`。

- `player-male-v1.png`、`player-female-v1.png`：用户透明原件，未重采样或重新抠图。
- `welcome-garden-v2.png`：用户选定第二版背景。
- `intro-v1.mp4`：浏览器派生，11,553,421 字节；H.264、1280×720、24 fps、faststart，AAC 原轨复制。原视频 43,260,981 字节，路径 `/Users/yangzhen/Desktop/piko piko素材/入场动画.mp4`。
- 视频原轨与派生轨 SHA-256 一致：`74131be31d9d12c593ff6558f8256f7948f3a881cdb577d8d78544291646b1b9`。未宣称完成音频主观听感验收。

## 验证

- Piko 及入口合约：64 文件、264 测试通过；随后增加减少动态效果的主动播放回归，定向复查入场测试 6 项通过（累计现有用例 265 项）。
- TypeScript 与 Vite 生产构建通过，保留既有大分包及 canvasNodes 混合导入警告。
- 浏览器实测：自动播放受限提示、跳过、选择女生并保存昵称、进入真实 Canvas 庭院、设置两项菜单、装扮窗使用所选女角色。
- 桌面 1440 视口与手机 390×844：图片加载成功、创建页焦点落在昵称框，装扮窗无横向溢出。
- 浏览器完整播放 30.048 秒视频，真实 ended 事件触发创建页渐显，焦点落于昵称框。
- DESIGN.md lint：0 errors、15 项既有 warnings；git diff --check 通过。
- 临时浏览器检查入口已移除。
- 本轮截图在 `/private/tmp/piko-creation-desktop.png` 与 `/private/tmp/piko-wardrobe-desktop.png`，仅为检查产物。

## 设计记录

[Superdesign 预览](https://p.superdesign.dev/draft/8a2874af-f612-4a5c-8da5-9e0b5d7b9d95)用于布局讨论，真实流程以本地应用为准。`piko-world/art/review/onboarding-v2/` 保留造型迭代、提示词与用户选择记录。

## Afternoon revision: open hillside and game controls

- Background now `welcome-hillside-v3.png`: open valley and hillside, natural left foreground stone footing, quiet right meadow.
- Creation uses scoped cream paper / light wood / moss selected tab / honey button; exception recorded in DESIGN.md. No heading or nickname badge; plain nickname above player. CTA is 开始旅程.
- Gender changes and valid confirmation reuse `playPikoUiSound("open")` / existing `ui-open-v1.wav`. Explicit video mute also suppresses these clicks; automatic silent playback fallback does not suppress gesture-triggered UI sounds.
- Header entry covers workbench with 800ms black fade before navigation. Video first frame fades in; normal invitation gate removed. Audible autoplay attempts first, then muted autoplay. A resume control remains only for blocked or interrupted playback, and errors retain retry/skip.
- New male white master: `piko-world/art/review/onboarding-v2/player-male-v6-white.png`. Awaiting user's manual cutout, so runtime keeps existing transparent male. Female unchanged. Existing static player animation limitation remains.
- English BGM prompt in `creation-bgm-prompt-en.md`; audio asset pending user generation.
- Superdesign existing draft updated to v3 (35 credits). Current preview uses existing transparent male pending cutout.
- Verification: Piko suite 266 tests passed; production build passed; DESIGN lint 0 errors / 15 baseline warnings. Browser checked natural video end and desktop creation layout.

## Lightweight revision and final male cutout

Male asset now `player-male-v2.png`, copied byte-for-byte from the user transparent PNG (1065×1476, alpha bounds top99/baseline1367). Shared creation/map/wardrobe resource updated. Female footing remains independent.
Creation form now has no border or shadows, radius26; controls radius18, thin input outline, no raised decoration. Left title uses built-in imagegen `create-character-title-v1.png`, width160–190px, accessible alt text. Prompt: exact four Chinese characters 创建角色, one horizontal line, gentle hand-lettered pixel edges, moss-green fill and fine cream keyline, transparent background; no plaque, frame, shadow, extrusion or decorative objects. Original generated file preserved.
Focused onboarding/player tests 9 passed; build passed; design lint 0 errors, 15 baseline warnings.

## Final detail refinement

Title now `create-character-title-v3.png`, generated with built-in imagegen: exact 创建角色, playful moss-green rounded Chinese lettering, cream outline, small sprout, daisy and restrained golden accents; transparent background, no plaque. Display width124–144px, left16px. Earlier plain v2 is retained as history, not used.
Panel radius18, controls12. Gender hover changes fill, primary hover brightens; active feedback remains. Nickname is dark text on a thin warm-white translucent base, no text stroke/shadow. Preview now compensates for male/female transparent bottom margins (109 and76 pixels of1476), matching runtime compensation so visible shoes share a baseline.
Background video prompt is in `hillside-background-video-prompt.md`; use original background only, fixed camera/stone, gentle wind/water/clouds, 8–10 second loop.

## System integration confirmed

User correction: retain 开始旅程 → loading screen → map title → map. The temporary startAtMapTitle bypass was removed before delivery. Production `/piko-world` already mounts PikoWorldExperience and uses the approved onboarding assets/styles. Title width enlarged exactly5% to clamp(130.2px,10.5vw,151.2px).
Four user-supplied PNGs added byte-for-byte to the randomized loading library (8→12): mountain-observatory-v1, amber-expedition-v1, frozen-lake-rest-v1, tidal-discovery-v1. Scene copy added in zh/en/vi. Selection, preload, failure recovery and timing retain existing behavior. Dynamic creation background and creation BGM still await user-provided media.

## Development replay / moving background / wardrobe master

During this development phase every production `/piko-world` mount starts onboarding with an empty nickname. The current account's Piko player/profile localStorage records are removed; login and other accounts are untouched. Completing creation still saves the new identity for the current visit, then follows loading → map title → map. Restore persisted-player initialization when development replay is no longer needed.

Creation background: user `/Users/yangzhen/Desktop/角色创建页背景.mp4`, copied unchanged to `welcome-hillside-loop-v1.mp4` (8.041667s,1280×720,H264,no audio). `PikoCreationBackground` uses two silent players with a1.2s overlap; outgoing image remains opaque while incoming opacity rises, avoiding a dark midpoint. It pauses when hidden/inactive and keeps the original poster for playback failures. Only creation stages load/play this movie.

Map music normal volume0.22, notification duck0.09.

Wardrobe: same profile dialog title16px, description12px, section labels14px, existing pixel close button and warm confirmation button; left clothes / center player / right accessories retained. Runtime temporarily uses the existing profile three-slice skin. Dedicated master generated with built-in imagegen is `piko-world/art/review/onboarding-v2/wardrobe-panel-master-v1.png`; user will cut out and provide top/middle/bottom before the dedicated skin is wired. Prompt: same ivory/honey wood, turquoise inlay, leaves and amber lamps as profile frame; hanger crest, folded cloth and accessory pouch; clean constant-width vertical rails for extensible middle, no text/widgets/characters; pure white outside for manual cutout.


最新调整：装扮弹窗换为用户提供的衣架顶饰三段素材，最大宽缩至640px；创建表单上移并靠近角色，增加标题，选中态改暖金。女性角色换为紧裁切v2，按素材高度校准显示和地图落脚点。影片控件移至右上并缩小、加入背景模糊。地图环境声播放增益降至原来的70%，保留BGM基础音量0.22。

## 2026-09-15 验收与创建页 BGM

- 创建页改用初遇庭院 `welcome-courtyard-01.mp3`，复用音乐播放逻辑：创建画面渐显时开始，2 秒淡入至 0.22；点击开始旅程后随 800ms 黑场淡出并释放，再由地图音乐接管。切换性别和输入昵称不重启音乐。
- 开场影片期间不播放创建页 BGM。用户主动静音时创建页也保持静音；浏览器自动静音回退不视为用户静音，后续交互可重试播放。页面隐藏暂停、离开释放沿用已有音乐逻辑。
- 昨日女性 v2 替换后，装扮测试仍引用 v1，现已修正。手机实测发现装扮关闭按钮越界和服装格子被文字撑宽，已修复；390px 下按钮右边缘 374px，两侧库存容器均无横向溢出。
- 真实 `/piko-world` 路由在隔离测试浏览器检查：开场右上控件、男女创建页面、动态视频、创建后进入 Canvas 地图、设置菜单、专用三段装扮皮肤、确认关闭。桌面 1440px 和手机 390×844 均已截图检查。测试身份仅用于本机浏览器，不代表后端登录验收。
- 音频运行状态：开场无活动 BGM；创建页 BGM 播放到 0.22；离场音量下降、旧音轨释放；地图仅一条庭院 BGM 继续播放。地图交互后喷泉与鸟鸣正常启动，环境增益保持 0.7。此次检查覆盖播放状态和增益，不代表人工主观听感验收。
- 验证：66 文件 / 272 项测试通过；弹窗修复后定向 10 项复查通过；最终 TypeScript / Vite 构建通过，保留既有大分包警告；DESIGN lint 0 errors / 15 baseline warnings；git diff --check 通过。
- 截图位于 `/private/tmp/piko-*-0915.png`。开发重播仍按用户要求保留。本轮未提交、未部署。

## 2026-09-15 第二轮：邀请停帧与界面收紧

- 开场常规控件只保留静音；容器按视频真实宽高比 contain 居中，控件位于画面内右上角。自然 ended 后保留视频末帧并显示「你也一起来吧」，用户点击后才进入淡黑→创建页；错误状态保留重试和继续入口。中英越文案同步。
- 地图音乐基础音量0.5，环境声保持区域设定×0.7及距离衰减；创建页庭院音乐独立维持0.22，通知压低逻辑保留。
- 装扮最大宽540px，移除服装、配饰标题及两处空库存说明，保留可访问分区名称。格子目标44px。角色透明顶部留白由容器裁去，昵称与可见头顶间距6px；确认按钮与个人信息弹窗采用相同类名和下移页脚。
- 创建昵称无底色、无阴影，定位在角色可见头顶上方；输入聚焦无绿色外环，只将细边加深；表单背景为76%奶油色、16px背景模糊。
- 真实浏览器已检查自然播放30.048秒后停帧、点击邀请后进入创建、创建0.22→地图0.5的音乐切换、桌面与390px手机布局。此次 Chrome 使用 --mute-audio，系统不发声；检查结束关闭测试浏览器。

最终验证：66个文件、274项测试通过，TypeScript/Vite构建通过，DESIGN lint 0 errors / 15既有warnings，git diff --check通过。测试浏览器已关闭。本轮未提交、未部署。

## 2026-09-15 第三／四轮：信封邀请、统一音乐、刷新底色

- 邀请：末帧先停留1000ms，然后600ms淡入。按钮为信封上的暖棕色文字（画面39%/88%、6度旋转），静音按钮增加轻量hover。创建表单不透明度降为58%，昵称白字轻阴影。
- 装扮宽度540→594px（+10%），格子44→48.4px（+10%）；内容底部留白22%→14%，手机24%→16%。窄屏格子按可用宽度收缩。
- 入口字图原样复制用户3240×520透明PNG到 `/brand/piko-piko-wordmark.png`，显示宽度100→60px（-40%），保留可访问名称和原菜单。
- 刷新闪白：原HTML启动脚本默认system，而app-store默认dark；且主CSS加载前工作台无背景声明。现统一默认dark，内联提前设置深／浅首屏底色。浏览器阻止主入口脚本时，root为空而html已为dark、rgb(9,9,9)，证实无需等待React或主CSS。
- 音乐归属提升至账号级PikoWorldExperience，创建页首次展示后启动庭院曲目，加载页、地图名和庭院继续使用同一音轨；切换不同曲目仍沿用淡入淡出。同区域组不重播，创建页和地图均为0.5。环境声区域增益仍为0.7。
- 每张地图所属播放列表完整结束后停顿30000ms再从头播放。当前每个区域只有一首，等同每首播完停顿30秒。间隔中交互不提前播放，隐藏页面不发声，离场清理定时器。
- 浏览器实测：末帧结束半秒时无邀请按钮；淡入结束后文字贴合信封；同一BGM对象从创建页3.6秒连续播放到地图11.6秒，音量始终0.5；桌面装扮594×514px。所有验收Chrome使用--mute-audio并自动关闭。

第三／四轮最终检查：67个文件、280项测试通过；生产构建通过；DESIGN lint 0 errors / 15既有warnings；git diff --check通过。手机390px下库存两列容器宽与scrollWidth均76px，无横向溢出。系统静音的验收浏览器已自动关闭。未提交、未部署。
