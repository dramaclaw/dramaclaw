// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  type BeatContextNodeData,
  type AudioNodeData,
  type ImageSize,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeData,
  type GroupNodeData,
  type ImageEditNodeData,
  type ImageGenNodeData,
  type Pano360ViewerNodeData,
  type PrevizNodeData,
  type ScriptNodeData,
  type SkillNodeData,
  type StoryboardSplitNodeData,
  type StoryboardGenNodeData,
  type StyleNodeData,
  type TextAnnotationNodeData,
  type ThreeDWorldNodeData,
  type UploadImageNodeData,
  type VideoComposeNodeData,
  type VideoNodeData,
  type VideoStoryNodeData,
} from './canvasNodes';
import { DEFAULT_NODE_DISPLAY_NAME } from './nodeDisplay';
import { SKILL_SCHEMA_VERSION } from '@/features/freezone/context/skillRoles';
import { DEFAULT_IMAGE_MODEL_ID } from '../models';
import {
  DEFAULT_SHARED_MODEL_ID,
  DEFAULT_VIDEO_MODEL_ID,
} from '../ui/ProviderModelPicker';
import { readLastVideoModel } from './lastVideoModel';

export type MenuIconKey = 'upload' | 'sparkles' | 'layout' | 'text' | 'video' | 'audio' | 'script' | 'pano360' | 'threeDWorld' | 'videoCompose' | 'previz';

export interface CanvasNodeCapabilities {
  toolbar: boolean;
  promptInput: boolean;
}

export interface CanvasNodeConnectivity {
  sourceHandle: boolean;
  targetHandle: boolean;
  connectMenu: {
    fromSource: boolean;
    fromTarget: boolean;
  };
}

export interface CanvasNodeDefinition<TData extends CanvasNodeData = CanvasNodeData> {
  type: CanvasNodeType;
  menuLabelKey: string;
  menuIcon: MenuIconKey;
  visibleInMenu: boolean;
  capabilities: CanvasNodeCapabilities;
  connectivity: CanvasNodeConnectivity;
  createDefaultData: () => TData;
}

const uploadNodeDefinition: CanvasNodeDefinition<UploadImageNodeData> = {
  type: CANVAS_NODE_TYPES.upload,
  menuLabelKey: 'node.menu.uploadImage',
  menuIcon: 'upload',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    connectMenu: {
      fromSource: false,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.upload],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: '1:1',
    isSizeManuallyAdjusted: false,
    sourceFileName: null,
  }),
};

const imageEditNodeDefinition: CanvasNodeDefinition<ImageEditNodeData> = {
  type: CANVAS_NODE_TYPES.imageEdit,
  menuLabelKey: 'node.menu.aiImageGeneration',
  menuIcon: 'sparkles',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.imageEdit],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isSizeManuallyAdjusted: false,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    prompt: '',
    model: DEFAULT_IMAGE_MODEL_ID,
    size: '2K' as ImageSize,
    extraParams: {},
    generationMode: 'text_to_image',
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const imageGenNodeDefinition: CanvasNodeDefinition<ImageGenNodeData> = {
  type: CANVAS_NODE_TYPES.imageGen,
  menuLabelKey: 'node.menu.image',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.imageGen],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: '16:9',
    isSizeManuallyAdjusted: false,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    prompt: '',
    model: DEFAULT_SHARED_MODEL_ID,
    size: '2K' as ImageSize,
    count: 1,
    styleTemplateId: null,
    focusRegion: null,
    cameraSelection: null,
    referenceImageUrl: null,
    marks: [],
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const exportImageNodeDefinition: CanvasNodeDefinition<ExportImageNodeData> = {
  type: CANVAS_NODE_TYPES.exportImage,
  menuLabelKey: 'node.menu.uploadImage',
  menuIcon: 'upload',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.exportImage],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isSizeManuallyAdjusted: false,
    resultKind: 'generic',
  }),
};

