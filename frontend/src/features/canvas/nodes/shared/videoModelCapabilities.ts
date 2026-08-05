// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { VideoGenMode } from "@/features/canvas/domain/canvasNodes";

/**
 * Freezone 画布视频模型的**能力口径**——与后端 `freezone.py` 各视频端点的模型门禁
 * 一一对齐，作为 CTA / 模式可见性 / 自动推导默认 / 提交校验的**单一事实来源**，
 * 避免「把所有非 HappyHorse 模型都当作 Seedance 2.0」的假设散落在组件各处。
 *
 * 后端事实（src/novelvideo/api/routes/freezone.py）：
 * - 全能参考 omni-gen：`is_freezone_seedance2_backend` 为假直接 400；
 * - 首尾帧 keyframes：仅 Seedance 2.0 才 append 尾帧，其余后端**静默丢弃尾帧**；
 * - 图生视频 i2v / 首尾帧 keyframes / 视频编辑 edit：均**不校验 prompt**（允许空提示词）；
 * - 视频编辑 edit：仅 HappyHorse。
 *
 * 模型 id / apiModel 形如 `newapi_seedance-2.0-fast` / `newapi_seedance-1.0-pro-fast`
 * / `newapi_happyhorse-1.0`（见 freezone/video_node.py）。这里统一去掉分隔符后按版本号
 * 前缀匹配，避免把 `2.0` 误命中成 `1.x`（`seedance1\d` 只吃 `seedance1` 后跟数字）。
 */

function normalizeVideoModelId(modelId: string | null | undefined): string {
  return String(modelId ?? "")
    .replace(/[\s._-]/g, "")
    .toLowerCase();
}

export function isHappyHorseVideoModel(modelId: string | null | undefined): boolean {
  return normalizeVideoModelId(modelId).includes("happyhorse10");
}

export function isGrokVideoChannelModel(modelId: string | null | undefined): boolean {
  return normalizeVideoModelId(modelId).includes("grokvideochannel");
}

// Seedance 1 全系列（1.0 Pro Fast / 1.5 Pro / …）：版本号 `1.x` → `1x`，匹配
// `seedance1` 后跟任意数字，避免误命中 2.0（`seedance20`）。引用素材时这些模型受限。
export function isSeedance1xVideoModel(modelId: string | null | undefined): boolean {
  return /seedance1\d/.test(normalizeVideoModelId(modelId));
}

// Seedance 2.0 全系列（2.0 / fast / value / fast-value）：与后端
// `is_freezone_seedance2_backend`（model.startswith("seedance-2.0")）等价。
export function isSeedance2VideoModel(modelId: string | null | undefined): boolean {
  return /seedance2/.test(normalizeVideoModelId(modelId));
}

// 基础款 Seedance 2.0（`…seedance-2.0` 本体，不含 fast / value / fast-value 变体）。
// 归一化后以 `seedance20` 结尾即为基础款——变体都会在后面多出 `fast` / `value` 后缀。
function isBaseSeedance2VideoModel(modelId: string | null | undefined): boolean {
  return /seedance20$/.test(normalizeVideoModelId(modelId));
}

/**
 * 模型入参的统一形态：既可以只给一个 id 字符串，也可以给媒体目录下发的模型对象
 * （`supportedModes` 存在时以它为准，那是 Admin 显式配置的能力声明）。
 */
export type VideoModelRef =
  | string
  | {
      id?: string;
      apiModel?: string;
      supportedModes?: string[];
    }
  | null
  | undefined;

/** 从模型入参里取出用于能力启发式判定的 id（优先 apiModel，它才是打给上游的名字）。 */
function videoModelIdOf(model: VideoModelRef): string | null | undefined {
  return typeof model === "string" ? model : (model?.apiModel ?? model?.id);
}

/**
 * 指定模型是否支持某 genMode（与可见 tab / 切模型时是否重置残留模式口径一致）。
 * - HappyHorse：文生 / 首帧(i2v) / 图片参考(r2v) / 视频编辑。
 * - 非 HappyHorse：视频编辑是 HappyHorse 专属；全能参考与「真尾帧」首尾帧只有
 *   Seedance 2.0 后端支持（非 2.0 打 omni→400、首尾帧静默丢尾帧）；文生 / 首帧 /
 *   图片参考其余视频模型均支持。
 */
