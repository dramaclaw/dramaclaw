// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { XYPosition } from '@xyflow/react';

import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeToolType,
  StoryboardFrameItem,
} from '../domain/canvasNodes';
import type { CanvasNodeDefinition } from '../domain/nodeRegistry';

export interface IdGenerator {
  next: () => string;
}

export interface NodeCatalog {
  getDefinition: (type: CanvasNodeType) => CanvasNodeDefinition;
  getMenuDefinitions: () => CanvasNodeDefinition[];
}

export interface NodeFactory {
  createNode: (
    type: CanvasNodeType,
    position: XYPosition,
    data?: Partial<CanvasNodeData>
  ) => CanvasNode;
}

export interface GraphImageResolver {
  collectInputImages: (nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]) => string[];
}

/**
 * 单条「上游节点内容」记录。所有可能字段都是可选的，调用方按需取用。
 * `text` 来自任何带 prompt / content 的上游节点，`imageUrl` / `videoUrl` /
 * `audioUrl` 来自素材类节点。
 */
export interface UpstreamContent {
  nodeId: string;
  nodeType: CanvasNodeType;
  displayName?: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
}

export interface GraphContentResolver {
  collectInputContents: (
    nodeId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[]
  ) => UpstreamContent[];
}

export interface GenerateImagePayload {
  prompt: string;
  model: string;
  /** 注册表模型 id（还原用），与后端请求模型串区分。 */
  modelId?: string;
  /** 生成模式（还原用）。 */
  generationMode?: string;
  size: string;
  aspectRatio: string;
  referenceImages?: string[];
  extraParams?: Record<string, unknown>;
  capabilityId?: string;
  /** Triggering node id, forwarded so the backend records per-node history. */
  nodeId?: string;
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
}

export interface AiGateway {
  setApiKey: (provider: string, apiKey: string) => Promise<void>;
  generateImage: (payload: GenerateImagePayload) => Promise<string>;
  submitGenerateImageJob: (payload: GenerateImagePayload) => Promise<string>;
  getGenerateImageJob: (jobId: string) => Promise<{
    job_id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found';
    result?: string | null;
    error?: string | null;
  }>;
}

export interface ImageSplitGateway {
  split: (
    imageSource: string,
    rows: number,
    cols: number,
    lineThickness: number
  ) => Promise<string[]>;
}

export interface ToolProcessorResult {
  outputImageUrl?: string;
  storyboardFrames?: StoryboardFrameItem[];
  rows?: number;
  cols?: number;
  frameAspectRatio?: string;
}

export interface ToolProcessor {
  process: (
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ) => Promise<ToolProcessorResult>;
}

export interface CanvasEventMap {
  'tool-dialog/open': {
    nodeId: string;
    toolType: NodeToolType;
  };
  'tool-dialog/close': undefined;
  'upload-node/reupload': {
    nodeId: string;
  };
  'upload-node/paste-image': {
    nodeId: string;
    file: File;
  };
  /**
   * 「上传资源」菜单、画布拖拽、视频节点「外部素材」等外部入口注入 File 给
   * upload 节点。图片/视频/音频都收 —— UploadNode 订阅侧接的是三类分流器
   * handleMediaFile，视频与音频会原地 convertNodeType 变形成 video/audio 节点
   * （不换 id，先连的边不丢）。非媒体文件会被静默丢弃，投递方应自行先过滤。
   *
   * 投递方必须等新节点挂载并订阅后再发：总线无重放，早发的事件直接丢。
   */
  'upload-node/external-file': {
    nodeId: string;
    file: File;
  };
  'video-node/reupload': {
    nodeId: string;
  };
  /** 「上传资源」菜单等外部入口注入 File 给 video 节点（仅视频）。 */
  'video-node/external-file': {
    nodeId: string;
    file: File;
  };
  /** 「上传资源」菜单等外部入口注入 File 给 audio 节点（仅音频）。 */
  'audio-node/external-file': {
    nodeId: string;
    file: File;
  };
  'video-viewer/open': {
    videoUrl: string;
    title?: string;
  };
  /**
   * 节点 toolbar 上的 Commit 按钮触发：把该节点的图写回主流程对应 slot。
   * FreezoneShell 监听后查节点、推 CommitDialog；toolbar 只负责发事件。
   */
  'freezone/commit-node': {
    nodeId: string;
    auto?: boolean;
    successMessage?: string;
  };
  /** 投影 group toolbar 触发：刷新该 projection，不让 toolbar 直接改画布状态。 */
  'freezone/projection-sync': {
    projectionKey: string;
  };
  /** 投影 group toolbar 触发：移除该 projection，不走普通 deleteNode。 */
  'freezone/projection-remove': {
    projectionKey: string;
  };
  /** 主线资产已在节点内部直接写入，通知素材库重拉。 */
  'freezone/assets-updated': undefined;
}

export interface CanvasEventBus {
  publish: <TType extends keyof CanvasEventMap>(
    type: TType,
    payload: CanvasEventMap[TType]
  ) => void;
  subscribe: <TType extends keyof CanvasEventMap>(
    type: TType,
    handler: (payload: CanvasEventMap[TType]) => void
  ) => () => void;
}