const beatContextNodeDefinition: CanvasNodeDefinition<BeatContextNodeData> = {
  type: CANVAS_NODE_TYPES.beatContext,
  menuLabelKey: 'node.menu.beatContext',
  menuIcon: 'text',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.beatContext],
    content: '',
    context_scope: 'standalone',
    beat_context: {
      schema: 'beat_context.v1',
      source: 'standalone',
      // 写进节点 data 的规范标题，界面上显示的那一份由 standaloneTitle 词条给。
      title: '自定义镜头上下文', // i18n-exempt —— 规范值
      visual_description: '',
      narration_segment: '',
      scene_id: '',
      time_of_day: '',
      detected_identities: [],
      detected_props: [],
      sketch_colors: {},
      prop_marker_colors: {},
    },
    snapshot: {
      visualDescription: '',
      narrationSegment: '',
      sceneId: '',
      timeOfDay: '',
      detectedIdentities: [],
      detectedProps: [],
      sketchColors: {},
      propMarkerColors: {},
    },
    syncStatus: 'fresh',
  }),
};

const groupNodeDefinition: CanvasNodeDefinition<GroupNodeData> = {
  type: CANVAS_NODE_TYPES.group,
  menuLabelKey: 'node.menu.storyboard',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: false,
    targetHandle: false,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.group],
    // 与 displayName 同为写进画布 JSON 的规范默认值，标题显示走 headerTitle
    label: '组', // i18n-exempt
  }),
};

const textAnnotationNodeDefinition: CanvasNodeDefinition<TextAnnotationNodeData> = {
  type: CANVAS_NODE_TYPES.textAnnotation,
  menuLabelKey: 'node.menu.textAnnotation',
  menuIcon: 'text',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.textAnnotation],
    content: '',
    model: DEFAULT_SHARED_MODEL_ID,
    extraParams: {},
    isGenerating: false,
  }),
};

const storyboardSplitDefinition: CanvasNodeDefinition<StoryboardSplitNodeData> = {
  type: CANVAS_NODE_TYPES.storyboardSplit,
  menuLabelKey: 'node.menu.storyboard',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.storyboardSplit],
    aspectRatio: DEFAULT_ASPECT_RATIO,
    frameAspectRatio: DEFAULT_ASPECT_RATIO,
    gridRows: 2,
    gridCols: 2,
    frames: [],
    exportOptions: {
      showFrameIndex: false,
      showFrameNote: false,
      notePlacement: 'overlay',
      imageFit: 'cover',
      frameIndexPrefix: 'S',
      cellGap: 8,
      outerPadding: 0,
      fontSize: 4,
      backgroundColor: '#0f1115',
      textColor: '#f8fafc',
    },
  }),
};

const storyboardGenNodeDefinition: CanvasNodeDefinition<StoryboardGenNodeData> = {
  type: CANVAS_NODE_TYPES.storyboardGen,
  menuLabelKey: 'node.menu.storyboardGen',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.storyboardGen],
    gridRows: 2,
    gridCols: 2,
    frames: [],
    ratioControlMode: 'cell',
    model: DEFAULT_IMAGE_MODEL_ID,
    size: '2K' as ImageSize,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    extraParams: {},
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const videoNodeDefinition: CanvasNodeDefinition<VideoNodeData> = {
  type: CANVAS_NODE_TYPES.video,
  menuLabelKey: 'node.menu.video',
  menuIcon: 'video',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.video],
    videoUrl: null,
    previewImageUrl: null,
    aspectRatio: '16:9',
    isSizeManuallyAdjusted: false,
    sourceFileName: null,
    widthPx: null,
    heightPx: null,
    durationMs: null,
    isUploading: false,
    isAnalyzing: false,
    analysisResult: null,
    analysisError: null,
    // generation panel defaults
    prompt: '',
    genMode: 'textToVideo',
    // 继承用户上次为视频节点选的模型；无记录时回落到默认模型。
    model: readLastVideoModel() ?? DEFAULT_VIDEO_MODEL_ID,
    quality: '720P',
    durationSec: 5,
    count: 1,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const audioNodeDefinition: CanvasNodeDefinition<AudioNodeData> = {
  type: CANVAS_NODE_TYPES.audio,
  menuLabelKey: 'node.menu.audio',
  menuIcon: 'audio',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.audio],
    audioUrl: null,
    sourceFileName: null,
    durationMs: null,
    isUploading: false,
    text: '',
    emotionPrompt: '',
    // 默认音色：留空。AudioOperationsPanel 挂载时会拉一次音色库
    // references 并落到第一个；这里硬编码 project_narrator 会让初始化
    // effect 提前 bail，导致用户始终看到"项目解说人"无法替换。
    voiceLanguage: '',
    isGenerating: false,
    generationStartedAt: null,
  }),
};

