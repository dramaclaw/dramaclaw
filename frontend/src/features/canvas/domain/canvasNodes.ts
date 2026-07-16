// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { Edge, Node, XYPosition } from '@xyflow/react';
import type {
  DirectorControlFrameBundle,
  DirectorObjectLayer,
  DirectorWorldSource,
} from '@/features/viewer-kit/three-d/directorManifest';

export const CANVAS_NODE_TYPES = {
  upload: 'uploadNode',
  imageEdit: 'imageNode',
  imageGen: 'imageGenNode',
  exportImage: 'exportImageNode',
  beatContext: 'beatContextNode',
  textAnnotation: 'textAnnotationNode',
  group: 'groupNode',
  storyboardSplit: 'storyboardNode',
  storyboardGen: 'storyboardGenNode',
  video: 'videoNode',
  audio: 'audioNode',
  videoStory: 'videoStoryNode',
  videoCompose: 'videoComposeNode',
  script: 'scriptNode',
  pano360Viewer: 'pano360ViewerNode',
  threeDWorld: 'threeDWorldNode',
  skill: 'skillNode',
} as const;

export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[keyof typeof CANVAS_NODE_TYPES];

export const DEFAULT_ASPECT_RATIO = '1:1';
export const AUTO_REQUEST_ASPECT_RATIO = 'auto';
export const DEFAULT_NODE_WIDTH = 320;
export const EXPORT_RESULT_NODE_DEFAULT_WIDTH = 480;
export const EXPORT_RESULT_NODE_LAYOUT_HEIGHT = 360;
export const EXPORT_RESULT_NODE_MIN_WIDTH = 300;
export const EXPORT_RESULT_NODE_MIN_HEIGHT = 300;
// 缩放下限刻意小于创建/紧凑尺寸，否则节点缩不到比初始更小（配合 keepAspectRatio
// 时短边为绑定约束，按比例换算后宽屏/竖屏都能缩到一个一致的小框）。
export const EXPORT_RESULT_NODE_RESIZE_MIN_EDGE = 140;

export const IMAGE_SIZES = ['0.5K', '1K', '2K', '4K'] as const;
export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '21:9',
] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number];

/** Image quality preset, only honored by image2 models (gpt-image-2). */
export type ImageQuality = 'low' | 'medium' | 'high';

export interface NodeDisplayData {
  displayName?: string;
  [key: string]: unknown;
}

export interface NodeImageData extends NodeDisplayData {
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isSizeManuallyAdjusted?: boolean;
  candidate_origin?: Record<string, unknown>;
  output_role?: string;
  committed_at?: string | null;
  committed_slot_url?: string | null;
  director_control_bundle?: DirectorControlFrameBundle;
  media_kind?: string;
  [key: string]: unknown;
}

export interface UploadImageNodeData extends NodeImageData {
  sourceFileName?: string | null;
  isUploading?: boolean;
  uploadError?: string | null;
  imageOnly?: boolean;
}

export type VideoGenMode =
  | 'textToVideo'
  | 'allReference'
  | 'imageToVideo'
  | 'firstLastFrame'
  | 'imageReference'
  | 'videoEdit';

export type VideoGenQuality = '480P' | '720P' | '1080P';
export type VideoGenCount = 1 | 2 | 4;
export type Seedance2SceneOptimize = 'anime' | 'realistic';

