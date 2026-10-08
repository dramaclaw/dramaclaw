# LibLib MiniMax H3 真实请求 / 返回合同

> 取证日期：2026-09-24。对象为 LibLib 画布中的 `Minimax H3`、`全能参考`。
> 本文只保留实现所需的字段、顺序、尺寸、时长、状态与积分；Cookie、签名媒体 URL、设备令牌、
> request/task/project/node 标识及提示词正文均已省略或脱敏。以下 JSON 是字段级脱敏摘录，
> 不是可重放请求，也不能用来访问原账户或素材。

## 结论先行

1. LibLib 的文本与媒体使用两套独立序列，所以“文本 1”和“图片 1”同时存在不是冲突：
   文本进入 `textList[0]`，图片进入媒体全局序列 `mixedList[0]`，后者才对应 `{{Mixed 1}}`。
2. 图片、视频、音频共用一个按节点面板从左到右排列的 `mixedList`；提示词里的
   `{{Mixed N}}` 直接指向这个数组的第 N 项，不能先按媒体类型分组后再编号。
3. 每项媒体还会重复进入自己的类型数组：图片为 `imageListV2`，视频为 `videoListV2`，音频为
   `audioListV2`。类型数组负责携带尺寸/时长等元数据，`mixedList` 负责保存全局混排顺序。
4. LibLib 客户端没有把 `{{Mixed N}}` 改写成图片/视频/音频标签；创建请求中的 `prompt` 保持
   UI 文本不变。类型解析发生在服务端或更下游。
5. 本次页面可选且真实提交的最短时长是 5 秒，没有 1 秒选项。实测参数为 16:9、768P、5 秒、1 条。
6. 视频与音频字段已分别由成功样本验证；两组更大的组合虽然创建请求被接受，但异步阶段返回
   `INVALID_PARAMS` 且最终 `power=0`。失败原因不能仅凭现有样本断言为数量上限或重复 URL。

## 创建请求字段合同

全能参考的创建请求具有下面的稳定形状：

```json
{
  "params": {
    "count": 1,
    "modeType": "mixed2video",
    "model": "MiniMax-Hailuo-H3",
    "prompt": "<redacted; keeps {{Mixed N}} tokens>",
    "ratio": "16:9",
    "resolution": "768P",
    "duration": 5,
    "textList": ["<redacted text node content>"],
    "imageList": [],
    "imageLabelList": [],
    "videoList": [],
    "audioList": [],
    "imageListV2": [
      {
        "url": "<redacted signed media URL>",
        "width": 2752,
        "height": 1536
      }
    ],
    "videoListV2": [
      {
        "url": "<redacted signed media URL>",
        "width": 1280,
        "height": 720,
        "duration": 10.05
      }
    ],
    "audioListV2": [
      {
        "url": "<redacted signed media URL>",
        "duration": 9.35
      }
    ],
    "mixedList": [
      { "url": "<redacted>", "type": "image" },
      { "url": "<redacted>", "type": "video" },
      { "url": "<redacted>", "type": "audio" }
    ],
    "infiniteSwitch": 0
  },
  "metadata": {
    "node_id": "<redacted>",
    "project_id": "<redacted>"
  },
  "provider": "MiniMax",
  "model": "MiniMax-Hailuo-H3",
  "taskType": "video",
  "requestId": "<redacted>",
  "riskControl": {
    "deviceToken": "<redacted>"
  }
}
```

需要区分的职责：

| 字段 | 已观察用途 | 对青蛙画布的意义 |
|---|---|---|
| `textList` | 每个上游文本节点占一项，序号独立于媒体 | 若追求 LibLib 完全同构，应在画布请求层保留文本节点边界；不能把它计入 Mixed |
| `imageListV2` | 图片 URL + 宽高，按图片出现次序排列 | 上传前/后必须保留可用于适配器校验的图片元数据 |
| `videoListV2` | 视频 URL + 宽高 + 秒数，按视频出现次序排列 | 视频不能只传 URL；应在提交前校验尺寸和时长 |
| `audioListV2` | 音频 URL + 秒数，按音频出现次序排列 | 音频不能只传 URL；应在提交前校验时长 |
| `mixedList` | 所有媒体的全局顺序，只含 URL 与类型 | 是 `{{Mixed N}}` 的唯一顺序依据 |
| 旧版四数组 | 本次四组 H3 请求中均为空 | 不应把媒体同时塞进旧数组；以 V2 数组为准 |
| `metadata` / `riskControl` | LibLib 自己的节点、项目与风控上下文 | 属于 LibLib 私有外壳，本地工作台不应照搬 |

### 两套编号如何同时成立

假设面板顺序是：文本 A、图片 B、图片 C、音频 D、视频 E。