const videoStoryNodeDefinition: CanvasNodeDefinition<VideoStoryNodeData> = {
  type: CANVAS_NODE_TYPES.videoStory,
  menuLabelKey: 'node.menu.videoStory',
  menuIcon: 'video',
  // Only ever spawned programmatically (after video-analyze success), never
  // through the double-click or "+" menus.
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: false,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.videoStory],
    sourceVideoUrl: null,
    rows: [],
    rawResult: null,
    isAnalyzing: false,
    analysisError: null,
  }),
};

const videoComposeNodeDefinition: CanvasNodeDefinition<VideoComposeNodeData> = {
  type: CANVAS_NODE_TYPES.videoCompose,
  menuLabelKey: 'node.menu.videoCompose',
  menuIcon: 'videoCompose',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    // 接收 ≥2 个上游视频（可选音频）节点；合成结果可继续向下游输出。
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.videoCompose],
    resultVideoUrl: null,
    previewImageUrl: null,
    resolution: '1080p',
  }),
};

// 写死的脚本生成模型 id（脚本生成接口暂未提供 list）。和 ScriptNode 内的
// SCRIPT_MODELS 保持同步，仅供 createDefaultData 选默认。
const DEFAULT_SCRIPT_MODEL_ID = 'gvlm-3.1';

const scriptNodeDefinition: CanvasNodeDefinition<ScriptNodeData> = {
  type: CANVAS_NODE_TYPES.script,
  menuLabelKey: 'node.menu.script',
  menuIcon: 'script',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.script],
    prompt: '',
    model: DEFAULT_SCRIPT_MODEL_ID,
    lastAction: null,
    scriptResult: null,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const pano360ViewerNodeDefinition: CanvasNodeDefinition<Pano360ViewerNodeData> = {
  type: CANVAS_NODE_TYPES.pano360Viewer,
  menuLabelKey: 'node.menu.pano360Viewer',
  menuIcon: 'pano360',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    // 全景查看器既接收上游贴图，也能向下游输出截图节点（截当前 / 2×2 / 4×3），
    // 所以两端都要有 handle——否则截图连线在画布重新水合时会被过滤掉。
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.pano360Viewer],
    imageUrl: null,
    previewImageUrl: null,
    sourceNodeId: null,
    sphereCorrectionDeg: { roll: 0, pitch: 0, yaw: 0 },
    frontYawDeg: 0,
    fovDeg: 70,
    lastExportedEntry: null,
  }),
};

const threeDWorldNodeDefinition: CanvasNodeDefinition<ThreeDWorldNodeData> = {
  type: CANVAS_NODE_TYPES.threeDWorld,
  menuLabelKey: 'node.menu.threeDWorld',
  menuIcon: 'threeDWorld',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.threeDWorld],
    prompt: '',
    model: 'marble-1.1',
    taskKey: null,
    plyUrl: null,
    sourceNodeId: null,
    sourceKind: null,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 90000,
    errorMessage: null,
  }),
};

const previzNodeDefinition: CanvasNodeDefinition<PrevizNodeData> = {
  type: CANVAS_NODE_TYPES.previz,
  menuLabelKey: 'node.menu.previz',
  menuIcon: 'previz',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.previz],
    scene: null,
    summary: null,
    previewImageUrl: null,
  }),
};

const skillNodeDefinition: CanvasNodeDefinition<SkillNodeData> = {
  type: CANVAS_NODE_TYPES.skill,
  menuLabelKey: 'node.menu.skill',
  menuIcon: 'sparkles',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.skill],
    skill_id: '',
    skill_schema_version: SKILL_SCHEMA_VERSION,
  }),
};

