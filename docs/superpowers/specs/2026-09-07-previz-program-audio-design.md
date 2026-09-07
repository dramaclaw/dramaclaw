# 预演台镜头轨与音频轨设计

## Context

预演台 P0–P2（`docs/superpowers/specs/2026-08-31-previz-canvas-node-design.md`）已在 `feat/previz-canvas-node` 上落地：四类对象、路径／动作／特写片段、播放预览、截图与录制回流画布。对照 Blender 做差距分析后，确定三个补强方向：① 机位切换 + 音频轨；② 场景搭建效率；③ 导出生成条件。本设计只覆盖 ①，②③ 各自另立 spec。

仓库现状（已核实）：

- `frontend/src/features/previz/domain/scene.ts`：`PrevizScene.timeline` 只有 `tracks: PrevizTrack[]`，每条轨道绑定一个对象；`PrevizClip = path | action | rig`。
- 监看画面只认 `store.activeCameraId`，由用户在机位轨道或视口里手动挑；播放期间不会自动切换。
- 全局录制（`PrevizRenderer.startRecording('global', null)`）整段用导演视角出片，机位视角只能靠「轨道录制」单独录一台。
- 上一版 spec「录制」一节写的「机位片段起点即切点、片段重叠视为镜头冲突并禁用全局录制」从未实现；本设计用独立镜头轨取代它，该规则作废。
- 时间轴没有任何音频概念。画布已有音频节点（`AudioNodeData.audioUrl / durationMs`）、波形工具（`features/canvas/compose/audioPeaks.ts` 的 `loadAudioPeaks`）、上游内容聚合（`useUpstreamContents` 返回带 `audioUrl` 的 `UpstreamContent`）、以及 mime 无关的上传入口 `uploadFreezoneImage(project, file, filename)`（`uploadFreezoneVideo` 只是它的重导出）。
- 录制走 `capture/recordTimeline.ts`：实时墙钟驱动 `drawFrame(frame)`，`createCanvasRecorder(canvas, {fps, mimeType})` 把 `canvas.captureStream` 接 `MediaRecorder`，`pickRecordMimeType` 按 `MIME_CANDIDATES`（mp4 avc1 优先，webm 兜底）挑容器。
- 画布节点白名单在 `features/canvas/domain/nodeRegistry.ts`：`DOWNSTREAM_TARGET_WHITELIST[audio] = [video, videoCompose]`，`UPSTREAM_SPAWN_WHITELIST[previz] = []`（预演台目前不读任何上游），有一条一致性测试约束四张表互相对得上。
- 预演台录制产物经 `addDerivedVideoNode(sourceNodeId, videoUrl, aspectRatio, displayName)` 生成视频节点，该节点没有 `durationMs`。

### 已确认的决策

| # | 决策 | 取值 |
|---|---|---|
| 1 | 音频来源 | 本地上传 + 画布上游音频节点 |
| 2 | 音频结构 | 一条音频轨、多段片段 |
| 3 | 录制混音 | 要，录制产物自带声音 |
| 4 | 切镜模型 | 独立镜头轨（program track），不复用机位片段的起止 |

决策 4 的依据：机位轨道上的路径片段描述的是「这台机位什么时候在动」，不是「什么时候上屏」。一台静止机位也要能上屏，一台运动机位也可以只上屏一半。把两件事绑在一起会逼用户为静止机位画假路径，也做不了「片段重叠」之外的任何表达。独立镜头轨是剪辑软件与 Blender 相机绑定（camera binding markers）共同的模型。

## Required behavior