export interface VideoNodeData extends NodeDisplayData {
  videoUrl: string | null;
  previewImageUrl?: string | null;
  /**
   * 节点被作为「上游视频引用素材」使用（例如脚本节点 spawn 出来的）。
   * 此时只显示视频本体 + 顶部 toolbar（剪辑/高清/解析/...），
   * 不渲染底部生成操作面板（Mode tabs / prompt / 提交）。
   */
  referenceOnly?: boolean;
  aspectRatio: string;
  isSizeManuallyAdjusted?: boolean;
  sourceFileName?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
  durationMs?: number | null;
  isUploading?: boolean;
  isAnalyzing?: boolean;
  analysisResult?: string | null;
  analysisError?: string | null;
  isSeparatingAv?: boolean;
  // clip editor (libtv-style) ------------------------------------------------
  isClipMode?: boolean;
  clipStartMs?: number | null;
  clipEndMs?: number | null;
  // subtitle erase (libtv-style 智能去字幕) ----------------------------------
  /** `smart` = auto-estimate bottom subtitle band; `box` = user-drawn region. */
  subtitleEraseMode?: 'smart' | 'box' | null;
  /** Box coords normalized 0..1 against the source frame. Only set in 'box' mode. */
  subtitleEraseBox?: { x: number; y: number; width: number; height: number } | null;
  // generation fields (libtv-style operation panel)
  prompt?: string;
  /**
   * 生成数量 > 1 时一次生成的全部结果 URL（含主视频）。节点收拢时渲染成
   * 叠卡画册（同图片节点），videoUrl 始终等于其中被选为主视频的那条。
   * 单条生成时为空。
   */
  generationBatch?: string[] | null;
  genMode?: VideoGenMode;
  model?: string;
  quality?: VideoGenQuality;
  durationSec?: number;
  generateAudio?: boolean;
  /**
   * 真人素材审核开关。仅 Seedance 2.0 视频模型展示。开启后请求体里
   * `human_review: true`，素材含真实人脸时降低被拦截概率（不保证通过、可能增加审核时间）。
   * 默认 false / 不展示时不发送。
   */
  humanReview?: boolean;
  sceneOptimize?: Seedance2SceneOptimize;
  count?: VideoGenCount;
  /** id of a [[cameraMovementPresets]] entry — libtv-style 运镜 preset. */
  cameraMovement?: string | null;
  /**
   * 用户手动拖拽调整后的上游引用顺序(上游节点 id 列表)。决定参考 chips 的展示顺序、
   * 「图片N / 音频N」编号,以及提交给后端的 reference/首尾帧 顺序。未列入的上游节点
   * (如新接入的)排在其后,按节点 y 坐标兜底。
   */
  referenceOrder?: string[];
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  generationError?: string | null;
  // 视频高清（upscale）标记 ----------------------------------------------------
  // 视频节点「高清」操作 spawn 的视频节点带这些字段：复用 video 节点的播放器 / 角标 /
  // 尺寸（与普通视频节点一致），但用 isUpscaleNode 抑制底部生成面板，改走选中时常驻的
  // VideoUpscaleEditorOverlay（提交 submitFreezoneVideoUpscale，高清结果回写到本节点
  // videoUrl）。
  /** 标记此视频节点是「视频高清」节点（参数面板 + upscale 提交，而非常规生成）。 */
  isUpscaleNode?: boolean;
  /** 待高清的上游视频静态地址。 */
  upscaleSourceUrl?: string;
  /** 目标清晰度档位。 */
  upscaleResolution?: '1080p' | '2k' | '4k';
  /** 降噪强度。 */
  upscaleDenoise?: 'none' | '1x' | '2x';
  [key: string]: unknown;
}

/**
 * 「视频合成」节点。把 ≥2 个上游视频节点（可选音频节点）连进来后，打开 libtv 风格
 * 的时间线剪辑器（{@link VideoComposeModal}）编排导出。最终合成走后端
 * `submitFreezoneVideoCompose`，导出地址回写到 `resultVideoUrl`。
 */
export interface VideoComposeNodeData extends NodeDisplayData {
  /** 最近一次合成导出的视频 url。 */
  resultVideoUrl?: string | null;
  /** 结果视频的封面（暂未生成时为空）。 */
  previewImageUrl?: string | null;
  /** 上次使用的导出分辨率。 */
  resolution?: '720p' | '1080p';
  /**
   * 合成编辑器的草稿时间线（关闭弹窗时写回，重开/刷新后恢复）。结构为
   * `ComposeTimelineState`，这里存 unknown 以免领域层反向依赖 compose 特性层。
   */
  draftTimeline?: unknown;
  [key: string]: unknown;
}

export type ExportImageNodeResultKind =
  | 'generic'
  | 'storyboardGenOutput'
  | 'storyboardSplitExport'
  | 'storyboardFrameEdit'
  | 'matte'
  | 'upscale';

