// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  type TextNodeMode,
  type UploadImageNodeData,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

/** 「图片反推提示词」的默认指令（文本节点 instruction 的占位/默认值）。 */
export const IMAGE_TO_PROMPT_DEFAULT_CONTENT =
  '根据图片生成结构化中文提示词，包括主体描述、环境、光影、镜头语言、风格关键词。';

/** 「文字生成音乐」的默认音乐描述——点击后预填进文本节点，用户可在此基础上改。 */
export const TEXT_TO_MUSIC_DEFAULT_CONTENT =
  '生成一首现代品牌电子音乐（约 110 BPM），干净有力的低频贝斯，清晰电子鼓点，整体风格高级、未来感强。开场节奏型贝斯与简洁合成器音色建立律动。主段加入稳定鼓点，节奏清晰，保持克制的张力。强化段加入更丰富的音层，合成器音色提升，律动增强但不过度拥挤。结尾鼓点减弱，仅保留低频与氛围音渐出，干净利落收尾。';

/** 真实存在的文本节点能力（其余值一律回落 writing）。 */
export const TEXT_NODE_REAL_MODES: ReadonlySet<TextNodeMode> = new Set<TextNodeMode>([
  'writing',
  'textToVideo',
  'imageToPrompt',
  'textToMusic',
  'textToMusicGen',
]);

/**
 * 走「紧凑视图」的能力：节点本体只剩预览卡，输入/提交落在下挂的操作面板里。
 * 也是「能力 picker 不再显示」的判据之一——已经选了这两种能力的节点不该再弹 picker。
 */
export const TEXT_NODE_COMPACT_MODES: ReadonlySet<TextNodeMode> = new Set<TextNodeMode>([
  'textToVideo',
  'imageToPrompt',
]);

/** 派生视频节点的落位尺寸（与 TextAnnotationNode.spawnVideoNode 一致）。 */
const SPAWN_VIDEO_LAYOUT_WIDTH = 580;
const SPAWN_VIDEO_LAYOUT_HEIGHT = 680;
/** 派生音频节点的落位尺寸（与 TextAnnotationNode.spawnAudioNode 一致）。 */
const SPAWN_AUDIO_LAYOUT_WIDTH = 480;
const SPAWN_AUDIO_LAYOUT_HEIGHT = 180;
/** 反推提示词的上游上传节点宽度（落在文本节点左侧，与原实现一致）。 */
const SPAWN_UPLOAD_WIDTH = 320;
const SPAWN_UPLOAD_GAP = 60;

/** 解析文本节点当前正文（addNode 的 seedData 要把它带进下游视频节点的 prompt）。 */
function readNodeContent(nodeId: string): string {
  const data = useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data as
    | { content?: unknown }
    | undefined;
  return typeof data?.content === 'string' ? data.content : '';
}

/**
 * 文生视频：在文本节点下游派生一个视频节点并连边（文本 → 视频），种子里带上
 * genMode='textToVideo' 与当前正文作为 prompt。
 *
 * （从 TextAnnotationNode.spawnVideoNode 原样搬出，语义零变化。）
 */
export function spawnTextToVideoNode(nodeId: string): string {
  const store = useCanvasStore.getState();
  const position = store.findNodePosition(
    nodeId,
    SPAWN_VIDEO_LAYOUT_WIDTH,
    SPAWN_VIDEO_LAYOUT_HEIGHT,
  );
  const seedData: Partial<VideoNodeData> = {
    genMode: 'textToVideo',
    prompt: readNodeContent(nodeId),
  };
  const newNodeId = store.addNode(CANVAS_NODE_TYPES.video, position, seedData);
  store.addEdge(nodeId, newNodeId);
  useCanvasStore.getState().autoGroupSpawn(nodeId, [newNodeId], { label: '文生视频组' });
  return newNodeId;
}

/**
 * 图片反推提示词：在文本节点**左侧上游**派生一个仅收图片的上传节点并连边
 * （上传 → 文本）。imageOnly 让标题变「上传图片」、accept=image/*、拒收视频/音频。
 *
 * （从 TextAnnotationNode.spawnUploadNode 原样搬出，语义零变化。）
 */