- 时间轴标尺下方固定一行「镜头轨」，位于所有对象轨道之上，不可删除；空时显示提示文案。
- 用户可在播放头处切到任一机位：镜头轨行上的机位下拉、机位轨道表头的「切到此机位」、数字键 1–9 对应第 N 台机位。播放中按数字键即时切换（live cut）。
- 镜头切片支持既有的选中、拖动、拖边、剃刀、Delete；片段面板可改机位与起止帧。删除机位时其切片一并删除，且与删机位在同一个 undo 步。
- 右下角监看默认跟随镜头轨：播放头落在某段切片内就显示那台机位；没有切片覆盖时退回用户手动挑的机位。手动挑机位后停止跟随；监看框上的「跟随镜头轨」按钮恢复跟随。
- 当前上屏的机位在视口里有「直播」标识：机位轨道表头显示徽章，视锥高亮。
- 全局录制按镜头轨逐帧出片：有切片覆盖的帧用该机位视角，没有的帧用导演视角。轨道录制行为不变。
- 对象轨道下方固定一行「音频轨」，可放多段互不重叠的片段，片段上画波形与来源名。
- 「添加音频」支持本地文件（mp3 / wav / m4a / ogg，≤ 20 MB，上传到 freezone）和画布上游连入的音频节点。片段落在播放头，长度取「素材剩余时长」与「到下一段片段或时间轴末尾的空隙」中较小者。
- 音频片段拖左边裁掉的是素材开头（`offsetMs` 前进），拖右边只缩短；总长不能超过素材剩余时长。
- 播放、暂停、跳转、变速时音频同步跟随：播放头进入片段就从对应偏移处出声，离开即停。
- 录制产物自带音频，声音与画面在切点对齐；浏览器不支持带音轨的容器时退回纯视频并提示。
- 画布：音频节点可以连到预演台；预演台的连接菜单可以新建上游音频节点；预演台卡片显示「已接入音频 N 段」；录制生成的视频节点带 `durationMs`。

## Design

### 场景数据结构

`PrevizScene.timeline` 扩为三张表，`schemaVersion` 保持 1：

```ts
timeline: {
  tracks: PrevizTrack[];      // 对象轨道，不变
  program: PrevizCutClip[];   // 镜头轨：按 startFrame 升序、互不重叠
  audio: PrevizAudioClip[];   // 音频轨：按 startFrame 升序、互不重叠
}

interface PrevizCutClip {
  id: string;
  kind: 'cut';
  startFrame: number;   // 含
  endFrame: number;     // 不含，与既有片段一致
  cameraId: string;
}

interface PrevizAudioClip {
  id: string;
  kind: 'audio';
  startFrame: number;
  endFrame: number;
  audioUrl: string;
  sourceName: string;             // 文件名或上游节点显示名，用于轨道与面板展示
  durationMs: number;             // 素材总时长
  offsetMs: number;               // 片段起点对应素材内的偏移
  sourceNodeId: string | null;    // 来自上游节点时记录节点 id，本地上传为 null
}
```

- `PrevizClip` 联合类型扩为五种；`clipById(scene, id)` 覆盖三张表，返回值带 `table: 'tracks' | 'program' | 'audio'`（对象轨道片段仍带 `track`）。既有的 `moveClip / trimClip / splitClip / removeClip` 对三张表统一生效；`program` 与 `audio` 表内的移动、拖边额外受「不能与相邻片段重叠」约束（夹到邻居边界，不做推挤）。
- `parseScene` 对缺失的 `program` / `audio` 默认为 `[]`；`cameraId` 指向不存在或非机位对象的切片直接丢弃；`audioUrl` 为空、`durationMs` 非正数的音频片段丢弃；解析后按 `startFrame` 排序并丢弃与前一段重叠的片段。老场景不需要迁移。
- 上限：镜头切片 60 段，音频片段 20 段，音频文件 20 MB。达到上限时对应的添加入口禁用并提示。
- 新增纯函数 `liveCameraAt(scene, frame): string | null`（`domain/program.ts`），返回覆盖该帧的切片机位；`null` 表示导演视角。`evaluateSceneAt` 不变，机位切换不影响对象求值。
- `PrevizNodeSummary` 增加 `audioClipCount: number`（缺省视为 0），卡片据此显示「已接入音频 N 段」。

### 镜头轨

**位置与形态**：`PrevizTimeline` 在 `PrevizTimeRuler` 之下、对象轨道列表之上渲染 `PrevizProgramTrack`（testid `previz-program-track`），固定高度与对象轨道同行高，表头写「镜头轨」，不提供删除与置顶。空态在片段区显示「在播放头处切到一台机位」。

**切镜操作**统一走 store 动作 `cutToCamera(cameraId)`，在当前 `timelineFrame` 处执行 `domain/program.ts` 的 `insertCut(scene, frame, cameraId)`：

