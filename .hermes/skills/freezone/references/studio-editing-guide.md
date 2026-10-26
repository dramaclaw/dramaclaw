# 视频合成与剪辑工作区：用 film 剪，不动画布时间线

用户打开某个 `videoComposeNode` 的「视频合成与剪辑」工作区时，系统提示里会出现
`[FREEZONE_COMPOSE_WORKSPACE]`，其中 `compose_node_id` 就是正在剪的节点。此时这条时间线的
真相是节点的 OpenFilm film（`film.html`），用户在左侧编辑器里看到并随时能撤销的就是它。

## 工具与顺序

| 用户意图 | 调用 |
| --- | --- |
| 看一眼现在剪成什么样 / 任何剪辑前 | `freezone_studio_get_film(node_id)` |
| 剪、挪、调序、分割、删、淡入淡出、音量、变速、静音轨道 | `freezone_studio_edit_film(node_id, base_rev, ops)` |
| 把画布上某个视频 / 音频 / 图片节点的成品加进来 | `freezone_studio_import_media(node_id, source_node_id)` → 再用 `insert` op |
| 导出 / 渲染 / 出成片 | `freezone_studio_export_film(node_id)`，一次请求只调一次，不轮询 |

硬规则：

- 工作区打开期间，**不要**用 `freezone_update_node_data` 改 `draftTimeline`，不要用画布命令重建时间线，
  不要再 `prepare_workflow` 一套新的合成。那样会覆盖用户手剪的内容，或被后端以 409 拦下。
- `base_rev` 必须来自最近一次 `freezone_studio_get_film`（或上一次成功 edit 返回的 `rev`）。
  收到 `studio_edit_conflict` 就重新读 film，用新的 clip id 和 rev 重做；收到 `studio_edit_invalid`
  按 `error` 修 ops，不要原样重试。
- 工具返回 404 / `studio_film_missing` 语义（节点还没有 film）时，告诉用户先打开这个节点的剪辑工作区，
  不要自行回退到画布命令。
- 节点、片段都用返回里的 id；用户说「第二段」「那段配音」时，按 `film.tracks[].clips[]` 的顺序、
  `kind` 和 `source.label` 对应，拿不准就用 `freezone_request_user_clarification` 让用户选。

## 读 film 的结果怎么看

- `film.stage`：画幅像素。`film.duration`：整片长度（秒）。
- `film.tracks[i]`：轨道，顺序即编辑器里从上到下的叠放顺序（上面的轨道盖住下面的）。`locked` 轨道
  是用户锁住的，不要改。
- 每个 clip：`id`（编辑用）、`kind`（video / sound / still / page）、`at`（在成片上的起点秒）、
  `time=[in,out]`（取素材的哪一段，素材自身秒）、`duration` / `end`（在成片上占多长、到哪里）、
  `speed`、`volume`、`fade=[in,out]`、`source.label` / `source.node_id`（来自画布哪个节点）。
- `media[]`：各素材文件探测到的 `duration` / `width` / `height` / `audio`，算裁剪范围时用。

## 常用指令到 ops 的映射

所有时间都是秒，保留到毫秒即可；同一轨道上的片段不能重叠。

| 用户说 | ops |
| --- | --- |
| 把第二段提前 1 秒 | `{op:"move", clip:"<id>", at: <原 at - 1>}` |
| 第一段只要前 3 秒 | `{op:"set", clip:"<id>", field:"time", value:[<in>, <in>+3]}` |
| 开头淡入 0.5 秒、结尾淡出 1 秒 | `{op:"props", edits:[{clip:"<id>", prop:"fade", value:[0.5, 1]}]}` |
| 配音小一点 | `{op:"set", clip:"<id>", field:"volume", value:0.6}` |
| 这段慢放一半 | `{op:"set", clip:"<id>", field:"speed", value:0.5}`（成片上的时长随之变长，后面的片段要跟着 move） |
| 在第 4 秒切开 | `{op:"split", clip:"<id>", at:4, time:[<in>, <in>+(4-at)], restTime:[<in>+(4-at), <out>]}` |
| 删掉那段 | `{op:"remove", clip:"<id>"}` |
| 把 X 节点的视频接在最后 | 先 `import_media(source_node_id)` 拿 `asset_path`，再 `{op:"insert", clip:{src:"<asset_path>", at:<film.duration>, time:[0, <media.duration>]}, track:<视频轨 index>}` |
| 背景音乐轨先静音 | `{op:"track", track:<index>, field:"muted", value:true}` |
| 两段换个顺序 | 两个 `move`，先把后一段挪到前一段的 `at`，再把前一段挪到后一段原来的 `end` |

一次 `edit` 里可以放多个 op，按顺序执行；相互依赖的改动（比如变速后挪后面的片段）放在同一次里。

## 回复用户

- 改完用一两句话说清改了什么（哪一段、从几秒到几秒），不要贴 ops 和 id。
- 不要声称已经导出成片；只有调用了 `freezone_studio_export_film` 并拿到任务回执，才说「已开始导出，完成后会出现在这个合成节点上」。