// 风格节点由图片节点的对账逻辑建/删（见 styleNodeSync），不进创建菜单、也不进
// 连线菜单 —— 用户手工拖出来的一个空风格节点没有归属的图片节点，谁也不消费。
const styleNodeDefinition: CanvasNodeDefinition<StyleNodeData> = {
  type: CANVAS_NODE_TYPES.style,
  menuLabelKey: 'node.menu.style',
  menuIcon: 'sparkles',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  // 不落 displayName：标题默认由节点自己按「风格 · 分类 · 风格名」算，写死了就再也
  // 跟不上换风格。用户手工改名后才会有 displayName，那时以用户的为准。
  createDefaultData: () => ({
    styleTemplateId: null,
  }),
};

export const canvasNodeDefinitions: Record<CanvasNodeType, CanvasNodeDefinition> = {
  [CANVAS_NODE_TYPES.upload]: uploadNodeDefinition,
  [CANVAS_NODE_TYPES.imageEdit]: imageEditNodeDefinition,
  [CANVAS_NODE_TYPES.imageGen]: imageGenNodeDefinition,
  [CANVAS_NODE_TYPES.exportImage]: exportImageNodeDefinition,
  [CANVAS_NODE_TYPES.beatContext]: beatContextNodeDefinition,
  [CANVAS_NODE_TYPES.textAnnotation]: textAnnotationNodeDefinition,
  [CANVAS_NODE_TYPES.group]: groupNodeDefinition,
  [CANVAS_NODE_TYPES.storyboardSplit]: storyboardSplitDefinition,
  [CANVAS_NODE_TYPES.storyboardGen]: storyboardGenNodeDefinition,
  [CANVAS_NODE_TYPES.video]: videoNodeDefinition,
  [CANVAS_NODE_TYPES.audio]: audioNodeDefinition,
  [CANVAS_NODE_TYPES.videoStory]: videoStoryNodeDefinition,
  [CANVAS_NODE_TYPES.videoCompose]: videoComposeNodeDefinition,
  [CANVAS_NODE_TYPES.script]: scriptNodeDefinition,
  [CANVAS_NODE_TYPES.pano360Viewer]: pano360ViewerNodeDefinition,
  [CANVAS_NODE_TYPES.threeDWorld]: threeDWorldNodeDefinition,
  [CANVAS_NODE_TYPES.previz]: previzNodeDefinition,
  [CANVAS_NODE_TYPES.skill]: skillNodeDefinition,
  [CANVAS_NODE_TYPES.style]: styleNodeDefinition,
};

export function getNodeDefinition(type: CanvasNodeType): CanvasNodeDefinition {
  return canvasNodeDefinitions[type];
}

export function getMenuNodeDefinitions(): CanvasNodeDefinition[] {
  return Object.values(canvasNodeDefinitions).filter((definition) => definition.visibleInMenu);
}

export function nodeHasSourceHandle(type: CanvasNodeType): boolean {
  return canvasNodeDefinitions[type].connectivity.sourceHandle;
}

export function nodeHasTargetHandle(type: CanvasNodeType): boolean {
  return canvasNodeDefinitions[type].connectivity.targetHandle;
}

// 「目标节点类型」→ 允许的上游（源）节点类型白名单。这张表和下面的
// DOWNSTREAM_TARGET_WHITELIST 一起，是建边规则的单一事实来源：UI 层（连线菜单 /
// 手动拖线 / isValidConnection）与 store 建边收口（onConnect / addEdge /
// addEdgeWithData / 加载规范化）都经由 isUpstreamConnectionAllowed 查它们，避免
// 任何一条建边路径绕过规则。不在表中的目标类型表示「不额外限制类型」，仅受
// handle 级默认规则约束。
const UPSTREAM_SOURCE_WHITELIST: Partial<Record<CanvasNodeType, readonly CanvasNodeType[]>> = {
  // 音频节点的上游只能是文本节点（生成来源），外加视频节点 —— 后者是「人声/背景音
  // 分离」动作留下的溯源边：那个动作从一个视频节点同时产出「背景音」音频节点和
  // 「无声」视频节点，两条边一起画回源视频。少了 video 这一项，音频那条边会被建边
  // 收口静默丢掉，画布上一边连着无声视频、一边孤零零挂着背景音。
  [CANVAS_NODE_TYPES.audio]: [CANVAS_NODE_TYPES.textAnnotation, CANVAS_NODE_TYPES.video],
};