export function isVideoModeSupportedByModel(
  mode: VideoGenMode,
  model: VideoModelRef,
): boolean {
  if (typeof model === "object" && model !== null && (model.supportedModes?.length ?? 0) > 0) {
    const modeKey: Record<VideoGenMode, string> = {
      textToVideo: "text_to_video",
      imageToVideo: "first_frame",
      firstLastFrame: "first_last_frame",
      imageReference: "image_reference",
      allReference: "all_reference",
      videoEdit: "video_edit",
    };
    return model.supportedModes?.includes(modeKey[mode]) ?? false;
  }
  const modelId = videoModelIdOf(model);
  if (isHappyHorseVideoModel(modelId)) {
    return (
      mode === "textToVideo" ||
      mode === "imageToVideo" ||
      mode === "imageReference" ||
      mode === "videoEdit"
    );
  }
  if (mode === "videoEdit") return false;
  if (mode === "allReference" || mode === "firstLastFrame") {
    return isSeedance2VideoModel(modelId);
  }
  return true;
}

/**
 * 空态 CTA 只覆盖「铺素材起步」的图片 / 首尾帧模式——文生视频无需素材、视频编辑走
 * 独立入口，都不在空态 CTA 里。与 `spawnFrameUploads` 接受的模式一一对应。
 */
export type VideoEmptyStateCtaMode =
  | "allReference"
  | "imageReference"
  | "imageToVideo"
  | "firstLastFrame";

/**
 * 视频节点「空态」CTA 的模式顺序——只列该模型**真正能起步**的图片 / 首尾帧模式：
 * - HappyHorse：首帧 → 图片参考；
 * - Seedance 2.0：全能参考 → 图片参考 → 首尾帧；
 * - Seedance 1.x 及其它非 2.0 非 HappyHorse：全能参考会 400、首尾帧尾帧被静默丢弃、
 *   多图参考也不支持，只给确实可用的「首帧」。
 */
export function videoEmptyStateCtaModes(
  modelId: string | null | undefined,
): VideoEmptyStateCtaMode[] {
  if (isHappyHorseVideoModel(modelId)) {
    return ["imageToVideo", "imageReference"];
  }
  if (isSeedance2VideoModel(modelId)) {
    return ["allReference", "imageReference", "firstLastFrame"];
  }
  return ["imageToVideo"];
}

/**
 * 非 HappyHorse 模型「首次接入图片素材」后的默认模式：Seedance 2.0 用全能参考
 * （omni，1-9 图 + 视频 + 音频的通用入口），其余（Seedance 1.x）不支持全能参考，
 * 退到确实可用的「首帧」，避免默认推导把 1.x 顶进一个提交必 400 的模式。
 */
export function videoUpstreamImageDefaultMode(
  modelId: string | null | undefined,
): VideoGenMode {
  return isSeedance2VideoModel(modelId) ? "allReference" : "imageToVideo";
}

/**
 * 该 genMode 是否**必须带提示词**才能提交：文生 / 全能参考 后端强校验 prompt；
 * 首帧(i2v) / 图片参考 / 首尾帧 / 视频编辑 允许空提示词（只要素材齐备即可提交）。
 */
export function videoModeRequiresPrompt(mode: VideoGenMode): boolean {
  return mode === "textToVideo" || mode === "allReference";
}

/**
 * 该模型的 i2v 端点是否放行多图（>1）。后端只在「非 2.0 且非 HappyHorse」时对
 * `len(source_paths) > 1` 直接 400（freezone.py），所以这两族之外的模型（Seedance
 * 1.x 等）一次只能吃一张图 —— 对它们来说换模式救不了，得换模型。
 */
export function videoModelAcceptsMultipleImages(
  modelId: string | null | undefined,
): boolean {
  return isSeedance2VideoModel(modelId) || isHappyHorseVideoModel(modelId);
}