```text
textList[0]  = 文本 A             → UI 可显示“文本 1”
mixedList[0] = 图片 B (image)     → {{Mixed 1}} / UI 可显示“图片 1”
mixedList[1] = 图片 C (image)     → {{Mixed 2}}
mixedList[2] = 音频 D (audio)     → {{Mixed 3}}
mixedList[3] = 视频 E (video)     → {{Mixed 4}}
```

类型数组则是：

```text
imageListV2 = [图片 B, 图片 C]
audioListV2 = [音频 D]
videoListV2 = [视频 E]
```

因此，同一个媒体有两个位置概念：`mixedList` 的全局位置决定提示词编号，类型数组的位置决定该媒体
在图片/视频/音频槽位中的编号。不能用 `imageListV2` 的下标代替 Mixed 下标。

## 四组真实样本

提示词内容、媒体 URL 与各类标识均未保留。`创建报价` 是创建返回中观察到的 power；`最终 power`
来自异步终态。成功样本的终态 power 与创建报价一致，失败样本终态为 0，实测未扣除积分。

| 样本 | 文本 / 图片 / 视频 / 音频 | `mixedList` 顺序 | 创建结果 | 异步终态 | 创建报价 | 最终 power |
|---|---:|---|---|---|---:|---:|
| A · 基线成功 | 1 / 3 / 0 / 1 | 图、图、图、音 | `code=0`，返回 task 标识 | `status=2`、`progress=100`，有视频结果 | 70 | 70 |
| B · 大组合失败 | 3 / 6 / 2 / 3 | 图、图、图、图、音、视、视、音、音、图、图 | `code=0`，返回 task 标识 | `status=3`、`failedCategory=INVALID_PARAMS` | 420 | 0 |
| C · 每类两项失败 | 2 / 2 / 2 / 2 | 图、图、音、视、音、视 | `code=0`，返回 task 标识 | `status=3`、`failedCategory=INVALID_PARAMS` | 350 | 0 |
| D · 含视频成功 | 2 / 2 / 1 / 1 | 图、图、音、视 | `code=0`，返回 task 标识 | `status=2`、`progress=100`，有视频结果 | 210 | 210 |

### 样本 A：图片 + 音频成功

- `textList`：1 项。
- `imageListV2`：3 项，每项均含 URL、宽、高。
- `audioListV2`：1 项，时长 9.35 秒。
- `videoListV2`：空。
- `mixedList`：3 张图片后接 1 条音频，与面板显示顺序一致。
- 成功终态返回视频结果，`status=2`、`progress=100`、`power=70`。

### 样本 B：三文本、十一项媒体，创建成功后参数失败

- `textList`：3 项；记录到的文本长度分别为 1755、2153、2081 字符。
- `imageListV2`：6 项；其中 1 项为 1280×720，其余 5 项为 2752×1536。
- `videoListV2`：2 项，均为 1280×720，时长分别为 15.09、10.05 秒。
- `audioListV2`：3 项，记录到的时长均为 9.35 秒。
- `mixedList`：`image ×4 → audio → video ×2 → audio ×2 → image ×2`。
- 提示词中的 Mixed 出现次序为 `2,1,4,5,3,6,7,8,9,10,11`；请求未重写这些 token。
- 创建返回 `code=0`、报价 420；异步很快以 `INVALID_PARAMS` 结束，最终 `power=0`。

### 样本 C：严格每种类型两项，重复媒体参数失败

- `textList`：2 项。
- `imageListV2`：2 项，均为 2752×1536。
- `videoListV2`：2 项，均为同一个 URL、1280×720、10.05 秒。
- `audioListV2`：2 项，均为同一个 URL、9.35 秒。
- `mixedList`：`image, image, audio, video, audio, video`。
- 提示词中的 Mixed 出现次序为 `2,1,3,4,5,6`，仍原样提交。
- 创建返回 `code=0`、报价 350；异步以 `INVALID_PARAMS` 结束，最终 `power=0`。

这组样本能证明“两视频/两音频会被怎样序列化”，但不能证明供应商支持重复使用同一个视频或音频。
失败可能来自重复 URL、某类引用数量、组合总量或模型内部约束，现阶段不得选择其中一个作为确定原因。

### 样本 D：图片 + 音频 + 视频成功

- `textList`：2 项。
- `imageListV2`：2 项，均为 2752×1536。
- `videoListV2`：1 项，1280×720、10.05 秒。
- `audioListV2`：1 项，9.35 秒。
- `mixedList`：`image, image, audio, video`。
- 创建返回 `code=0`、报价 210；任务经历供应商排队后成功，终态
  `status=2`、`progress=100`、`power=210`，并返回视频结果。

这组成功样本排除了“视频字段结构错误”和“音视频不能共存”两种解释。它直接证明视频必须出现在
`videoListV2`，同时以 `{type: "video"}` 出现在 `mixedList` 的全局槽位；音频同理。

