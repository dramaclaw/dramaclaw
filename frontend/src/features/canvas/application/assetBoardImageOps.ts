// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneScene360,
  submitFreezoneTemplateEdit,
  DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO,
  FREEZONE_SCENE_360_ASPECT_RATIOS,
  type FreezoneJobRef,
  type FreezoneScene360AspectRatio,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
} from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { GRID_ACTION_MODE_MAP, type GridActionKey } from './gridTemplateAction';
import { generationTaskDescriptor } from './resumeGeneration';

/**
 * 一图流「功能」key。= 11 项能力：10 个宫格模板（复用
 * {@link GRID_ACTION_MODE_MAP}）+ 全景。
 *
 * 交互形态两个视图现在完全一致：点功能 → 先建一个空的图片生成节点（节点名=功能名）
 * → 在它的输入框里改提示词/参考图/比例、或换成别的功能 → 按 ↑ 才真正提交。
 * 工作流侧原来那条「确认即提交」的浮条（GridActionConfirmOverlay）已按用户要求撤掉。
 *
 * 多角度 / 打光**不在这张表里**（用户要求撤下）：它们的价值在环绕角・俯仰角・
 * 景别 / 亮度・色温・主光方向那几组滑杆上，退化成「一句提示词点生成」并不好用；
 * 详情工具条上的那两个完整编辑器仍在，走的是工作流那条「确认即提交」。
 */
export type AssetBoardImageOpKey = GridActionKey | 'scene360';

/** 功能框的分组（对标 liblib 的四栏：分镜叙事 / 空间与机位 / 设定图 / 质感调节）。 */
export type AssetBoardImageOpCategoryKey = 'narrative' | 'space' | 'setting' | 'texture';

export interface AssetBoardImageOpDef {
  key: AssetBoardImageOpKey;
  /** 功能名。同时作为新节点的 displayName，以及提示词为空时下发的 prompt。 */
  label: string;
  /** 功能框里跟在功能名下面的一行短说明（一句话说清这个功能产出什么）。 */
  summary: string;
  /** 选中该功能后，输入框的占位文案（对标 liblib「点击生成，直接基于当前图像生成…」）。 */
  description: string;
  category: AssetBoardImageOpCategoryKey;
  /** 询价用的硬编码兜底算力（活价没回来时展示，与工具条同源）。 */
  cost: number;
}

export const ASSET_BOARD_IMAGE_OP_CATEGORY_LABELS: Record<
  AssetBoardImageOpCategoryKey,
  string
> = {
  narrative: '分镜叙事',
  space: '空间与机位',
  setting: '设定图',
  texture: '质感调节',
};

/**
 * 功能清单。label 与工具条 `GRID_ACTION_DEFS` / 全景・多角度・打光按钮同名——
 * 同一个能力在两个视图里必须叫同一个名字。
 */
export const ASSET_BOARD_IMAGE_OPS: readonly AssetBoardImageOpDef[] = [
  {
    key: 'plotFourGrid',
    label: '剧情推演四宫格',
    summary: '一图推演四格剧情',
    description: '点击生成，直接基于当前图像推演出四格剧情；支持通过文本补充剧情走向。',
    category: 'narrative',
    cost: 8,
  },
  {
    key: 'serialStoryboard25',
    label: '25宫格连贯分镜',
    summary: '长段落连贯分镜',
    description: '点击生成，直接基于当前图像生成 25 格连贯分镜；支持通过文本描述段落节奏。',
    category: 'narrative',
    cost: 32,
  },
  {
    key: 'frameProjection3sLater',
    label: '画面推演 - 3秒后',
    summary: '预测 3 秒后的画面',
    description: '点击生成，推演当前画面 3 秒之后的样子；支持通过文本指定运动或事件。',
    category: 'narrative',
    cost: 4,
  },
  {
    key: 'frameProjection5sEarlier',
    label: '画面推演 - 5秒前',
    summary: '反推 5 秒前的画面',
    description: '点击生成，反推当前画面 5 秒之前的样子；支持通过文本指定前情。',
    category: 'narrative',
    cost: 4,
  },
  {
    key: 'multiCameraGrid',
    label: '多机位九宫格',
    summary: '九个机位一次铺开',
    description: '点击生成，直接基于当前图像铺开九个机位；支持通过文本指定镜头语言。',
    category: 'space',
    cost: 14,
  },
  {
    key: 'scene360',
    label: '全景',
    summary: '扩成 360° 全景',
    description: '点击生成，把当前图像扩成 360° 全景；比例固定 2:1 / 21:9。',
    category: 'space',
    cost: 10,
  },
  {
    key: 'characterThreeView',
    label: '角色三视图生成',
    summary: '角色全身三视图',
    description: '点击生成，直接基于当前图像生成完整的角色三视图；支持通过文本/参考图生成。',
    category: 'setting',
    cost: 6,
  },
  {
    key: 'faceThreeView',
    label: '角色脸部三视图',
    summary: '五官细节三视图',
    description: '点击生成，直接基于当前图像生成角色脸部三视图；支持通过文本补充五官特征。',
    category: 'setting',
    cost: 6,
  },
  {
    key: 'productThreeView',
    label: '产品三视图',
    summary: '产品前侧后三视图',
    description: '点击生成，直接基于当前图像生成产品三视图；支持通过文本补充材质与细节。',
    category: 'setting',
    cost: 6,
  },
  {
    key: 'sceneSettingSheet',
    label: '场景设定图',
    summary: '场景美术设定页',
    description: '点击生成，直接基于当前图像生成场景设定图；支持通过文本补充场景背景。',
    category: 'setting',
    cost: 6,
  },
  {
    key: 'cinematicLightCorrection',
    label: '电影级光影校正',
    summary: '光影校正到电影级',
    description: '点击生成，把当前图像的光影校正到电影级；支持通过文本指定影调倾向。',
    category: 'texture',
    cost: 4,
  },
];