0. 播放头所在（或起点恰在播放头的）切片已经是这台机位：不改场景、不产生 undo 步。
1. 播放头恰好等于某段切片的 `startFrame`：只改该段的 `cameraId`，不新建。
2. 播放头落在某段切片内部：该段 `endFrame` 截到播放头；新段从播放头起，到下一段的 `startFrame`（原本这一段的 `endFrame`）。
3. 播放头在空隙里：新段从播放头起，到下一段 `startFrame` 或 `durationFrames`。
4. 播放头已在时间轴最后一帧且无空间（新段不足 `PREVIZ_MIN_CLIP_FRAMES`）：不改场景，提示「时间轴末尾没有空间」。
5. 切片数已达 60：不改场景，提示上限。

三个入口都调用它：镜头轨行表头的机位下拉（列出全部机位，文案「切到 …」）、每条机位轨道表头的「切到此机位」按钮、以及数字键 1–9。数字键在编辑器根元素上监听，焦点在输入框、下拉或对话框内时不响应；第 N 台按 `scene.objects` 中机位的出现顺序（与 `resolveRecordTarget` 给节点起名的序号一致）。播放中按键效果相同：切片在当前帧建立，监看立即切过去。

**编辑**：切片复用 `PrevizTimelineTrack` 的选中／拖动／拖边／剃刀／Delete 交互，只是不展开关键帧、没有路径操作。选中切片时 `PrevizClipInspector` 显示机位下拉、起止帧；改机位只换 `cameraId`。`removeObject(cameraId)` 在同一次 `applyScene` 里删掉对应切片。

**监看跟随**：store 增加会话状态 `monitorFollowsProgram: boolean`（默认 `true`，随 `loadScene` 重置，不进 undo）。监看用的机位由选择器 `monitorCameraId(state)` 给出：

```
monitorFollowsProgram ? (liveCameraAt(scene, timelineFrame) ?? activeCameraId) : activeCameraId
```

`setActiveCamera(id)` 由用户手动挑机位时调用，同时把 `monitorFollowsProgram` 置 `false`；新增 `followProgram()` 把它置回 `true`。`PrevizEditor` 用一个 effect 把 `monitorCameraId` 灌给 `renderer.setActiveCamera`，渲染层不感知镜头轨；编辑器里既有的「退回上一次监看过的机位」兜底逻辑排在选择器之后，只在两者都为空时生效。`PrevizMonitorFrame` 在未跟随时显示「跟随镜头轨」按钮，跟随中显示「跟随中」灰字。

**直播标识**：`liveCameraAt(scene, timelineFrame)` 非空时，该机位的轨道表头显示「直播」徽章，`PrevizRenderer.setLiveCamera(id | null)` 把它的视锥线换成高亮色。

**录制**：`PrevizRecordingPass.drawFrame(frame, cameraId: string | null)` 增加第二个参数。全局录制每帧传 `liveCameraAt(scene, frame)`：非空时按出片画幅渲染该机位视角，空则渲染导演视角；轨道录制忽略第二个参数，仍录 `startRecording` 时指定的那台。`resolveRecordTarget` 不变。上一版 spec 的「片段重叠禁用全局录制」规则删除。

### 音频轨

**位置与形态**：`PrevizAudioTrack`（testid `previz-audio-track`）固定在对象轨道列表之下，不可删除。没有对象轨道时，既有的时间轴空态提示仍渲染在镜头轨与音频轨之间，两条固定行不受影响。片段上画波形（`loadAudioPeaks(audioUrl)`，加载前显示灰底，失败显示红底）与 `sourceName`。表头有「添加音频」按钮，展开菜单：

- **本地文件**：`<input type="file" accept="audio/*">`。前端校验扩展名（mp3 / wav / m4a / ogg）与大小（≤ 20 MB），不通过直接 toast。通过后先在播放头处放一段「上传中」占位片段（会话状态，不进场景），用 `<audio>` 元素探测时长；`uploadFreezoneAudio(project, file, 'previz-audio-<nodeId>-<seq>.<ext>')`（`api/ops.ts` 新增，与 `uploadFreezoneVideo` 一样是 `uploadFreezoneImage` 的重导出）成功后替换成真片段并进 undo；失败则移除占位并 toast。
- **上游音频节点**：列出 `PrevizEditor` 收到的 `upstreamAudio: PrevizUpstreamAudio[]`（`{nodeId, displayName, audioUrl, durationMs: number | null}`），由 `PrevizNode` 用 `useUpstreamNodes(id)` 过滤 `audio` 类型且 `audioUrl` 非空的节点算出。列表为空时显示「把音频节点连到预演台即可在此选择」。`durationMs` 为空时用 `<audio>` 探测。

