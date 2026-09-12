# Piko 世界 BGM 分组与生成提示词 v1

后续决定：用户先完成全部音乐生成，再统一接入。当前十五图已基础连通，但继续共用原有曲目；本方案保留用于素材制作，暂不推进 BGM 运行时改造。

2026-09-12：当前环境声已获用户听感确认，保持原配置。十五张地图规划为八组音乐：一组复用现有庭院 BGM，另外七组逐步制作。先制作 G02「临水灯火」，用于已经开放的灯河街和星灯码头。

本文件是音乐制作与后续接入规格；目前运行时五区仍播放同一首已有 BGM，尚未按组切换。

## 地图分组

| 组 | 主题 | 地图 ID | 状态与用途 |
| --- | --- | --- | --- |
| G01 | 小镇日常 | `welcome-courtyard`、`artisan-market`、`wind-garden-gate` | 复用已有音乐，无需重做 |
| G02 | 临水灯火 | `lantern-canal-street`、`starlight-dock` | 首批制作；安静、温暖、临水停留 |
| G03 | 风与草野 | `whispering-meadow`、`cloudtop-slope`、`amber-wilds` | 野外开放后接入；开阔与自由 |
| G04 | 潮汐远海 | `starfall-tidal-wetland`、`startrace-coast`、`boundless-sea` | 海岸线开放后接入；疏朗、漂浮 |
| G05 | 林间静处 | `whispering-forest` | 西线森林开放后接入；幽静但安全 |
| G06 | 霜月苔原 | `frostmoon-tundra` | 北线开放后接入；清冷、留白 |
| G07 | 赤霞峡谷 | `crimson-canyon` | 南线开放后接入；温暖、沉静 |
| G08 | 云上世界 | `whalesong-skyport` | 天港开放后接入；轻盈、遥远 |

苔原与峡谷分别制作，以保留冰原与暖色岩谷的音色差异。相邻地图不要求每图一首；同组音乐连续播放，避免频繁重启。

## 共用制作要求

- 原创纯器乐，约 3 分钟，可自然循环；旋律短而克制，避免持续抓耳的高频音型，保留交谈与环境声空间。
- 无人声、合唱、哼唱和口白；无鸟鸣、水声、风声、脚步、铃声提示等环境或通知音效，由运行时独立负责。
- 无强鼓点、低频冲击、史诗高潮、戏剧性转折；避免刺耳钟音、过亮高频、过度压缩和明显片头片尾。
- 生成器可能无法提供真正无缝循环。入库前单独检查尾首拼接、长时间重复和跨曲音量，不把提示词要求当作素材已达标。
- 保留原始导出文件，优先同时留 WAV 母版；浏览器版本后续派生为 MP3 / OGG。先完成 G02 的试听候选，不一次制作全部七首。

## 可直接复制的生成提示词

### G01 小镇日常（仅作未来补充参考，现有曲目继续使用）

温暖的木质音色与轻柔钢琴，适合庭院、市集和风庭门日常停留。

```text
Create an original instrumental ambient village theme for a peaceful pixel-art social world. Approximately three minutes, around 76–84 BPM, gentle felt piano, soft acoustic plucks and occasional warm woodwind phrases. Keep the melody modest, friendly and spacious, with quiet pauses and subtle harmonic variation. Support relaxed conversation and long unhurried stays. Maintain an even, restrained energy and a natural loop-compatible beginning and ending. No dramatic introduction, finale, heavy drums, epic build, sharp bells or aggressive bass. No vocals, choir, humming, spoken words, nature recordings, water sounds, birds, footsteps or notification effects. Avoid a repetitive bright ostinato and leave room for separately mixed environmental audio.
```

### G02 临水灯火（当前优先）

灯河街与星灯码头共用，能陪伴沿河散步，也适合在栈桥安静停留。先做两版候选：同一提示词，一版钢琴稍突出，一版木管稍突出。

```text
Create an original instrumental ambient theme for a quiet canal street and a small lantern-lit wooden dock in a gentle pixel-art world. Approximately three minutes, 68–76 BPM, sparse felt piano, soft harp plucks, warm low woodwinds and a very light sustained string bed. Suggest slow reflections and an evening breeze through musical phrasing only. Warm, intimate, unhurried, slightly wistful but reassuring. Use short understated melodic fragments, spacious rests and restrained dynamics, suitable for extended listening and conversation. Make the opening and ending compatible with a seamless loop, without a pronounced intro or finale. No vocals, choir, humming, drums, sharp chimes, epic swells, water recordings, wind, birds, boat noises or other environmental sound effects.
```

### G03 风与草野

低语草甸、云顶坡、琥珀原野共用；开阔但不产生赶路或冒险催促感。

```text
Create an original instrumental ambient landscape theme for open meadows, a grassy hilltop and amber fields in a peaceful pixel-art world. Approximately three minutes, 64–74 BPM, airy soft woodwinds, gentle acoustic plucks and thin warm strings. Express open space through breathing phrases and long rests. A small calm melody may drift in and out, with understated harmonic movement and no driving rhythm. Keep the mood free, grounded and quietly hopeful, suitable for wandering or sitting still. Use loop-compatible opening and ending textures without a dramatic intro or final cadence. No vocals, choir, humming, heavy percussion, epic adventure build, sharp bells, wind recordings, insects, birds or any environmental sound effects.
```