/**
 * 「首帧生成视频」(imageToVideo / i2v) 接了多图时该切到哪个模式，null = 不动。
 *
 * 为什么必须切：后端 i2v 端点按**图片张数**分流（1 张 = 图生视频，2-9 张 = 图片
 * 参考视频），多连一张不会报错，而是悄悄变成另一种生成方式 —— 界面上模式却还写着
 * 「首帧生成视频」。用户把第二张图连上来这个动作本身就是明确意图，直接把模式导到
 * 真正在做的事情上：优先「全能参考」(omni，还能继续接视频 / 音频)，模型不支持
 * omni 时退「图片参考」。
 *
 * 三种情况**不动**：
 * - HappyHorse 有自己那套完整状态机（videos>0→视频编辑 / images>1→图片参考 /
 *   images===1→首帧），在那儿统一收口，这里再插一脚只会两处来回打架；
 * - 模型压根消费不了多图（Seedance 1.x：i2v 端点 >1 图直接 400），换到哪个模式都是
 *   400。留在首帧上，让提交守卫那句「该模型单次仅支持 1 张图片」把话说清楚，别用
 *   一次模式跳变把真正的问题（该换模型）盖掉；
 * - 两个候选模式该模型都不支持 —— 宁可不动，也不要顶进一个提交必 400 的模式。
 */
export function videoMultiImageAutoSwitchMode(
  mode: VideoGenMode,
  model: VideoModelRef,
  imageCount: number,
): VideoGenMode | null {
  if (mode !== "imageToVideo" || imageCount <= 1) return null;
  const modelId = videoModelIdOf(model);
  if (isHappyHorseVideoModel(modelId)) return null;
  if (!videoModelAcceptsMultipleImages(modelId)) return null;
  const candidates: VideoGenMode[] = ["allReference", "imageReference"];
  return candidates.find((candidate) => isVideoModeSupportedByModel(candidate, model)) ?? null;
}

/**
 * Seedance 2.0 音频引用的时长边界。厂商口径是**逐条**，没有一个字提到总和：
 * `[InvalidParameter.DurationTooShort] Duration must be between 1.8s and 15.2s`。
 *
 * 所以这里也逐条卡，两头都卡。**别再回到按总时长判定**：那会把 3 条各 6s（每条都
 * 在 1.8~15.2 区间内、厂商必然放行）的合法组合拦在本地，用一条我们自己臆想出来的
 * 规则挡住用户。后端 freezone omni-gen 端点（`validate_omni_reference_limits`）只
 * 校验条数（图≤9 / 视频≤3 / 音频≤3 / 总数≤12），同样没有总时长这回事。
 *
 * 注：`seedance2_i2v/pipeline.py` 里那个 `MAX_SEEDANCE2_REFERENCE_AUDIO_TOTAL_SECONDS`
 * 总时长守卫属于**剧集 beat 流水线的参考声线**（角色工作台 3-5s 声音克隆样本），与画布
 * 这条 omni-gen 路径无关，不要拿它给这里的总时长限制背书。
 *
 * 文案里的秒数一律从这两个常量推（`/ 1000`），别在调用点另写一遍字面量，否则改阈值
 * 时提示会静默漂移。
 */
export const MIN_AUDIO_REFERENCE_DURATION_MS = 1_800;
export const MAX_AUDIO_REFERENCE_DURATION_MS = 15_200;

export type AudioDurationRejection = {
  kind: "tooShort" | "tooLong";
  clips: { label: string; durationMs: number }[];
};

/**
 * 提交前音频时长守卫（仅 Seedance 2.0 的全能参考路径调用，其它模型边界未知）。
 *
 * `durationMs` 为 null = 探测不出时长（音频节点没渲染过波形，且 `<audio>` 探测撞上
 * CORS / 网络 / 超时）。这类一律**不参与判定**——宁可放过去让后端兜底，也不要凭空
 * 拦住一次正常提交。
 *
 * 太短优先于太长上报：同时越界时先修哪条都行，报一类比混在一起列更好读。
 */