**建片段**：`domain/audioTrack.ts` 的 `insertAudioClip(scene, frame, source)`：起点为播放头；长度 = min(素材剩余帧数, 到下一段音频片段或 `durationFrames` 的空隙)，素材剩余帧数 = floor((durationMs − offsetMs) × fps / 1000)。播放头落在既有片段内或空隙不足 1 帧时不建，提示「此处没有空位」。片段数已达 20 时入口禁用。

**裁剪语义**：`trimClip(edge:'start')` 对音频片段同时把 `offsetMs` 按帧差换算推进（向左拉回时倒退，最小 0）；`trimClip(edge:'end')` 只改 `endFrame`，上限为 `startFrame + (durationMs - offsetMs) × fps / 1000` 向下取整。`moveClip` 保持 `offsetMs`。剃刀切分后右半段的 `offsetMs` 加上切点相对左端的时长。

**片段面板**：来源名、起止帧、素材偏移（毫秒，只读）、「重新定位到播放头」按钮（把 `startFrame` 移到播放头，长度不变，越界时按 `moveClip` 规则夹住）。

### 音频播放引擎

新文件 `engine/audioPlayback.ts`，导出 `createAudioPlayback(deps)`，与渲染器一样只由 `PrevizEditor` 持有：

- `deps`：`{ context: AudioContextLike, fetchBuffer(url): Promise<AudioBuffer> }`，测试注入假 `AudioContext`。
- `load(clips)`：按 `audioUrl` 去重解码并缓存（`Map<url, Promise<AudioBuffer>>`），解码失败记入 `failedUrls`，UI 据此把片段涂红。
- `play(clips, fromFrame, rate, destination = context.destination)`：对每个 `endFrame > fromFrame` 且未失败的片段建一个 `AudioBufferSourceNode`：`playbackRate = rate`；起点在片段内则立即起播、`offset = offsetMs/1000 + (fromFrame - startFrame)/fps`，否则 `when = now + (startFrame - fromFrame)/fps/rate`；`duration` 截到 `endFrame`。
- `stop()`：停掉并释放全部 source。
- `dispose()`：`stop()` 后关闭 context、清缓存。

`PrevizEditor` 在 `timelinePlaying` 变 true 时 `play`，变 false 时 `stop`；`setTimelineFrame`（跳转）与 `setTimelineRate` 在播放中触发 `stop` + `play`。变速直接改 `playbackRate`，音高随之改变，属可接受行为。编辑器关闭时 `dispose`。`AudioContext` 在用户第一次点播放或录制时惰性创建，绕开自动播放策略。

### 录制混音

- `createCanvasRecorder(canvas, options)` 的 `options` 增加可选 `audioStream?: MediaStream`；存在时把它的音轨合并进画布流再交给 `MediaRecorder`。
- 录制时 `audioPlayback.play(clips, 0, 1, destinationNode)` 把输出接到一个 `MediaStreamAudioDestinationNode` 而不是扬声器，其 `stream` 作为 `audioStream`。录制期间扬声器静音，避免和录制流双份出声。
- 时钟：`recordTimeline` 的 `now()` 与音频调度以同一时刻为零点——先 `recorder.start()`，再同时记录 `performance.now()` 与 `context.currentTime`，之后视频按墙钟推帧、音频按 AudioContext 时钟播放，两者都是实时秒，误差以一次 rAF 为界。
- `shouldStop` 触发或录制结束时先 `audioPlayback.stop()` 再 `recorder.stop()`。
- `pickRecordMimeType(isSupported, withAudio)`：`withAudio` 为 true 时候选列表换为 `video/mp4;codecs=avc1.42E01E,mp4a.40.2`、`video/mp4`、`video/webm;codecs=vp9,opus`、`video/webm;codecs=vp8,opus`、`video/webm`。场景没有音频片段时行为与现在完全一致。若带音频的候选一个都不支持但纯视频候选可用，退回纯视频录制并 toast「本浏览器无法混音，已录制无声视频」。

### 画布集成

- `DOWNSTREAM_TARGET_WHITELIST[audio]` 加 `previz`；`UPSTREAM_SPAWN_WHITELIST[previz] = [audio]`，删掉「空数组抑制连接菜单」的注释；更新一致性测试的预期。
- `PrevizNode` 把上游音频节点列表作为 `upstreamAudio` 传给 `PrevizEditor`；卡片在摘要行显示「已接入音频 N 段」（`summary.audioClipCount > 0` 时）。
- `addDerivedVideoNode` 增加可选第五参 `durationMs`；预演台录制完成后传 `durationFrames / fps × 1000`。