export function spawnImageToPromptUploadNode(nodeId: string): string {
  const store = useCanvasStore.getState();
  const sourceNode = store.nodes.find((node) => node.id === nodeId);
  const sourceX = sourceNode?.position.x ?? 0;
  const sourceY = sourceNode?.position.y ?? 0;
  const position = {
    x: sourceX - SPAWN_UPLOAD_WIDTH - SPAWN_UPLOAD_GAP,
    y: sourceY,
  };
  const seedData: Partial<UploadImageNodeData> = { imageOnly: true };
  const newNodeId = store.addNode(CANVAS_NODE_TYPES.upload, position, seedData);
  store.addEdge(newNodeId, nodeId);
  useCanvasStore
    .getState()
    .autoGroupSpawn(nodeId, [newNodeId], { label: '图片反推提示词组' });
  return newNodeId;
}

/**
 * 克隆音频 / 文字生成音乐：在文本节点下游派生一个音频节点并连边（文本 → 音频），
 * 与「文生视频」派生视频节点同构。audioKind 决定下游音频节点走语音克隆(speech)
 * 还是文本生成音乐(music)。
 *
 * （从 TextAnnotationNode.spawnAudioNode 原样搬出，语义零变化。）
 */
export function spawnTextNodeAudio(nodeId: string, audioKind: 'speech' | 'music'): string {
  const store = useCanvasStore.getState();
  const position = store.findNodePosition(
    nodeId,
    SPAWN_AUDIO_LAYOUT_WIDTH,
    SPAWN_AUDIO_LAYOUT_HEIGHT,
  );
  const newNodeId = store.addNode(CANVAS_NODE_TYPES.audio, position, { audioKind });
  store.addEdge(nodeId, newNodeId);
  const label = audioKind === 'music' ? '文字生成音乐组' : '克隆音频组';
  useCanvasStore.getState().autoGroupSpawn(nodeId, [newNodeId], { label });
  return newNodeId;
}

export interface ApplyTextNodeModeResult {
  /** 本次派生出的画布节点 id（writing 不派生 → null）。 */
  spawnedNodeId: string | null;
  /**
   * 调用方是否应把文本节点切进编辑态。工作流里对应 enterEditMode()（含 setCenter
   * 缩放），故事板详情里对应展开正文 textarea —— 缩放语义只属于画布，所以留给
   * 调用方决定怎么「进编辑」，本函数只回报「该进」。
   */
  enterEdit: boolean;
}

/**
 * 文本节点能力选择（从 TextAnnotationNode.handlePickMode 原样搬出，语义零变化）：
 *
 * - `writing`：只切 mode，随后进编辑态；
 * - `textToMusicGen`：**先**派生下游音乐音频节点，**再**把本节点切回 writing +
 *   pickerDismissed + 预填默认音乐描述，随后进编辑态（顺序与原实现一致——音乐描述
 *   要在派生之后写，才能同步给刚建出来的下游音频节点）；
 * - `textToVideo` / `imageToPrompt` / `textToMusic`：先切 mode，再派生对应下游/上游节点。
 */
export function applyTextNodeMode(
  nodeId: string,
  mode: TextNodeMode,
): ApplyTextNodeModeResult {
  const updateNodeData = useCanvasStore.getState().updateNodeData;
  if (mode === 'writing') {
    updateNodeData(nodeId, { mode });
    return { spawnedNodeId: null, enterEdit: true };
  }
  if (mode === 'textToMusicGen') {
    const spawnedNodeId = spawnTextNodeAudio(nodeId, 'music');
    // 文本节点回到纯文本编辑态、关闭能力 picker，并预填默认音乐描述(同步给下游音频节点)。
    updateNodeData(nodeId, {
      mode: 'writing',
      pickerDismissed: true,
      content: TEXT_TO_MUSIC_DEFAULT_CONTENT,
    });
    return { spawnedNodeId, enterEdit: true };
  }
  updateNodeData(nodeId, { mode });
  if (mode === 'textToVideo') {
    return { spawnedNodeId: spawnTextToVideoNode(nodeId), enterEdit: false };
  }
  if (mode === 'imageToPrompt') {
    return { spawnedNodeId: spawnImageToPromptUploadNode(nodeId), enterEdit: false };
  }
  if (mode === 'textToMusic') {
    return { spawnedNodeId: spawnTextNodeAudio(nodeId, 'speech'), enterEdit: false };
  }
  return { spawnedNodeId: null, enterEdit: false };
}
