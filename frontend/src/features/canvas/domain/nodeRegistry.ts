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
  type ScriptNodeData,
  type SkillNodeData,
  type StoryboardSplitNodeData,
  type StoryboardGenNodeData,
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

export type MenuIconKey = 'upload' | 'sparkles' | 'layout' | 'text' | 'video' | 'audio' | 'script' | 'pano360' | 'threeDWorld' | 'videoCompose';

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
      title: '自定义镜头上下文',
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
    label: '组',
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
    generateAudio: true,
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
  [CANVAS_NODE_TYPES.skill]: skillNodeDefinition,
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

// 「目标节点类型」→ 允许的上游（源）节点类型白名单。这是建边规则的单一事实
// 来源：UI 层（连线菜单 / 手动拖线 / isValidConnection）与 store 建边收口
// （onConnect / addEdge / addEdgeWithData / 加载规范化）都查这张表，避免任何
// 一条建边路径绕过规则。不在表中的目标类型表示「不额外限制类型」，仅受 handle
// 级默认规则约束。
const UPSTREAM_SOURCE_WHITELIST: Partial<Record<CanvasNodeType, readonly CanvasNodeType[]>> = {
  // 音频节点的上游只能是文本节点。
  [CANVAS_NODE_TYPES.audio]: [CANVAS_NODE_TYPES.textAnnotation],
};

// 返回某目标类型允许的上游源类型；返回 null 表示该类型不施加额外类型限制。
export function getAllowedUpstreamSourceTypes(
  targetType: CanvasNodeType,
): readonly CanvasNodeType[] | null {
  return UPSTREAM_SOURCE_WHITELIST[targetType] ?? null;
}

// 判断从 sourceType 连向 targetType 的上游连接是否合法。
export function isUpstreamConnectionAllowed(
  sourceType: CanvasNodeType,
  targetType: CanvasNodeType,
): boolean {
  const allowed = UPSTREAM_SOURCE_WHITELIST[targetType];
  return allowed ? allowed.includes(sourceType) : true;
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

// 给定起源节点类型，返回「从右侧 source handle 出发能创建的下游节点类型集」。
// 这是 + 菜单（NodeSpawnPlusOverlay）和拖线落空菜单（Canvas.handleConnectEnd）
// 共用的产品级白名单，必须保持单一事实来源。
//
// - 视频：仅允许 文本 / 视频 / 脚本 —— 图片/音频/多版本不该作为视频下游。
// - 图片类（upload/imageEdit/imageGen/exportImage）：允许 文本 / 图片 / 视频 /
//   脚本 / 360° / 3D 世界，排除 多版本 与 音频。
// - 其他：回落到注册表中 connectMenu.fromSource 默认列表。
export function getDownstreamSpawnTypes(
  originType: CanvasNodeType | undefined,
): CanvasNodeType[] {
  const base = getConnectMenuNodeTypes('source');
  if (!originType) return base;

  if (originType === CANVAS_NODE_TYPES.video) {
    const allowed = new Set<CanvasNodeType>([
      CANVAS_NODE_TYPES.textAnnotation,
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.videoCompose,
      CANVAS_NODE_TYPES.script,
    ]);
    return base.filter((type) => allowed.has(type));
  }

  // 音频节点：下游允许视频（作为声轨素材）与视频合成（音频轨）。
  if (originType === CANVAS_NODE_TYPES.audio) {
    const allowed = new Set<CanvasNodeType>([
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.videoCompose,
    ]);
    return base.filter((type) => allowed.has(type));
  }

  // 360° 全景查看器：下游只能是图片节点（截图都是图片，手动连线也只接图片）。
  if (originType === CANVAS_NODE_TYPES.pano360Viewer) {
    const allowed = new Set<CanvasNodeType>([
      CANVAS_NODE_TYPES.imageGen,
      CANVAS_NODE_TYPES.imageEdit,
      CANVAS_NODE_TYPES.exportImage,
      CANVAS_NODE_TYPES.upload,
    ]);
    return base.filter((type) => allowed.has(type));
  }

  if (
    originType === CANVAS_NODE_TYPES.upload ||
    originType === CANVAS_NODE_TYPES.imageEdit ||
    originType === CANVAS_NODE_TYPES.imageGen ||
    originType === CANVAS_NODE_TYPES.exportImage
  ) {
    const allowed = new Set<CanvasNodeType>([
      CANVAS_NODE_TYPES.textAnnotation,
      CANVAS_NODE_TYPES.imageGen,
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.script,
      CANVAS_NODE_TYPES.pano360Viewer,
      CANVAS_NODE_TYPES.threeDWorld,
    ]);
    return base.filter((type) => allowed.has(type));
  }

  return base;
}