export interface ExportImageNodeData extends NodeImageData {
  resultKind?: ExportImageNodeResultKind;
}

export interface GroupNodeData extends NodeDisplayData {
  label: string;
  /** 组背景色（基础 hex，见 groupColors.ts）。空/缺省走默认底色。 */
  backgroundColor?: string | null;
  /**
   * Marks a group created via "合并分镜组" — its members are laid out as an
   * ordered shot (分镜) grid (宫格). Plain "打组" groups leave this unset.
   */
  storyboardGroup?: boolean;
  /** Cell aspect ratio key for the storyboard grid, e.g. "16:9". */
  storyboardAspect?: string;
  /** Column count of the storyboard grid. */
  storyboardCols?: number;
  /** Show a 1-based index badge on each cell. */
  storyboardShowIndex?: boolean;
  /** Largest member content box at merge time — the cell-size floor for re-layout. */
  storyboardBaseWidth?: number;
  storyboardBaseHeight?: number;
  [key: string]: unknown;
}

export type TextNodeMode =
  | 'writing'
  | 'textToVideo'
  | 'imageToPrompt'
  // textToMusic: 历史命名,实为「克隆音频」(语音克隆 TTS),派生语音音频节点。
  | 'textToMusic'
  // textToMusicGen: 「文字生成音乐」,派生 audioKind='music' 的音频节点(走 /freezone/audio/music)。
  | 'textToMusicGen';

export interface TextAnnotationNodeData extends NodeDisplayData {
  content: string;
  /**
   * 节点被作为「上游引用素材」使用（例如脚本节点 spawn 出来的）。
   * 此时只显示编辑卡片，不渲染 mode 列表 / 模型选择 / 提交按钮。
   */
  referenceOnly?: boolean;
  /**
   * Steering description shown in the ops textarea for `imageToPrompt` mode.
   * Kept separate from `content` so the API result can overwrite the preview
   * card without erasing the user's instruction.
   */
  instruction?: string;
  mode?: TextNodeMode;
  model?: string;
  /**
   * 用户已从能力 picker 选过一次（如「文字生成音乐」派生了下游音频节点）。
   * 置真后该文本节点恒为纯文本编辑区，空内容时也不再退回显示「试试」picker。
   */
  pickerDismissed?: boolean;
  extraParams?: Record<string, unknown>;
  isGenerating?: boolean;
  /** 反推提示词等异步任务的开始时间戳，喂给生成中 loading 覆盖层模拟进度。 */
  generationStartedAt?: number | null;
  [key: string]: unknown;
}