export function audioReferenceDurationRejection(
  clips: readonly { label: string; durationMs: number | null }[],
): AudioDurationRejection | null {
  const measured = clips.filter(
    (clip): clip is { label: string; durationMs: number } =>
      typeof clip.durationMs === "number" && clip.durationMs > 0,
  );
  const tooShort = measured.filter(
    (clip) => clip.durationMs < MIN_AUDIO_REFERENCE_DURATION_MS,
  );
  if (tooShort.length > 0) {
    return { kind: "tooShort", clips: tooShort };
  }
  const tooLong = measured.filter(
    (clip) => clip.durationMs > MAX_AUDIO_REFERENCE_DURATION_MS,
  );
  if (tooLong.length > 0) {
    return { kind: "tooLong", clips: tooLong };
  }
  return null;
}

/**
 * 违规条目的秒数展示——**不能四舍五入到与阈值自相矛盾**。
 *
 * 早先用 `toFixed(1)`，1.799s 会显示成「1.8s」、15.201s 显示成「15.2s」：用户看到
 * 的正好是合法边界值，却被告知越界，只能怀疑是我们算错了。时长本身就是整毫秒
 * （`Math.round(secs * 1000)`），所以按毫秒精度展示，再去掉无意义的尾随 0：
 * 900 → `0.9`、1799 → `1.799`、15201 → `15.201`、6000 → `6`。
 */
function formatClipSeconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(3).replace(/\.?0+$/, "");
}

/**
 * 把违规条目拼成提示里的 `{{clips}}`（tooShort / tooLong 共用）。
 *
 * 括号和分隔符都从 locale 取（zh 用全角括号 + 顿号，en 用半角括号 + 逗号），别在
 * 调用点写死——这里曾经硬编码 `（）` 和 `、`，en 用户会看到一串中文标点。
 */
export function formatAudioDurationClips(
  clips: readonly { label: string; durationMs: number }[],
  translate: (key: string, vars?: Record<string, string | number>) => string,
): string {
  return clips
    .map((clip) =>
      translate("node.videoNode.audio.clipDuration", {
        label: clip.label,
        seconds: formatClipSeconds(clip.durationMs),
      }),
    )
    .join(translate("node.videoNode.audio.clipSeparator"));
}

/**
 * 提交前守卫：当前 (模型, 模式) 是否会**丢弃或被后端直接拒绝**已接入的上游素材。
 * 返回非空理由则应禁用提交、并把理由显示到按钮 tooltip 上，替代「静默丢素材 / 提交 400」。
 *
 * 规则对齐后端 freezone i2v / omni-gen 端点（src/novelvideo/api/routes/freezone.py）：
 * - 视频素材：仅「全能参考」(omni，Seedance 2.0) 与「视频编辑」(HappyHorse) 消费，
 *   其余模式静默丢弃 → 拦；
 * - 音频素材：仅「全能参考」(omni，Seedance 2.0) 消费，其余模式静默丢弃 → 拦；
 * - 多图(>1)：i2v 端点仅 Seedance 2.0 / HappyHorse 放行，非 2.0 非 HappyHorse
 *   （Seedance 1.x）传 >1 图后端直接 400 → 拦。
 *
 * 非 2.0 / 非 HappyHorse 一接入视频/音频就无模式可消费（allReference / videoEdit 均
 * 不受支持），因此这三条只会在真正会丢素材 / 400 的场景触发；2.0 / HappyHorse 的自动
 * 推导 effect 会先把模式导到能消费素材的模式，不会误伤。
 */
export function videoSubmitMediaRejectionReason(
  mode: VideoGenMode,
  modelId: string | null | undefined,
  counts: { images: number; videos: number; audios: number },
): string | null {
  if (counts.videos > 0 && mode !== "allReference" && mode !== "videoEdit") {
    return "该模型不支持视频素材";
  }
  if (counts.audios > 0 && mode !== "allReference") {
    return "该模型不支持音频素材";
  }
  if (counts.images > 1 && !videoModelAcceptsMultipleImages(modelId)) {
    return "该模型单次仅支持 1 张图片";
  }
  return null;
}