### 模块清单

| 文件 | 变化 |
|---|---|
| `domain/scene.ts` | `PrevizCutClip`、`PrevizAudioClip`、`timeline.program/audio`、`parseScene` 容错、`audioClipCount` |
| `domain/program.ts`（新） | `liveCameraAt`、`insertCut`、`PREVIZ_MAX_CUTS` |
| `domain/audioTrack.ts`（新） | `insertAudioClip`、音频片段裁剪换算、`PREVIZ_MAX_AUDIO_CLIPS`、`PREVIZ_MAX_AUDIO_BYTES`、`PREVIZ_AUDIO_EXTENSIONS` |
| `domain/timeline.ts` | `clipById` 覆盖三张表；`move/trim/split/remove` 支持 `program` 与 `audio` |
| `store.ts` | `cutToCamera`、`addAudioClip`、`relocateAudioClipToPlayhead`、`monitorFollowsProgram`、`followProgram`、`setActiveCamera` 关跟随、`removeObject` 连删切片、`monitorCameraId` 选择器 |
| `engine/audioPlayback.ts`（新） | `createAudioPlayback` |
| `engine/PrevizRenderer.ts` | `setLiveCamera`、`drawFrame(frame, cameraId)` |
| `capture/recordTimeline.ts` | `audioStream`、`pickRecordMimeType(isSupported, withAudio)` |
| `ui/PrevizProgramTrack.tsx`（新） | 镜头轨行 |
| `ui/PrevizAudioTrack.tsx`（新） | 音频轨行、添加音频菜单、上传中占位 |
| `ui/PrevizTimeline.tsx` | 挂两条固定行 |
| `ui/PrevizTimelineTrack.tsx` | 表头「切到此机位」与「直播」徽章 |
| `ui/PrevizClipInspector.tsx` | 切片与音频片段两种面板 |
| `PrevizEditor.tsx` | 数字键、监看跟随 effect、音频引擎生命周期、录制混音、`upstreamAudio` prop |
| `api/ops.ts` | `uploadFreezoneAudio` |
| `features/canvas/domain/nodeRegistry.ts`、`nodes/PrevizNode.tsx`、`stores/canvasStore.ts` | 白名单、上游音频、`durationMs` |
| `public/locales/{zh,en}/translation.json` | `previz.program.*`、`previz.audio.*`、`previz.monitor.follow*`、`previz.editor.record.noAudioMix` |

## Data flow

**切镜**：用户按数字键 3 → `PrevizEditor` 查第 3 台机位 → `store.cutToCamera(id)` → `insertCut(scene, timelineFrame, id)` → `applyScene`（一个 undo 步）→ `monitorCameraId` 选择器变化 → effect 调 `renderer.setActiveCamera` 与 `setLiveCamera` → 监看与视锥更新。

**播放**：`setTimelinePlaying(true)` → 编辑器 effect 调 `audioPlayback.play(scene.timeline.audio, timelineFrame, timelineRate)`；rAF 循环照旧推 `tickPlayback`；每帧 `monitorCameraId` 变化时切监看。播放到末尾 `tickPlayback` 置 `timelinePlaying=false` → effect 调 `stop()`。

**添加本地音频**：选文件 → 校验 → 占位片段（会话态）→ `<audio>` 探测 `durationMs` 与 `uploadFreezoneAudio` 并行 → 两者完成后 `store.addAudioClip({audioUrl, sourceName, durationMs, sourceNodeId: null})` → `insertAudioClip` → `applyScene` → 波形按 `audioUrl` 懒加载。

**添加上游音频**：`PrevizNode` 的 `useUpstreamNodes` → `upstreamAudio` prop → 菜单项 → `addAudioClip({…, sourceNodeId})`。上游节点后来被删或断开不影响已建片段（`audioUrl` 已固化在场景里）。