### G04 潮汐远海

湿地、海岸与海域共用；用宽阔和声表现水面，不把海浪烘焙进音乐。

```text
Create an original instrumental ambient theme for tidal pools, a quiet coastline and a wide open sea in a gentle pixel-art world. Approximately three minutes, 56–66 BPM with an almost weightless pulse. Use sparse soft piano with delicate delay, a restrained airy synth pad and occasional low sustained strings. Convey distance, floating light and calm curiosity through slow harmonies and generous empty space. Keep the texture transparent and the dynamics stable for extended listening. Begin and end on compatible sustained textures for looping, without a distinct introduction or finale. No vocals, choir, humming, strong beat, cinematic climax, piercing highs, ocean recordings, splashing, seabirds, boat sounds or other sound effects.
```

### G05 林间静处

低语森林独立使用；有深度和静谧感，避免悬疑、危险或迷失感。

```text
Create an original instrumental ambient theme for a peaceful forest clearing and ancient tree rings in a welcoming pixel-art world. Approximately three minutes, 50–60 BPM, mellow low woodwinds, muted wooden plucks and very soft sustained strings. Use widely spaced notes, gentle pauses and small harmonic changes. Convey shelter, dappled light and quiet companionship, never suspense or danger. Keep the melody understated and the mix soft enough for long stays and conversation. Shape a loop-compatible opening and ending without a prominent intro, climax or final cadence. No vocals, choir, humming, tribal drums, eerie drones, sharp bells, wind recordings, birds, insects, rustling leaves or other environmental sound effects.
```

### G06 霜月苔原

清冷钢琴与柔和玻璃音色，保留温度；不能尖亮或持续密集敲击。

```text
Create an original instrumental ambient theme for a silent snowy tundra and a moonlit frozen lake in a peaceful pixel-art world. Approximately three minutes, 44–54 BPM, restrained soft piano, a few rounded glass-like tones and a faint warm sustained pad underneath. Leave long rests and let individual notes decay naturally. The mood is clear, still and gently comforting, not bleak or ominous. Avoid busy arpeggios and bright repeated high notes. Keep dynamics quiet and consistent, with compatible opening and ending harmonies for looping. No vocals, choir, humming, percussion, epic swells, sharp bells, wind recordings, cracking ice, footsteps or environmental sound effects.
```

### G07 赤霞峡谷

以柔和木弦与低密度节奏表达夕光岩谷，避免西部片或战斗配乐。

```text
Create an original instrumental ambient theme for a broad terracotta canyon and sunlit stone formations in a peaceful pixel-art world. Approximately three minutes, 58–68 BPM, warm softly played nylon-string guitar, low mellow strings and extremely sparse muted wooden percussion. Suggest spacious rock layers and long afternoon shadows through slow phrasing and restrained warm harmonies. Calm, contemplative and grounded, without urgency or a heroic melody. Keep the arrangement light and stable for extended listening, with loop-compatible opening and ending textures. No vocals, choir, humming, western-film motifs, driving drums, epic crescendos, piercing high notes, wind recordings, wildlife or any environmental sound effects.
```

### G08 云上世界

鲸歌天港使用；表现悬浮与云海，鲸声另由环境系统承担。

```text
Create an original instrumental ambient theme for a hidden island skyport floating above a vast cloud sea in a gentle pixel-art world. Approximately three minutes, 54–64 BPM, soft harp, a few rounded celesta notes and delicate sustained strings. Use weightless spacing, slow harmonic changes and a tiny reassuring melodic motif. Convey quiet wonder and companionship rather than grandeur. Keep high frequencies gentle, avoid busy sparkling patterns, and leave ample space for conversation. Make the opening and ending naturally compatible for looping without a dramatic intro or finale. No vocals, choir, humming, epic orchestral swells, strong percussion, sharp bells, whale calls, wind recordings or other environmental sound effects.
```

## 素材验收与后续接入

1. G02 候选先检查人声／环境声污染、尖锐音色、明显高潮和尾首接缝，再在河街和码头实际试听。新曲目响度参考现有 BGM 的实际听感与测量值，不机械套用统一播放增益。
2. 通过后登记原始文件、来源、使用授权与浏览器派生文件。建议命名 `piko-bgm-g02-waterside-v1`，版本迭代保留原始母版。
3. 接入时增加地图到音乐组的映射：同组切图不重播；跨组准备目标曲，成功后约 1.5 秒交叉渐变；加载失败继续当前音乐。保留静音偏好、通知压低及后台暂停行为。
4. 回归覆盖庭院↔河街换组、河街↔码头不中断、连续快速切图不会叠加播放、加载失败、后台恢复和退出释放。上述是后续实现要求，目前尚未改动音乐运行时。
5. G02 完成后，随西线地图推进 G03 和 G05；其余主题随对应地图开放制作。