// 「源节点类型」→ 允许的下游（目标）节点类型白名单。与上面那张表对称：那张按
// 目标收口（谁能连进我），这张按源收口（我能连去谁）。两张表一起构成建边规则，
// 同样被所有建边路径查询。不在表中的源类型表示「不额外限制下游类型」。
//
// 音频是目前唯一需要按源收口的类型：只有视频节点（声轨素材）和视频合成（音频轨）
// 会读上游音频，连到图片 / 脚本 / 3D 等节点上不产生任何效果，只是画布上一根骗人
// 的线。这条规则本来就写在别处了 —— getDownstreamSpawnTypes(audio) 只给
// [video, videoCompose]，Canvas.resolveAllowedNodeTypes 里图片节点的上游菜单也
// 明写「不收音频」—— 但那两处只管菜单能创建什么，拖线落到一个**既有**节点上时
// 谁都没拦。放进这里才真正收口。
const DOWNSTREAM_TARGET_WHITELIST: Partial<Record<CanvasNodeType, readonly CanvasNodeType[]>> = {
  [CANVAS_NODE_TYPES.audio]: [CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.videoCompose],
  // 风格节点只是图片节点 styleTemplateId 的投影，连到别处不产生任何效果。
  [CANVAS_NODE_TYPES.style]: [CANVAS_NODE_TYPES.imageGen],
};

// 返回某目标类型允许的上游源类型；返回 null 表示该类型不施加额外类型限制。
export function getAllowedUpstreamSourceTypes(
  targetType: CanvasNodeType,
): readonly CanvasNodeType[] | null {
  return UPSTREAM_SOURCE_WHITELIST[targetType] ?? null;
}

// 返回某源类型允许的下游目标类型；返回 null 表示该类型不施加额外类型限制。
export function getAllowedDownstreamTargetTypes(
  sourceType: CanvasNodeType,
): readonly CanvasNodeType[] | null {
  return DOWNSTREAM_TARGET_WHITELIST[sourceType] ?? null;
}

// 判断从 sourceType 连向 targetType 的连接是否合法：两张白名单都要过。
export function isUpstreamConnectionAllowed(
  sourceType: CanvasNodeType,
  targetType: CanvasNodeType,
): boolean {
  const allowedSources = UPSTREAM_SOURCE_WHITELIST[targetType];
  if (allowedSources && !allowedSources.includes(sourceType)) {
    return false;
  }
  const allowedTargets = DOWNSTREAM_TARGET_WHITELIST[sourceType];
  if (allowedTargets && !allowedTargets.includes(targetType)) {
    return false;
  }
  return true;
}

// 只由系统动作建立、**不开放给用户手工创建**的边。上面两张表必须放行它们（否则
// 加载规范化会把存量边丢掉），但连线菜单和手动拖线不该提供 —— 用户自己画一根出来
// 没有任何消费方，又是一根骗人的线。
const SYSTEM_ONLY_CONNECTIONS: readonly (readonly [CanvasNodeType, CanvasNodeType])[] = [
  // 「人声/背景音分离」把产出的「背景音」音频节点画回源视频，是条溯源边。音频节点
  // 自己只读文本上游（AudioOperationsPanel 只取 text），手工连一根视频进来什么都
  // 不会发生。
  [CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio],
  // 风格节点与图片节点是一对一的：那根边由对账逻辑跟着 styleTemplateId 建。
  // 放开手工拖线的话，一个风格节点能挂到第二个图片节点上，两边的对账各自认为
  // 「节点承载的风格和我不一致」，会把它来回改写成对方的风格，永远收敛不了。
  [CANVAS_NODE_TYPES.style, CANVAS_NODE_TYPES.imageGen],
];

// 判断用户能不能**手工**建立这条边：建边规则放行，且不是系统专用边。菜单候选与
// 手动拖线查这条；store 的建边收口查的仍是 isUpstreamConnectionAllowed。
export function isManualConnectionAllowed(
  sourceType: CanvasNodeType,
  targetType: CanvasNodeType,
): boolean {
  if (!isUpstreamConnectionAllowed(sourceType, targetType)) {
    return false;
  }
  return !SYSTEM_ONLY_CONNECTIONS.some(
    ([source, target]) => source === sourceType && target === targetType,
  );
}