export const ASSET_BOARD_IMAGE_OP_MAP: Record<AssetBoardImageOpKey, AssetBoardImageOpDef> =
  Object.fromEntries(ASSET_BOARD_IMAGE_OPS.map((op) => [op.key, op])) as Record<
    AssetBoardImageOpKey,
    AssetBoardImageOpDef
  >;

export function isAssetBoardImageOpKey(value: unknown): value is AssetBoardImageOpKey {
  return typeof value === 'string' && value in ASSET_BOARD_IMAGE_OP_MAP;
}

/**
 * 是不是 9 个宫格模板之一。询价用得上：宫格走 `image_selection`，全景没有对应
 * 的询价口径，宁可不显示也不摆一个文生图的价上去骗人。
 */
export function isGridImageOpKey(key: AssetBoardImageOpKey): key is GridActionKey {
  return key in GRID_ACTION_MODE_MAP;
}

const isGridOpKey = isGridImageOpKey;

function readString(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * 点功能时**先建节点、不提交**：在源节点下游建一个空的 imageGen 节点并连边，
 * 节点名 = 功能名，`imageOpKey` 记住选中的功能、`imageOpSourceUrl` 记住源图。
 * 工作流工具条的「九宫格」下拉与故事板详情工具条都走这里。
 *
 * 建 imageGen（而不是编排用的 exportImage 结果节点）是这条交互的前提：两个视图都
 * 只给 imageGen / video 节点渲生成表单，没有表单就没有输入框，功能 chip 也就无处可挂。
 *
 * @returns 新节点 id；源节点已不存在时返回 null。
 */
export function spawnAssetBoardImageOpNode(
  sourceNodeId: string,
  imageSource: string,
  opKey: AssetBoardImageOpKey,
): string | null {
  const def = ASSET_BOARD_IMAGE_OP_MAP[opKey];
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) {
    return null;
  }

  const sourceAspectRatio =
    readString(node.data as Record<string, unknown>, 'aspectRatio') ?? DEFAULT_ASPECT_RATIO;
  const position = store.findNodePosition(
    node.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );
  const nextNodeId = store.addNode(
    CANVAS_NODE_TYPES.imageGen,
    position,
    {
      displayName: def.label,
      prompt: '',
      imageUrl: null,
      previewImageUrl: null,
      // 全景产物本来就是超宽图，先把节点比例摆对，用户不用自己去调。
      aspectRatio: opKey === 'scene360' ? DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO : sourceAspectRatio,
      imageOpKey: opKey,
      imageOpSourceUrl: imageSource.split('?')[0],
      isGenerating: false,
      generationStartedAt: null,
      generationError: null,
    } as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(node.id, nextNodeId);
  return nextNodeId;
}

/** 在功能框里换功能：改 key + 跟着改节点名（用户没自己改过名时）。 */
export function switchAssetBoardImageOp(nodeId: string, nextKey: AssetBoardImageOpKey): void {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  const data = node.data as Record<string, unknown>;
  const currentKey = data.imageOpKey;
  if (currentKey === nextKey) return;
  const nextDef = ASSET_BOARD_IMAGE_OP_MAP[nextKey];
  // 节点名还是上一个功能名（= 没被用户手改过）才跟着换，否则尊重用户起的名字。
  const currentLabel = isAssetBoardImageOpKey(currentKey)
    ? ASSET_BOARD_IMAGE_OP_MAP[currentKey].label
    : null;
  const displayName = readString(data, 'displayName');
  const patch: Record<string, unknown> = { imageOpKey: nextKey };
  if (!displayName || displayName === currentLabel) {
    patch.displayName = nextDef.label;
  }
  if (nextKey === 'scene360') {
    patch.aspectRatio = DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO;
  }
  store.updateNodeData(nodeId, patch);
}

/** 关掉 chip：退化成一个普通的图片生成节点（↑ 走常规文生图/图生图）。 */
export function clearAssetBoardImageOp(nodeId: string): void {
  useCanvasStore.getState().updateNodeData(nodeId, { imageOpKey: null });
}

function resolveScene360AspectRatio(data: Record<string, unknown>): FreezoneScene360AspectRatio {
  const value = data.aspectRatio;
  return FREEZONE_SCENE_360_ASPECT_RATIOS.includes(value as FreezoneScene360AspectRatio)
    ? (value as FreezoneScene360AspectRatio)
    : DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO;
}

function submitOp(
  project: string,
  opKey: AssetBoardImageOpKey,
  sourceUrl: string,
  prompt: string,
  data: Record<string, unknown>,
): Promise<FreezoneJobRef> {
  if (isGridOpKey(opKey)) {
    return submitFreezoneTemplateEdit(project, {
      sourceUrl,
      mode: GRID_ACTION_MODE_MAP[opKey],
      prompt,
    });
  }
  // 宫格之外只剩全景（多角度/打光已从功能表撤下，见 AssetBoardImageOpKey）。
  // 全景的比例是它自己那套 2:1 / 21:9，不吃通用比例。
  const imageSize = readString(data, 'size') ?? undefined;
  return submitFreezoneScene360(project, {
    referenceUrl: sourceUrl,
    aspectRatio: resolveScene360AspectRatio(data),
    ...(imageSize ? { imageSize } : {}),
  });
}

/**
 * 按 ↑ 时真正提交：**把结果写回节点自己**（不像扩图/高清那几个编排那样再建一个
 * 结果节点）——用户是在这个节点上配的参数，产物就该落在这个节点上。
 *
 * 提交 → 轮询 → 回填 url / 写错，与画布上其它一图流编排同一套语义。
 *
 * @returns settle 时 resolve 的后台链（不 reject）。
 */
export async function runAssetBoardImageOp(nodeId: string): Promise<void> {
  const project = readUrl().project;
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  const data = node.data as Record<string, unknown>;
  const opKey = data.imageOpKey;
  if (!isAssetBoardImageOpKey(opKey)) return;

  const sourceUrl = readString(data, 'imageOpSourceUrl');
  if (!project || !sourceUrl) {
    const message = !project ? '缺少项目上下文，无法提交' : '找不到源图，无法提交';
    console.error('[asset-board-op] cannot submit', { project, sourceUrl });
    store.updateNodeData(nodeId, { generationError: message });
    return;
  }

  const def = ASSET_BOARD_IMAGE_OP_MAP[opKey];
  // 提示词留空就用功能名下发（与工具条「确认即提交」时的行为一致）。
  const prompt = readString(data, 'prompt') ?? def.label;

  store.updateNodeData(nodeId, {
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationError: null,
  });

  try {
    const ref = await submitOp(project, opKey, sourceUrl, prompt, data);
    useCanvasStore.getState().updateNodeData(nodeId, generationTaskDescriptor(ref));
    const completed = await awaitTaskCompletion(ref.task_key, project);
    const directUrl = completed.result?.['output_url'] as string | undefined;
    let url = directUrl;
    if (!url) {
      const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
      url = fallback.url;
    }
    useCanvasStore.getState().updateNodeData(nodeId, {
      imageUrl: url,
      previewImageUrl: url,
      isGenerating: false,
      generationStartedAt: null,
      generationError: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[asset-board-op] generation failed', err);
    useCanvasStore.getState().updateNodeData(nodeId, {
      isGenerating: false,
      generationStartedAt: null,
      generationError: message,
    });
  }
}