/**
 * 模型选择器里某个候选**为什么不能选**（非 null 则置灰 + 悬浮显示这句理由）。
 *
 * 与上面的 `videoSubmitMediaRejectionReason` 是一对：那条管「选定模型后能不能提交」，
 * 这条管「带着当前这堆上游素材，还能不能切到这个模型」。要维持的不变量是
 * **「不置灰 ⇒ 存在一个该模型支持、且提交守卫放行的模式」**——不是逐条阈值相等。
 * 逐条相等这个说法在这里不成立：HappyHorse 的多图 / 视频都由它自己的 r2v / 视频编辑
 * 路径消化，两条守卫本来就写着不同的判断；真正不能破的是「选得进去就必须走得通」，
 * 否则用户会被放进一个提交必被拦、界面上又毫无预兆的死胡同。
 *
 * 三处阈值的由来：
 * - Seedance 1.x 是 **>1 图**，不是 >0：后端 i2v 端点只在 `len(source_paths) > 1`
 *   且非 2.0 非 HappyHorse 时才 400（freezone.py），单图首帧正是 1.x 唯一能用、也是
 *   `videoEmptyStateCtaModes` 明确推荐给它的模式。写成 >0 会把「一张图 + Seedance
 *   1.5 Pro」这个完全合法的常规组合整个锁死。
 * - HappyHorse 只拦音频：音频只有全能参考(omni, 2.0)能消费，而
 *   `isVideoModeSupportedByModel` 里 HappyHorse 永远到不了 allReference——不拦的话
 *   「HappyHorse + 音频节点」就是上面说的那种死胡同（选得进去、提交必被拦）。
 *   它的多图（r2v）和视频（视频编辑）都能消化，不拦。
 * - Grok Video Channel 只支持图片。注：它当前在后端是关掉的
 *   （`FREEZONE_DISABLED_VIDEO_BACKENDS`），不会出现在选择器里，这条分支是休眠的。
 */
export function videoModelReferenceDisabledReason(
  modelId: string | null | undefined,
  counts: { images: number; videos: number; audios: number },
): string | null {
  if (isGrokVideoChannelModel(modelId)) {
    if (counts.videos > 0 || counts.audios > 0) {
      return "Grok Video Channel 仅支持图片素材";
    }
    if (counts.images > 8) {
      return "Grok Video Channel 最多支持 1 张首帧和 7 张参考图";
    }
    return null;
  }
  if (isHappyHorseVideoModel(modelId)) {
    if (counts.audios > 0) {
      return "该模型不支持音频素材";
    }
    return null;
  }
  if (isSeedance1xVideoModel(modelId)) {
    if (counts.videos > 0 || counts.audios > 0) {
      return "该模型仅支持图片素材";
    }
    if (counts.images > 1) {
      return "该模型单次仅支持 1 张图片";
    }
  }
  return null;
}

export interface VideoReferenceAutoSwitch {
  /** 目标模型的 `id`（存进 `VideoNodeData.model` 的那个值，不是 apiModel）。 */
  modelId: string;
  genMode: VideoGenMode;
}

/**
 * 上游接入视频 / 音频时的**自动救场**：Seedance 1.x 根本消费不了这两类素材
 * （i2v 端点只收图，omni 端点非 2.0 直接 400），把用户留在 1.x 上只能得到一次
 * 必然失败的提交。用户连上视频/音频节点这个动作本身就是明确意图，所以直接替他
 * 换成能吃这些素材的 Seedance 2.0，并落到唯一能消费它们的「全能参考」。
 *
 * 只管 Seedance 1.x：
 * - HappyHorse 有自己的「视频编辑」路径，能吃视频，不该被抢走；
 * - Grok Video Channel 是用户显式选的独立渠道，只支持图片，这里不替他改渠道，
 *   继续由选择器置灰 + 提交守卫兜底；
 * - 2.0 本来就支持，无需动。
 *
 * 素材计数请传**按节点类型**的口径（空的视频节点也算），并且和喂给
 * `videoModelReferenceDisabledReason` 的口径保持同源 —— 否则会出现「effect 把模型
 * 切走、选择器又允许切回来」的来回打架。
 *
 * 目标锁定**基础款 Seedance 2.0**，而不是列表里排最前的 `Seedance2.0 Fast`：fast 是
 * 提速降档的变体，替用户救场时把他悄悄放到降档模型上不合适；基础款也正是后端
 * `FreezoneVideoGenRequest.model` 的默认值。基础款不在候选列表里（接口只下发了变体）
 * 时退到任意一个 2.0——总比让他卡在必然失败的 1.x 上强；一个 2.0 都没有则返回 null，
 * 宁可不动也不要瞎切。
 */