export function getConnectMenuNodeTypes(handleType: 'source' | 'target'): CanvasNodeType[] {
  const fromSource = handleType === 'source';
  return Object.values(canvasNodeDefinitions)
    .filter((definition) => (fromSource
      ? definition.connectivity.connectMenu.fromSource
      : definition.connectivity.connectMenu.fromTarget))
    .filter((definition) => (fromSource
      ? definition.connectivity.targetHandle
      : definition.connectivity.sourceHandle))
    .map((definition) => definition.type);
}

// 图片类节点（upload / imageEdit / imageGen / exportImage）共用的下游候选。
const IMAGE_DOWNSTREAM_SPAWN_TYPES: readonly CanvasNodeType[] = [
  CANVAS_NODE_TYPES.textAnnotation,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.script,
  CANVAS_NODE_TYPES.pano360Viewer,
  CANVAS_NODE_TYPES.threeDWorld,
];

// 「从右侧 source handle 出发能创建哪些下游节点」的产品白名单。这是 + 菜单
// （NodeSpawnPlusOverlay）和拖线落空菜单（Canvas.handleConnectEnd）共用的那一份。
// 不在表中的源类型回落到注册表的 connectMenu.fromSource 默认列表。
//
// 这里写的是**产品意图**，不代表边一定建得起来 —— 建边规则（上面两张表 +
// SYSTEM_ONLY_CONNECTIONS）才是最终裁决，取用时会再过一道。两者若打架，测试
// 「菜单白名单不与建边规则冲突」会红。
export const DOWNSTREAM_SPAWN_WHITELIST: Partial<
  Record<CanvasNodeType, readonly CanvasNodeType[]>
> = {
  // 视频：仅允许 文本 / 视频 / 视频合成 / 脚本 —— 图片、音频、多版本不该作为下游。
  [CANVAS_NODE_TYPES.video]: [
    CANVAS_NODE_TYPES.textAnnotation,
    CANVAS_NODE_TYPES.video,
    CANVAS_NODE_TYPES.videoCompose,
    CANVAS_NODE_TYPES.script,
  ],
  // 音频：下游只有视频（声轨素材）与视频合成（音频轨）读得懂。
  [CANVAS_NODE_TYPES.audio]: [CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.videoCompose],
  // 360° 全景查看器：截图都是图片，下游只接图片类节点。
  [CANVAS_NODE_TYPES.pano360Viewer]: [
    CANVAS_NODE_TYPES.imageGen,
    CANVAS_NODE_TYPES.imageEdit,
    CANVAS_NODE_TYPES.exportImage,
    CANVAS_NODE_TYPES.upload,
  ],
  // 预演台：产物是截图与录制，下游只接图片与视频类节点。
  [CANVAS_NODE_TYPES.previz]: [
    CANVAS_NODE_TYPES.imageGen,
    CANVAS_NODE_TYPES.imageEdit,
    CANVAS_NODE_TYPES.exportImage,
    CANVAS_NODE_TYPES.upload,
    CANVAS_NODE_TYPES.video,
  ],
  [CANVAS_NODE_TYPES.upload]: IMAGE_DOWNSTREAM_SPAWN_TYPES,
  [CANVAS_NODE_TYPES.imageEdit]: IMAGE_DOWNSTREAM_SPAWN_TYPES,
  [CANVAS_NODE_TYPES.imageGen]: IMAGE_DOWNSTREAM_SPAWN_TYPES,
  [CANVAS_NODE_TYPES.exportImage]: IMAGE_DOWNSTREAM_SPAWN_TYPES,
};