## 返回与计费合同

为避免伪造完整私有响应，下面仅列出四组样本都能核对的观察字段，不保留原始标识和媒体结果 URL。

```json
{
  "create": {
    "code": 0,
    "taskId": "<redacted; actual nesting omitted>",
    "power": "<70 | 210 | 350 | 420>"
  },
  "terminalSuccess": {
    "status": 2,
    "progress": 100,
    "power": "<same as accepted create quote>",
    "videoResult": "<present; URL redacted>"
  },
  "terminalInvalidParams": {
    "status": 3,
    "progress": 100,
    "failedCategory": "INVALID_PARAMS",
    "failedReason": "<generic provider failure; omitted>",
    "power": 0
  }
}
```

实现和排错时要把“创建被接受”与“最终生成成功”分开：`code=0` 只说明任务已创建，不能据此认定
参数有效或已经扣费；必须等待异步终态。失败样本创建时都有报价，但终态 `power=0`。

观察到的积分只能作为本次配置的样本：A 为 70，D 增加一条约 10 秒视频后为 210；两视频样本的
创建报价为 350。不能据此写死通用计价公式，真实价格仍应使用供应商的预估/创建返回。

## 与青蛙画布当前实现的映射

### 已经对齐，必须保持

- `VideoOperationsPanel.tsx` 已让 H3 的图片/视频/音频共用一条从左到右的 Mixed 序列。
- `VideoNode.tsx` 已用同一 `referenceOrder` 构造 `references[]`，拖动或删除后顺序随之更新。
- `resolve_minimax_h3_mixed_references()` 在后端分组上传前，把全局 `{{Mixed N}}` 转为本地工作台需要的
  `<Picture N>` / `<Video N>` / `<Audio N>`；越界 token 会直接失败。
- 本地 QuickUI 按原始 `references[]` 顺序上传，再写入 `referenceImages`、`referenceVideos`、
  `referenceAudios`；这与 LibLib 的“全局顺序 + 类型数组”语义等价，尽管字段名不同。
- 比例、清晰度、时长、质量、步数、模型模式和种子已有严格校验，不能为兼容 LibLib 而恢复静默兜底。

### 有意不同，不应照抄

- LibLib 的 `MiniMax-Hailuo-H3` 是其供应商模型标识；青蛙画布的目录 ID 和本地工作台模型文件映射是
  另一层合同，不能直接替换成该字符串。
- `metadata.node_id`、`metadata.project_id`、`requestId` 与 `riskControl.deviceToken` 属于 LibLib
  平台外壳，不是 H3 生成质量参数，也不应进入本地工作台请求。
- LibLib 使用签名远程 URL；本地 H3 适配器把项目素材上传为工作台槽位 ID。只要顺序和类型不变，
  无需复制 `imageListV2/videoListV2/audioListV2` 的网络传输形式。
- LibLib 请求中的 `prompt` 保留 Mixed token，而本地 QuickUI 要求类型标签；当前在适配器边界转换是
  正确做法，不能提前在 UI 中按类型重写，否则拖动顺序后容易错绑。

### 尚未完全同构的文本节点边界

LibLib 将每个文本节点独立放入 `textList`；青蛙画布当前会把所有上游文本与用户输入合并为一个
`prompt`，媒体引用仍独立进入 `references[]`。这不影响 Mixed 媒体顺序，但会丢失“文本节点 1、2”
的原始边界。

如果后续确实需要完全复现 LibLib 的文本节点语义，应另开实现线，在画布请求层增加有序
`text_references[]`，在供应商适配器边界决定是发送独立文本数组还是合并进 prompt。不能把文本节点
插入 `references[]` 或 `mixedList`，否则全部媒体编号都会偏移。当前本地 QuickUI 没有 `textList`
合同，因此不应仅为字段外观改动已验收的本地传输。

## 下一次补测的唯一合理条件

现有证据已经足够实现正确的图片/视频/音频序列化，不应继续用重复素材盲测。只有产品明确要求支持
“至少 2 个互不相同的视频 + 2 个互不相同的音频同时生成”，并且已经准备好四个不同 URL 的素材时，
才值得做一次单变量补测：固定 2 文本、2 图片、2 视频、2 音频、16:9、768P、5 秒、1 条，只改变
重复 URL 为不同 URL。先保存脱敏请求，再提交一次；无论成功或失败都以异步终态为准，不重复重试。

在该实验完成前，产品侧应把“大组合供应商接受上限”标为未知；青蛙画布仍可按本地 H3 工作台已
声明并已测试的 9 图 / 3 视频 / 3 音频上限运行，因为那是另一套已验收网关合同，不能用 LibLib 的
一次 `INVALID_PARAMS` 反向覆盖。