**全局录制**：`handleRecord('global')` → `pickRecordMimeType(undefined, audioClips.length > 0)` → `startRecording('global', null)` → 若有音频且容器支持，创建 `MediaStreamAudioDestinationNode` 并 `audioPlayback.play(clips, 0, 1)` 接到它 → `createCanvasRecorder(pass.canvas, {fps, mimeType, audioStream})` → `recordTimeline` 每帧 `pass.drawFrame(frame, liveCameraAt(scene, frame))` → 结束后 `audioPlayback.stop()` → `uploadFreezoneVideo` → `addDerivedVideoNode(nodeId, url, aspect, name, durationMs)`。

**落盘**：关闭编辑器 `onFlush(scene)` → `nodeScene.ts` 写 `scene` 与 `summary{objectCount, durationFrames, audioClipCount}`。

## Error handling

- 切片 `cameraId` 悬空：`parseScene` 丢弃；运行时 `removeObject` 保证不会产生。
- 时间轴末尾无空间、切片达 60、音频片段达 20、播放头处无空位：不改场景，toast 说明。
- 本地文件格式或大小不合规：toast，不上传。上传失败：移除占位片段，toast 后端错误信息。时长探测失败（`<audio>` 触发 `error`）：视为不可用文件，处理同上传失败。
- 音频解码失败：片段涂红，播放跳过，录制静音，其余片段照常。
- `AudioContext` 创建失败或被浏览器拒绝：播放与录制均静音，console.warn 一次，不阻塞画面。
- 没有带音轨的容器：退回纯视频录制并 toast。
- 上游音频节点还在上传（`isUploading`）或 `audioUrl` 为空：不出现在菜单里。
- 缩短 `durationFrames` 不裁切片，与对象片段的既有行为一致（`setDurationFrames` 只改时长不动片段）：超出部分不上屏、不录制、不出声，再次加长即恢复。`insertCut` / `insertAudioClip` 以当前 `durationFrames` 为右边界。

## Verification

自动化（vitest，按层）：

- `domain`：`parseScene` 对缺失／悬空／重叠／非法时长的容错；`liveCameraAt` 边界（起点含、终点不含、空隙返回 null）；`insertCut` 五种情形；`insertAudioClip` 长度取小与无空位；音频片段 `trimClip` 的 `offsetMs` 换算与上限；`splitClip` 对音频的 `offsetMs` 分配；`removeObject` 连删切片；`clipById` 三张表。
- `store`：`cutToCamera` 一个 undo 步；`setActiveCamera` 关跟随、`followProgram` 开跟随；`monitorCameraId` 选择器三种取值；`loadScene` 重置跟随。
- `engine`：用假 `AudioContext` 验证 `play` 对片段内起播的 `offset`、片段外的 `when`、`playbackRate`；`stop` 释放全部 source；解码失败进 `failedUrls` 且不建 source。
- `capture`：`pickRecordMimeType(withAudio=true)` 候选顺序与退回；`createCanvasRecorder` 传 `audioStream` 时把音轨加进流（mock `MediaStream` / `MediaRecorder`）。
- `ui`：镜头轨行渲染与空态；数字键触发 `cutToCamera`、焦点在输入框时不触发；「直播」徽章与「跟随镜头轨」按钮状态；音频轨添加菜单在无上游时的提示、文件校验 toast；片段面板两种形态。
- `canvas`：白名单一致性测试更新；`PrevizNode` 传 `upstreamAudio`；卡片「已接入音频 N 段」；`addDerivedVideoNode` 写入 `durationMs`。
- i18n：`previz-locale.test.ts` 覆盖新 key 中英齐全。

手工验收（浏览器）：

1. 建两台机位，播放中按 1、2 切换，监看随之切换，镜头轨出现两段切片。
2. 手动点另一台机位，监看停止跟随；点「跟随镜头轨」恢复。
3. 拖入一段本地 mp3 与一个上游音频节点，播放时从播放头位置正确出声，跳转与变速同步。
4. 全局录制：产物视频在切点处画面切换、声音连续；无音频场景产物与现在一致。
5. 关闭再打开编辑器，切片与音频片段完整保留。

## Scope

包含：上述镜头轨、监看跟随、直播标识、按镜头轨的全局录制、音频轨（本地上传 + 上游节点）、音频播放与录制混音、画布白名单与卡片摘要、视频节点 `durationMs`。

不包含：音频音量／淡入淡出、多条音频轨、镜头轨转场（叠化等）、机位切换时的画面过渡、音频波形缩放优化、把镜头轨切点导出为分镜元数据（归 ③）、录制期间的音频电平表。