function pickVideoReferenceAutoSwitch(
  currentModelId: string | null | undefined,
  counts: { videos: number; audios: number },
  models: readonly { id: string; apiModel?: string }[],
): VideoReferenceAutoSwitch | null {
  if (counts.videos === 0 && counts.audios === 0) {
    return null;
  }
  if (!isSeedance1xVideoModel(currentModelId)) {
    return null;
  }
  const target =
    models.find((model) => isBaseSeedance2VideoModel(model.apiModel ?? model.id)) ??
    models.find((model) => isSeedance2VideoModel(model.apiModel ?? model.id));
  return target ? { modelId: target.id, genMode: "allReference" } : null;
}

export type VideoReferenceAutoSwitchAction =
  /** 什么都别做（还在加载 / 已经救过一次 / 本来就不需要换）。 */
  | { kind: "none" }
  /** 视频音频都撤走了 —— 松开一次性闩锁，为下一次接入做准备。 */
  | { kind: "release" }
  /** 写这一个 patch（模型 + 模式一次写完），并落闩。 */
  | { kind: "switch"; modelId: string; genMode: VideoGenMode };

/**
 * 自动救场的**完整闸门**——组件那条 effect 该调的就是这一个，除了改 ref 和发 patch
 * 之外不该再自己判断任何条件。把闸门做成纯函数是为了能整段测：异步加载时序（下面第
 * 一条）光测「该换成谁」是覆盖不到的，而它恰恰是最容易出事的地方。
 *
 * 三道闸，顺序有讲究：
 * 1. **素材撤走优先于一切**（含加载中）——松闩只是复位一个 ref，没有任何副作用，
 *    没必要等列表；等了反而会漏掉「加载期间用户又把线拔了」这种收尾。
 * 2. **`modelsLoading` 期间一律不动**。`useFreezoneVideoModels` 在 pending 时返回的
 *    不是空数组，而是硬编码的 `VIDEO_MODELS`——照着它挑出来的 2.0 未必存在于该项目
 *    的真列表里。提前切了还落闩，真列表回来也不再纠正，节点就卡在一个后端不认识的
 *    模型上，提交直接 400。**注意只看 `isLoading`，不要连 `isFallback` 一起挡**：
 *    isFallback 在「URL 没有 project」「拉取失败」「后端返回空列表」这三种**已落定**
 *    的情况下会一直是 true，而此时选择器渲染的正是同一份 `VIDEO_MODELS`（
 *    `ProviderModelPicker` 用的就是这个 hook 的 models），2.0 就在里面、用户手动也
 *    能选中；连它一起挡等于在这些情况下永久关掉救场。
 * 3. **`alreadySwitched` 落闩后不再纠正**，避免把 undo 堵死（见组件里的注释）。
 *
 * 「没切成」不落闩：列表里一个 2.0 都没有时返回 `none`，把这次跳变留着，等列表变了
 * 还有机会补救。
 */
export function videoReferenceAutoSwitchAction(input: {
  counts: { videos: number; audios: number };
  currentModelId: string | null | undefined;
  models: readonly { id: string; apiModel?: string }[];
  modelsLoading: boolean;
  alreadySwitched: boolean;
}): VideoReferenceAutoSwitchAction {
  const { counts, currentModelId, models, modelsLoading, alreadySwitched } = input;
  if (counts.videos === 0 && counts.audios === 0) {
    return { kind: "release" };
  }
  if (modelsLoading || alreadySwitched) {
    return { kind: "none" };
  }
  const target = pickVideoReferenceAutoSwitch(currentModelId, counts, models);
  return target
    ? { kind: "switch", modelId: target.modelId, genMode: target.genMode }
    : { kind: "none" };
}