export interface BeatContextNodeData extends NodeDisplayData {
  content?: string;
  projectId?: string;
  episode?: number;
  beat?: number;
  snapshot?: {
    visualDescription?: string;
    narrationSegment?: string;
    sceneId?: string;
    sceneVariantId?: string;
    timeOfDay?: string;
    detectedIdentities?: string[];
    detectedProps?: string[];
    sketchColors?: Record<string, string>;
    propMarkerColors?: Record<string, string>;
    selectedBackgroundExists?: boolean;
    currentSketchExists?: boolean;
    currentFrameExists?: boolean;
    [key: string]: unknown;
  };
  syncStatus?: 'fresh' | 'stale' | 'syncing' | 'error';
  errorMessage?: string;
  mainline_context?: unknown;
  beat_edit_fields?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ImageEditNodeData extends NodeImageData {
  prompt: string;
  model: string;
  size: ImageSize;
  requestAspectRatio?: string;
  generationMode?: 'text_to_image' | 'image_to_image' | 'all_reference' | 'image_reference';
  extraParams?: Record<string, unknown>;
  capabilityId?: string;
  capabilityParams?: Record<string, unknown>;
  capabilityInputs?: Record<
    string,
    {
      nodeId?: string;
      role?: string;
      sourceUrl?: string;
      assetKind?: string;
    }
  >;
  capabilityOutputKind?: string;
  capabilityDefaultPushTarget?: Record<string, unknown>;
  compiledPromptPreview?: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
}

export type ImageGenCount = 1 | 2 | 4;

export interface ImageGenFocusRegion {
  /** Normalized 0-1 coordinates against the upstream source image. */
  sourceUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  aspectRatio?: string;
}

export interface ImageGenCameraSelection {
  cameraBodyId?: string | null;
  lensId?: string | null;
  focalLengthMm?: number | null;
  aperture?: string | null;
}

export interface ImageGenNodeData extends NodeImageData {
  prompt: string;
  model: string;
  size: ImageSize;
  /**
   * 生成数量 > 1 时一次生成的全部结果 URL（含主图）。节点收拢时渲染成
   * 叠卡画册（卡片边缘从主图后探出），imageUrl 始终等于其中被选为主图
   * 的那张。单张生成时为空。
   */
  generationBatch?: string[] | null;
  /** Quality preset for image2 models; defaults to 'medium' when unset. */
  quality?: ImageQuality;
  requestAspectRatio?: string;
  count?: ImageGenCount;
  styleTemplateId?: string | null;
  focusRegion?: ImageGenFocusRegion | null;
  cameraSelection?: ImageGenCameraSelection | null;
  /** User-uploaded reference image, fed into the generation request. */
  referenceImageUrl?: string | null;
  /** Present/mainline workflow nodes can auto-commit their generated image to slot_target. */
  autoCommitOnGenerate?: boolean;
  /** Local-only marks/annotations placed on upstream image. */
  marks?: Array<{ id: string; label: string; x: number; y: number }>;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  /** Last failure reason, kept on the node until the next submit. */
  generationError?: string | null;
  /** Gateway request id parsed from the last failure, for support tracing. */
  generationErrorRequestId?: string | null;
}

export interface StoryboardFrameItem {
  id: string;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio?: string;
  note: string;
  order: number;
}

export interface StoryboardExportOptions {
  showFrameIndex: boolean;
  showFrameNote: boolean;
  notePlacement: 'overlay' | 'bottom';
  imageFit: 'cover' | 'contain';
  frameIndexPrefix: string;
  cellGap: number;
  outerPadding: number;
  fontSize: number;
  backgroundColor: string;
  textColor: string;
}

export interface StoryboardSplitNodeData {
  displayName?: string;
  aspectRatio: string;
  frameAspectRatio?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardFrameItem[];
  exportOptions?: StoryboardExportOptions;
  [key: string]: unknown;
}

export interface StoryboardGenFrameItem {
  id: string;
  description: string;
  referenceIndex: number | null;
}

export type StoryboardRatioControlMode = 'overall' | 'cell';

export interface StoryboardGenNodeData {
  displayName?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardGenFrameItem[];
  ratioControlMode?: StoryboardRatioControlMode;
  model: string;
  size: ImageSize;
  requestAspectRatio: string;
  extraParams?: Record<string, unknown>;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  [key: string]: unknown;
}

export type AudioTextSegment =
  | { type: 'text'; value: string }
  | { type: 'pause'; durationSec: number }
  | { type: 'filler'; token: string };

/**
 * 后端 freezone-audio 声线引用：scope 必填，character_name / identity_id / slot
 * 视 scope 而定。与 ops.ts 中的 `FreezoneAudioVoiceRef` 同构，但这里保留前端
 * 自带的 camelCase 字段，避免节点数据被序列化为 snake_case。
 */
export interface AudioVoiceRef {
  scope:
    | 'project_narrator'
    | 'user_custom'
    | 'character_default'
    | 'character_age_group'
    | 'identity'
    | 'identity_resolved';
  characterName?: string;
  identityId?: string;
  slot?: string;
  /** scope=user_custom 时必填：账号级我的音色 ID（来自 /freezone/audio/voices）。 */
  voiceId?: string;
}

export interface AudioNodeData extends NodeDisplayData {
  audioUrl: string | null;
  sourceFileName?: string | null;
  durationMs?: number | null;
  isUploading?: boolean;
  /**
   * 音频节点的生成类型：
   * - 'speech'(默认/缺省)：克隆音频,文本转语音(/freezone/audio/speech),用 voiceRef/语气词。
   * - 'music'：文字生成音乐(/freezone/audio/eleven-music),用 text 作为音乐描述 prompt。
   */
  audioKind?: 'speech' | 'music';
  /** music 模式：生成长度(毫秒),范围 3000–600000,缺省按后端默认 30000。 */
  musicLengthMs?: number;
  /** music 模式：是否强制纯音乐(force_instrumental),缺省 true。 */
  forceInstrumental?: boolean;
  /** music 模式：是否严格遵守音乐段落时长策略(respect_sections_durations),缺省 true。 */
  respectSectionsDurations?: boolean;
  // operations panel (TTS) ---------------------------------------------------
  /** 要合成的纯文本。新字段，未来主用。 */
  text?: string;
  /** 旧字段：分段编辑器留下的 segments；保留只为兼容老节点数据。 */
  segments?: AudioTextSegment[];
  /**
   * 语气词（情绪提示词）。用户自由输入，提交时映射到后端 `emotion_prompt`。
   * 示例："紧张、压低声音、带一点恐惧感"。留空时后端按项目解说风格走默认。
   */
  emotionPrompt?: string;
  /** 选中的声线引用（freezone-audio references 接口里的一条记录）。 */
  voiceRef?: AudioVoiceRef | null;
  /** 当前声线的展示名（缓存自 references 接口，避免每次选完都要重新拉列表）。 */
  voiceLabel?: string;
  /** 当前声线的语言标签（来自 references；可空）。 */
  voiceLanguage?: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  /**
   * 生成失败信息。持久化到节点数据（而非面板本地 state），这样画布虚拟化
   * 卸载/重挂后仍能展示错误 + 重试，不会因组件重建而丢失。成功/开始时清空。
   */
  generationError?: string | null;
  /** Transient: which format the download menu is currently transcoding to. */
  convertingAudioFormat?: 'mp3' | 'm4a' | 'wav' | null;
  [key: string]: unknown;
}

export interface VideoStoryRow {
  /** 镜号 — 1-based shot index, optional because some payloads only sequence rows by array order. */
  shotNumber?: number | string | null;
  /** 开始时间 (HH:MM:SS or seconds, kept as string for display flexibility). */
  startTime?: string | null;
  /** 结束时间. */
  endTime?: string | null;
  /** 时长 (e.g. "1.2s"). */
  duration?: string | null;
  /** 画面描述. */
  visualDescription?: string | null;
  /** 叙事内容. */
  narrative?: string | null;
  /** 景别. */
  shotSize?: string | null;
  /** 摄影机角度. */
  cameraAngle?: string | null;
  /** 摄影机运动. */
  cameraMovement?: string | null;
  /** 焦距与景深. */
  focalAndDof?: string | null;
  /** 光线. */
  lighting?: string | null;
  /** 背景音乐. */
  backgroundMusic?: string | null;
  /** 人声/音效. */
  voiceAndSfx?: string | null;
  /** 图像生成提示词. */
  imagePrompt?: string | null;
  /** 视频运动提示词. */
  videoMotionPrompt?: string | null;
  /** 关键帧静态 URL. */
  keyframeUrl?: string | null;
  /** Raw backend row kept around so we can render fields we didn't normalize. */
  raw?: Record<string, unknown>;
}

export interface VideoStoryNodeData extends NodeDisplayData {
  /** Source video URL the rows were derived from (for audit / re-runs). */
  sourceVideoUrl?: string | null;
  rows: VideoStoryRow[];
  /** Last successful raw payload from the backend for debug/regen. */
  rawResult?: Record<string, unknown> | null;
  isAnalyzing?: boolean;
  /** 解析开始时间戳,用于 loading 遮罩的进度百分比模拟。 */
  analysisStartedAt?: number | null;
  analysisError?: string | null;
  [key: string]: unknown;
}

export type ScriptGenAction = 'fromScript' | 'fromVideoRef' | 'fromCharacter';

export interface ScriptNodeData extends NodeDisplayData {
  /** 操作区输入的剧情/参考说明文本 */
  prompt?: string;
  /** 选中的脚本生成模型 id（前端写死，后端接口未提供） */
  model?: string;
  /** 用户最近一次点击的快捷动作（不影响提交，仅用于 UI 高亮 / 默认提示） */
  lastAction?: ScriptGenAction | null;
  /** 生成结果（freezone story-script 接口返回的 { title, rows[] }）。 */
  scriptResult?: unknown;
  /** 最近一次生成的标题，便于在节点头展示。 */
  scriptTitle?: string | null;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  /** 最近一次生成失败的错误信息，渲染在节点本体上（提交面板取消选中后仍可见）。 */
  generationError?: string | null;
  [key: string]: unknown;
}

/**
 * 360° 全景查看器节点。
 *
 * 视图状态（viewYawDeg / viewPitchDeg）只是 Photo Sphere Viewer 渲染时的"当前
 * 视角"，不参与持久化（用户每次打开节点都会回到 yaw=0/pitch=0）。
 * 持久化的是"校正"参数：sphereCorrectionDeg 把贴图旋到水平，frontYawDeg 把
 * 渲染坐标系里的"正前方"对齐到场景的真正前方，fovDeg 是默认 FOV。
 */
export interface Pano360ViewerNodeData extends NodeDisplayData {
  imageUrl: string | null;
  previewImageUrl?: string | null;
  /** 上游连接节点 id，仅用作 audit。 */
  sourceNodeId?: string | null;
  /** 球面贴图校正（角度制，roll/pitch/yaw 都是 [-180, 180]，pitch 内部裁到 [-90, 90]）。 */
  sphereCorrectionDeg: { roll: number; pitch: number; yaw: number };
  /** 场景里"正前方"对应的 yaw（角度制，[-180, 180]）。 */
  frontYawDeg: number;
  /** 默认 FOV，单位°，范围 [FOV_MIN, FOV_MAX] = [5, 170]。 */
  fovDeg: number;
  /** 最后一次截图导出的 JSON，便于排错；非持久化生命周期。 */
  lastExportedEntry?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * 3D 世界节点。图片上游走 freezone/image-to-3gs：普通图用 source_kind="master"，
 * 360 全景图用 source_kind="pano"。节点也可以直接把 360 图作为 pano360 source
 * 加入导演世界取景。生成完成后优先写 `sources`，`plyUrl`/`panoUrl` 继续作为
 * 节点本地快捷字段。
 */
export interface ThreeDWorldNodeData extends NodeDisplayData {
  /** 用户提示词（操作面板下方输入）。 */
  prompt?: string;
  /** 模型 id。模型当前未对接，前端写死为 'marble-1.1'。 */
  model?: string;
  /** image-to-3gs 异步任务的 task_key，用于 await + UI 状态显示。 */
  taskKey?: string | null;
  /** 后端 SHARP 跑完后返回的 3GS 包静态地址，优先 SOG，兼容旧 PLY。 */
  plyUrl?: string | null;
  /** 360 全景图作为世界 source 时使用；只能转向取景，不能做真实空间移动。 */
  panoUrl?: string | null;
  /** Director World sources, kept in manifest-native source shape. */
  sources?: DirectorWorldSource[];
  /** Active Director World source id, mapped to manifest.active_source_id. */
  activeSourceId?: string | null;
  /** Per-source director scene snapshots; keeps pano/SOG camera and placements independent. */
  scenesBySourceId?: Record<string, unknown>;
  /** Per-source object layers, mapped to manifest snake_case when supported. */
  layersBySourceId?: Record<string, DirectorObjectLayer>;
  /** 来源节点 id，仅用于 audit。 */
  sourceNodeId?: string | null;
  /** 来源类型：image / text — 决定提交走哪条 API。 */
  sourceKind?: 'image' | 'text' | null;
  /** image-to-3gs 的来源类型（后端 source_kind 字段）：
   * master/reverse 生成单面 3GS，pano 走 360 全景。默认 master。 */
  plyKind?: 'master' | 'reverse' | 'pano';
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  /** 错误消息（提交或 task 失败时显示）。 */
  errorMessage?: string | null;
  /**
   * 节点缩略图。从素材库加入时灌入同场景的 scene image 作为封面；上游
   * 图片节点连上后优先用上游图，没上游则回落到 previewImageUrl，再没有
   * 才显示 Orbit 占位。
   */
  previewImageUrl?: string | null;
  /**
   * 3D viewer 内部编辑状态的快照（actors / props / staging + 相机视角）。
   * 用户按 viewer sidebar 的「保存场景编辑」按钮时写入；下次进入 viewer 自动恢复。
   * 结构是 viewer engine 自己定义的 `ThreeDSceneSnapshot`，对画布 store 透明。
   */
  scene?: unknown;
  [key: string]: unknown;
}

export interface SkillNodeData extends NodeDisplayData {
  skill_id: string;
  skill_schema_version?: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationError?: string | null;
  skillRunId?: string | null;
  skillInputSignature?: string | null;
  skillIdempotencyKey?: string | null;
  generationTaskKey?: string | null;
  generationTaskType?: string | null;
  generationTaskJobId?: string | null;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export type CanvasNodeData =
  | UploadImageNodeData
  | ExportImageNodeData
  | BeatContextNodeData
  | TextAnnotationNodeData
  | GroupNodeData
  | ImageEditNodeData
  | ImageGenNodeData
  | StoryboardSplitNodeData
  | StoryboardGenNodeData
  | VideoNodeData
  | AudioNodeData
  | VideoStoryNodeData
  | VideoComposeNodeData
  | ScriptNodeData
  | Pano360ViewerNodeData
  | ThreeDWorldNodeData
  | SkillNodeData;

export type CanvasNode = Node<CanvasNodeData, CanvasNodeType>;
export type CanvasEdge = Edge;

export interface NodeCreationDto {
  type: CanvasNodeType;
  position: XYPosition;
  data?: Partial<CanvasNodeData>;
}

export interface StoryboardNodeCreationDto {
  position: XYPosition;
  rows: number;
  cols: number;
  frames: StoryboardFrameItem[];
}

export const NODE_TOOL_TYPES = {
  crop: 'crop',
  annotate: 'annotate',
  splitStoryboard: 'split-storyboard',
} as const;

export type NodeToolType = (typeof NODE_TOOL_TYPES)[keyof typeof NODE_TOOL_TYPES];

export interface ActiveToolDialog {
  nodeId: string;
  toolType: NodeToolType;
}

export function isUploadNode(
  node: CanvasNode | null | undefined
): node is Node<UploadImageNodeData, typeof CANVAS_NODE_TYPES.upload> {
  return node?.type === CANVAS_NODE_TYPES.upload;
}

export function isImageEditNode(
  node: CanvasNode | null | undefined
): node is Node<ImageEditNodeData, typeof CANVAS_NODE_TYPES.imageEdit> {
  return node?.type === CANVAS_NODE_TYPES.imageEdit;
}

export function isImageGenNode(
  node: CanvasNode | null | undefined
): node is Node<ImageGenNodeData, typeof CANVAS_NODE_TYPES.imageGen> {
  return node?.type === CANVAS_NODE_TYPES.imageGen;
}

export function isExportImageNode(
  node: CanvasNode | null | undefined
): node is Node<ExportImageNodeData, typeof CANVAS_NODE_TYPES.exportImage> {
  return node?.type === CANVAS_NODE_TYPES.exportImage;
}

export function isBeatContextNode(
  node: CanvasNode | null | undefined
): node is Node<BeatContextNodeData, typeof CANVAS_NODE_TYPES.beatContext> {
  return node?.type === CANVAS_NODE_TYPES.beatContext;
}

export function isGroupNode(
  node: CanvasNode | null | undefined
): node is Node<GroupNodeData, typeof CANVAS_NODE_TYPES.group> {
  return node?.type === CANVAS_NODE_TYPES.group;
}

export function isStoryboardGroupNode(
  node: CanvasNode | null | undefined
): node is Node<GroupNodeData, typeof CANVAS_NODE_TYPES.group> {
  return isGroupNode(node) && node.data.storyboardGroup === true;
}

export function isProtectedProjectionGroupNode(
  node: CanvasNode | null | undefined
): node is Node<GroupNodeData, typeof CANVAS_NODE_TYPES.group> {
  if (!isGroupNode(node)) {
    return false;
  }
  return (
    node.data.user_spawned !== true &&
    typeof node.data.projection_key === 'string' &&
    node.data.projection_key.trim().length > 0
  );
}

export function isTextAnnotationNode(
  node: CanvasNode | null | undefined
): node is Node<TextAnnotationNodeData, typeof CANVAS_NODE_TYPES.textAnnotation> {
  return node?.type === CANVAS_NODE_TYPES.textAnnotation;
}

export function isStoryboardSplitNode(
  node: CanvasNode | null | undefined
): node is Node<StoryboardSplitNodeData, typeof CANVAS_NODE_TYPES.storyboardSplit> {
  return node?.type === CANVAS_NODE_TYPES.storyboardSplit;
}

export function isStoryboardGenNode(
  node: CanvasNode | null | undefined
): node is Node<StoryboardGenNodeData, typeof CANVAS_NODE_TYPES.storyboardGen> {
  return node?.type === CANVAS_NODE_TYPES.storyboardGen;
}

export function isVideoNode(
  node: CanvasNode | null | undefined
): node is Node<VideoNodeData, typeof CANVAS_NODE_TYPES.video> {
  return node?.type === CANVAS_NODE_TYPES.video;
}

export function isAudioNode(
  node: CanvasNode | null | undefined
): node is Node<AudioNodeData, typeof CANVAS_NODE_TYPES.audio> {
  return node?.type === CANVAS_NODE_TYPES.audio;
}

export function isSkillNode(
  node: CanvasNode | null | undefined
): node is Node<SkillNodeData, typeof CANVAS_NODE_TYPES.skill> {
  return node?.type === CANVAS_NODE_TYPES.skill;
}

export function isVideoStoryNode(
  node: CanvasNode | null | undefined
): node is Node<VideoStoryNodeData, typeof CANVAS_NODE_TYPES.videoStory> {
  return node?.type === CANVAS_NODE_TYPES.videoStory;
}

export function isScriptNode(
  node: CanvasNode | null | undefined
): node is Node<ScriptNodeData, typeof CANVAS_NODE_TYPES.script> {
  return node?.type === CANVAS_NODE_TYPES.script;
}

export function isVideoComposeNode(
  node: CanvasNode | null | undefined
): node is Node<VideoComposeNodeData, typeof CANVAS_NODE_TYPES.videoCompose> {
  return node?.type === CANVAS_NODE_TYPES.videoCompose;
}

export function isPano360ViewerNode(
  node: CanvasNode | null | undefined
): node is Node<Pano360ViewerNodeData, typeof CANVAS_NODE_TYPES.pano360Viewer> {
  return node?.type === CANVAS_NODE_TYPES.pano360Viewer;
}

export function isThreeDWorldNode(
  node: CanvasNode | null | undefined
): node is Node<ThreeDWorldNodeData, typeof CANVAS_NODE_TYPES.threeDWorld> {
  return node?.type === CANVAS_NODE_TYPES.threeDWorld;
}

export function nodeHasImage(node: CanvasNode | null | undefined): boolean {
  if (!node) {
    return false;
  }

  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    return Boolean(node.data.imageUrl);
  }

  if (isStoryboardSplitNode(node)) {
    return node.data.frames.some((frame) => Boolean(frame.imageUrl));
  }

  if (isStoryboardGenNode(node)) {
    return Boolean(node.data.imageUrl);
  }

  return false;
}

// The single image an image-bearing node's toolbar/tools should act on.
// imageGen has no generated result until the user hits 生成, but an uploaded
// 参考图 (referenceImageUrl) is still the image shown on the node — operations
// like 抠图 / 裁剪 / 分格抽取 should target it, matching ImageGenNode's previewUrl
// fallback order (imageUrl → previewImageUrl → referenceImageUrl).
export function resolveNodeSourceImageUrl(
  node: CanvasNode | null | undefined
): string | null {
  if (!node) {
    return null;
  }
  if (isImageGenNode(node)) {
    return node.data.imageUrl || node.data.previewImageUrl || node.data.referenceImageUrl || null;
  }
  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    return node.data.imageUrl || node.data.previewImageUrl || null;
  }
  return null;
}