// 给定起源节点类型，返回「从右侧 source handle 出发能创建的下游节点类型集」。
export function getDownstreamSpawnTypes(
  originType: CanvasNodeType | undefined,
): CanvasNodeType[] {
  const base = getConnectMenuNodeTypes('source');
  if (!originType) return base;
  // 再过一遍手工建边规则：菜单里出现的候选必须真的连得上。否则用户点了以后新节点
  // 建出来了、边被建边收口拒掉，画布上留下一个孤立节点（如脚本 → 音频）。
  const connectable = base.filter((type) => isManualConnectionAllowed(originType, type));
  const allowed = DOWNSTREAM_SPAWN_WHITELIST[originType];
  return allowed ? connectable.filter((type) => allowed.includes(type)) : connectable;
}

// 「从左侧 target handle 出发能创建哪些上游节点」的产品白名单 —— 上面那张表的
// 镜像。同样只是产品意图，取用时仍要过手工建边规则。
export const UPSTREAM_SPAWN_WHITELIST: Partial<
  Record<CanvasNodeType, readonly CanvasNodeType[]>
> = {
  // 3D 世界：上游仅允许文本 / 图片节点（Phase 1）。
  [CANVAS_NODE_TYPES.threeDWorld]: [
    CANVAS_NODE_TYPES.textAnnotation,
    CANVAS_NODE_TYPES.imageGen,
  ],
  // 图片节点：上游仅允许 文本（textAnnotation / script）+ 图片（upload），
  // 不收音频 / 视频 / 3D 世界。
  [CANVAS_NODE_TYPES.imageGen]: [
    CANVAS_NODE_TYPES.textAnnotation,
    CANVAS_NODE_TYPES.script,
    CANVAS_NODE_TYPES.upload,
  ],
  // 视频节点：上游仅允许 文本 / 图片 / 音频，跟 NodeSpawnPlusOverlay 左侧「+」
  // 按钮的白名单保持一致。
  [CANVAS_NODE_TYPES.video]: [
    CANVAS_NODE_TYPES.textAnnotation,
    CANVAS_NODE_TYPES.imageGen,
    CANVAS_NODE_TYPES.audio,
  ],
  // 预演台：P0 不读任何上游，场景全部在编辑器里手工搭建。缺条目会回落到 connectMenu
  // 默认列表（skill / threeDWorld / 以及预演台自己），全是「骗人的线」。空数组让
  // Canvas.tsx 的 `allowedTypes.length === 0` 分支直接不弹菜单——左侧「+」用的是
  // NodeSpawnPlusOverlay 自己那份视频专用列表，不会因此出现空面板。
  [CANVAS_NODE_TYPES.previz]: [],
};

// 给定目标节点类型，返回「从左侧 target handle 出发能创建的上游节点类型集」。
//
// 与下游那侧不同，这里多数分支**不沿用 base**：base 只收 connectMenu.fromTarget
// 为 true 的类型，而 textAnnotation / imageGen 的 fromTarget 是 false，沿用就会
// 被错杀。所以白名单在这里是「重写候选集」而不是「过滤候选集」。
export function getUpstreamSpawnTypes(
  originType: CanvasNodeType | undefined,
): CanvasNodeType[] {
  const base = getConnectMenuNodeTypes('target');
  if (!originType) return base;
  // 所有分支最后都过一道手工建边规则：菜单给的候选必须是用户真能连的。少了这道，
  // 音频节点的上游菜单会冒出「视频」——那是「人声/背景音分离」的溯源边，音频节点
  // 只读文本上游，用户手工连一根视频进来什么都不会发生。
  const manual = (types: readonly CanvasNodeType[]) =>
    types.filter((type) => isManualConnectionAllowed(type, originType));

  // 3D 世界是唯一与 base 取交集的分支（历史行为，未在本次改动中调整）。
  if (originType === CANVAS_NODE_TYPES.threeDWorld) {
    const allowed = UPSTREAM_SPAWN_WHITELIST[originType] ?? [];
    return manual(base.filter((type) => allowed.includes(type)));
  }

  const declared = UPSTREAM_SPAWN_WHITELIST[originType];
  if (declared) {
    return manual(declared);
  }

  // 受上游类型白名单约束的目标（如音频←文本）：直接用领域层白名单，保证连线菜单、
  // 手动拖线、isValidConnection、store 建边收口共用同一份规则。
  const allowedUpstream = getAllowedUpstreamSourceTypes(originType);
  if (allowedUpstream) {
    return manual(allowedUpstream);
  }

  return manual(base);
}
