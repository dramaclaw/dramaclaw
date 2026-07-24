// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  ConnectionMode,
  SelectionMode,
  useNodesInitialized,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type HandleType,
  type NodeChange,
  type OnConnectStartParams,
  type Viewport,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { MousePointerClick, Upload } from 'lucide-react';
import '@xyflow/react/dist/style.css';

import { useShallow } from 'zustand/react/shallow';

import { CreditDisplayHiddenProvider } from '@/components/credits/credit-visual';
import { isCeRuntime } from '@/lib/runtime-config';
import { resolveAbsolutePosition, useCanvasStore } from '@/stores/canvasStore';
import { useAppStore } from '@/stores/app-store';
import { getSkillRegistry } from '@/api/skills';
import { SKILL_SCHEMA_VERSION, type SkillDefinition } from '@/features/freezone/context/skillRoles';
import { translateSkillName } from '@/features/freezone/context/skillI18n';
import { canvasAiGateway, canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  CANVAS_NODE_TYPES,
  type BeatContextNodeData,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  DEFAULT_NODE_WIDTH,
  isStoryboardGroupNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  CANVAS_ASSET_DRAG_MIME,
  readAssetDragPayload,
  spawnAssetNode,
  type CanvasAssetDragPayload,
} from '@/features/canvas/domain/assetDrag';
import { hydrateAssetDragPayload } from '@/features/canvas/domain/assetDragHydrate';
import type { CanvasAsset } from '@/features/canvas/domain/canvasAssets';
import { isImmersiveViewerActive } from '@/features/viewer-kit/useViewerImmersiveBody';
import { CanvasMinimapBookmarksOverlay } from '@/features/canvas/ui/CanvasMinimapBookmarksOverlay';
import { captureCurrentViewport, jumpToBookmark } from '@/features/canvas/application/bookmarkActions';
import { digitToBookmarkIndex } from '@/features/canvas/domain/viewportBookmarks';
import {
  isPresetManagedEdge,
  isPresetManagedNode,
} from '@/features/canvas/domain/mainlineNodeFlags';
import { prepareNodeImage } from '@/features/canvas/application/imageData';
import { isSupportedMediaFile } from '@/features/canvas/application/videoFileTypes';
import { uploadLocalImageToBackend } from '@/features/canvas/application/uploadToolOutput';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
  extractRequestId,
} from '@/features/canvas/application/generationErrorReport';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  nodeNeedsGenerationResume,
  resumeNodeGeneration,
} from '@/features/canvas/application/resumeGeneration';
import { readUrl } from '@/lib/url-params';
import { useQueryClient } from '@tanstack/react-query';
import { prefetchEpisodeBeats, prefetchEpisodeDetail } from '@/lib/queries/episodes';
import {
  getConnectMenuNodeTypes,
  getDownstreamSpawnTypes,
  getAllowedUpstreamSourceTypes,
  isUpstreamConnectionAllowed,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import { applySkillRoleBindingConnection } from '@/features/canvas/domain/skillConnectionEdges';
import { embedStoryboardImageMetadata } from '@/commands/image';
import { nodeTypes as canvasNodeTypes } from './nodes';
import { edgeTypes as canvasEdgeTypes } from './edges';
import { NodeSelectionMenu } from './NodeSelectionMenu';
import { SelectedNodeOverlay } from './ui/SelectedNodeOverlay';
import { MultiSelectionToolbar } from './ui/MultiSelectionToolbar';
import {
  MultiSelectionConnectButton,
  type BatchConnectParams,
} from './ui/MultiSelectionConnectButton';
import { NodeSpawnPlusOverlay } from './ui/NodeSpawnPlusOverlay';
import { CanvasContextMenu } from './ui/CanvasContextMenu';
import { NodeToolDialog } from './ui/NodeToolDialog';
import { ImageViewerModal } from './ui/ImageViewerModal';
import { VideoViewerModal } from './ui/VideoViewerModal';
import { CanvasZoomControl } from './ui/CanvasZoomControl';
import { useEdgeVisibilityStore } from './ui/edgeVisibilityStore';
import { CanvasQuickActionBar } from './ui/CanvasQuickActionBar';
import { BackToNodesHint } from './ui/BackToNodesHint';
import { CanvasMinimapButton } from './ui/CanvasMinimapButton';
import { CanvasFpsMeter } from './ui/CanvasFpsMeter';
import { CanvasSnapAlignButton } from './snap-align/CanvasSnapAlignButton';
import { useTrackpadPanStore } from './trackpad-pan/trackpadPanStore';
import { SnapAlignGuides } from './snap-align/SnapAlignGuides';
import { useSnapAlignStore } from './snap-align/snapAlignStore';
import {
  buildSnapAlignIndex,
  computeSnapAlignFromIndex,
  type SnapAlignIndex,
} from './snap-align/computeSnapAlign';
import { computeAutoLayout } from './application/autoLayout';
import { migratePastedNodeAssets } from './application/crossProjectAssets';

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const DEFAULT_EDGE_OPTIONS = { type: 'disconnectableEdge' };
const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };
// 拖线吸附半径(px,以光标到目标 handle 的距离计)。节点的 target handle 在左边
// 缘的一个小点上,而节点本身宽 300~400px;半径太小(默认 20 / 旧值 50)时,把线
// 拖到节点中部就已超出 handle 的吸附范围,既不自动吸附也没有「会连上」的视觉反
// 馈,用户只能去瞄那个小点。调大到能覆盖到节点中部,拖到节点这一大片区域内即可
// 自动吸附连线(React Flow 原生会高亮合法 handle 并把连线吸过去);更远处落到节
// 点本体仍有 handleConnectEnd 里的 DOM 命中兜底。
const CONNECTION_SNAP_RADIUS = 160;
// 手动「+」连线时，光标离目标节点边缘多近（屏幕像素）就算进入其「可落点区域」——
// 不必压到节点里面才触发落点高亮/建边，节点周围一圈邻域内即可吸附。
const MANUAL_DROP_PROXIMITY_PX = 56;
const MULTI_SELECTION_KEY_CODES = ['Control', 'Meta'];
const PAN_ACTIVATION_KEY_CODE = 'Space';
// Pan the canvas only by holding the middle mouse button (scroll-wheel) and dragging
// (button 1). Left drag (0) runs the custom marquee box-select on the empty pane;
// right click (2) opens the canvas context menu.
const PAN_ON_DRAG_BUTTONS = [1];
const NODE_SPAWN_PLUS_HIDE_DELAY_MS = 400;

function resolveCenteredViewport(
  container: HTMLElement | null,
  nodes: CanvasNode[],
  zoom = 1
): Viewport {
  if (!container) {
    return DEFAULT_VIEWPORT;
  }
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return DEFAULT_VIEWPORT;
  }

  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const topLevelNodes = nodes.filter((node) => !node.parentId);
  if (topLevelNodes.length === 0) {
    return {
      x: rect.width / 2,
      y: rect.height / 2,
      zoom: safeZoom,
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of topLevelNodes) {
    const width = node.measured?.width
      ?? (typeof node.width === 'number' ? node.width : DEFAULT_NODE_WIDTH);
    const height = node.measured?.height
      ?? (typeof node.height === 'number' ? node.height : 200);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {
      x: rect.width / 2,
      y: rect.height / 2,
      zoom: safeZoom,
    };
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    x: rect.width / 2 - centerX * safeZoom,
    y: rect.height / 2 - centerY * safeZoom,
    zoom: safeZoom,
  };
}

interface PendingConnectStart {
  nodeId: string;
  handleType: HandleType;
  handleId?: string | null;
  start?: {
    x: number;
    y: number;
  };
}

interface PreviewConnectionVisual {
  d: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'butt' | 'round' | 'square';
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /**
   * 复制时所在的项目 id。粘贴到不同项目时据此触发跨项目资产迁移
   * （把媒体重新上传到目标项目）。null = 复制时不在项目路由下。
   */
  sourceProject: string | null;
}

interface DuplicateOptions {
  explicitOffset?: { x: number; y: number };
  disableOffsetIteration?: boolean;
  suppressSelect?: boolean;
  suppressPersist?: boolean;
  /**
   * Paste from a serialized clipboard snapshot instead of looking the source
   * nodes up by id in the live canvas — lets paste work after the originals are
   * deleted and across canvases.
   */
  sourceSnapshot?: ClipboardSnapshot;
  /** Place the pasted group's top-left at this flow position (cursor paste). */
  targetFlowPosition?: { x: number; y: number };
  /** Select every pasted node (not just the first) — used by paste. */
  selectAll?: boolean;
}

/**
 * Module-level node clipboard so copy/paste survives canvas switches within a
 * session (cross-canvas paste). Holds a deep-cloned, self-contained snapshot —
 * independent of the live nodes, so deleting the originals doesn't break paste.
 */
let sharedNodeClipboard: ClipboardSnapshot | null = null;

interface DuplicateResult {
  firstNodeId: string | null;
  idMap: Map<string, string>;
}

interface MarqueeSelectionState {
  start: { x: number; y: number };
  current: { x: number; y: number };
}

const ALT_DRAG_COPY_Z_INDEX = 2000;
const GENERATION_JOB_POLL_INTERVAL_MS = 1400;
const MARQUEE_SELECTION_MIN_DISTANCE = 6;
// Where the batch-connect "+" spawns its new downstream node relative to the
// selection's bounding box: this far to the right, and lifted by ~half a node so
// the fan-in lands roughly centered on the selection.
const BATCH_CONNECT_SPAWN_GAP = 140;
const BATCH_CONNECT_SPAWN_VERTICAL_OFFSET = 160;
const NODE_PLACEMENT_PREVIEW_WIDTH = 320;
const NODE_PLACEMENT_PREVIEW_HEIGHT = 200;

interface GenerationStoryboardMetadata {
  gridRows: number;
  gridCols: number;
  frameNotes: string[];
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  return {
    width: node.measured?.width ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? styleHeight ?? 200,
  };
}

// 「导演世界」源节点与它的「导演世界输出」组互为一体:拖动任意一方,另一方应按
// 相同位移联动。两者在数据上是各自独立、仅靠连线相连的节点(源节点不是组的子节点),
// 所以 React Flow 不会自动带动。这里从图里推导配对关系——兼容历史画布、无需迁移:
// 组里的 capture 子节点(带 captureMetadata)由源节点连线产出,故
// 「源节点 ←→ 子节点.parentId(组)」即为配对。返回被拖节点应联动的另一方 id。
//
// 仅限「两者都是顶层节点」的场景(原始诉求)。若被拖节点本身在某个组内(有 parentId),
// 一律不联动:否则当源节点和它的 capture 子节点同处一个组时,会把「自己的父组」当成
// partner,拖动→每帧移动父组→父组带动包括自己在内的所有子节点再移一次,双重位移互相
// 打架,表现为卡顿/重合。组内成员的整体性已由 React Flow 的父子关系保证,无需联动。
function findLinkedCapturePartnerIds(
  draggedId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): string[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const dragged = nodeById.get(draggedId);
  if (!dragged || dragged.parentId) {
    return [];
  }

  const isCaptureChild = (node: CanvasNode | undefined): boolean =>
    Boolean(
      node?.parentId &&
        (node.data as { captureMetadata?: unknown } | undefined)?.captureMetadata,
    );

  const partners = new Set<string>();

  // 拖的是组:找出它的 capture 子节点,再回溯连到这些子节点的源节点。
  if (dragged.type === CANVAS_NODE_TYPES.group) {
    const childIds = new Set(
      nodes.filter((node) => node.parentId === draggedId && isCaptureChild(node)).map((node) => node.id),
    );
    if (childIds.size === 0) {
      return [];
    }
    for (const edge of edges) {
      if (!childIds.has(edge.target)) {
        continue;
      }
      const source = nodeById.get(edge.source);
      if (source && !source.parentId && source.id !== draggedId) {
        partners.add(source.id);
      }
    }
    return [...partners];
  }

  // 拖的是源节点:顺着连线找它产出的 capture 子节点,取它们所属的组(顶层组)。
  for (const edge of edges) {
    if (edge.source !== draggedId) {
      continue;
    }
    const target = nodeById.get(edge.target);
    if (!isCaptureChild(target) || !target?.parentId) {
      continue;
    }
    const group = nodeById.get(target.parentId);
    if (group?.type === CANVAS_NODE_TYPES.group && !group.parentId) {
      partners.add(group.id);
    }
  }
  return [...partners];
}

function hasRectCollision(
  candidateRect: { x: number; y: number; width: number; height: number },
  nodes: CanvasNode[],
  ignoreNodeIds: Set<string>
): boolean {
  const margin = 18;
  return nodes.some((node) => {
    if (ignoreNodeIds.has(node.id)) {
      return false;
    }
    const size = getNodeSize(node);
    return (
      candidateRect.x < node.position.x + size.width + margin &&
      candidateRect.x + candidateRect.width + margin > node.position.x &&
      candidateRect.y < node.position.y + size.height + margin &&
      candidateRect.y + candidateRect.height + margin > node.position.y
    );
  });
}

function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function isCanvasPaneTarget(target: EventTarget | null, wrapperElement: HTMLElement): boolean {
  const element = target as HTMLElement | null;
  if (!element || !wrapperElement.contains(element)) {
    return false;
  }
  if (!element.closest('.react-flow__pane')) {
    return false;
  }
  return !element.closest(
    '.react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, .nodrag, .nopan, button, input, textarea, select, [role="button"]'
  );
}

function cloneNodeData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    element.isContentEditable ||
    Boolean(element.closest('[role="textbox"]'))
  );
}

function isSpacePanKey(event: KeyboardEvent): boolean {
  return event.code === PAN_ACTIVATION_KEY_CODE || event.key === ' ' || event.key === 'Spacebar';
}

function resolveClipboardImageFile(event: ClipboardEvent): File | null {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) {
    return null;
  }

  for (const item of Array.from(clipboardItems)) {
    if (!item.type.startsWith('image/')) {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const existingName = typeof file.name === 'string' ? file.name.trim() : '';
    if (existingName) {
      return file;
    }

    const subtype = item.type.split('/')[1]?.split('+')[0] || 'png';
    return new File([file], `pasted-image.${subtype}`, {
      type: file.type || item.type,
      lastModified: Date.now(),
    });
  }

  return null;
}

// 从一次 OS 文件拖放里挑出图片 / 视频 / 音频文件，口径见 isSupportedMediaFile
// （与 UploadNode 的媒体分流一致）。非媒体文件被忽略。
function collectDroppedMediaFiles(dataTransfer: DataTransfer): File[] {
  const files = dataTransfer.files;
  if (!files || files.length === 0) {
    return [];
  }
  return Array.from(files).filter(isSupportedMediaFile);
}

function resolveAllowedNodeTypes(
  handleType: HandleType,
  originNodeType?: CanvasNodeType,
): CanvasNodeType[] {
  // 拖线落空时弹出的「创建新节点」菜单，与 NodeSpawnPlusOverlay 的 + 菜单
  // 共用同一份白名单：source 端用 getDownstreamSpawnTypes(originType)。
  if (handleType === 'source') {
    return getDownstreamSpawnTypes(originNodeType);
  }
  const base = getConnectMenuNodeTypes(handleType);
  // 3D 世界节点的上游仅允许文本 / 图片节点（Phase 1）。
  if (originNodeType === CANVAS_NODE_TYPES.threeDWorld && handleType === 'target') {
    const allowed = new Set<CanvasNodeType>([
      CANVAS_NODE_TYPES.textAnnotation,
      CANVAS_NODE_TYPES.imageGen,
    ]);
    return base.filter((type) => allowed.has(type));
  }
  // 图片节点的上游仅允许 文本（textAnnotation / script）+ 图片（upload）
  // —— 不收音频 / 视频 / 3D 世界。这里不沿用 base 过滤，因为 base 只看
  // `fromTarget: true`，textAnnotation / imageGen 等 fromTarget 默认为 false
  // 会被错杀；我们对 imageGen target 直接重写候选集。
  if (originNodeType === CANVAS_NODE_TYPES.imageGen && handleType === 'target') {
    return [
      CANVAS_NODE_TYPES.textAnnotation,
      CANVAS_NODE_TYPES.script,
      CANVAS_NODE_TYPES.upload,
    ];
  }
  // 视频节点的上游仅允许 文本 / 图片（imageGen） / 音频 —— 跟
  // NodeSpawnPlusOverlay 左侧「+」按钮的白名单保持一致。
  if (originNodeType === CANVAS_NODE_TYPES.video && handleType === 'target') {
    return [
      CANVAS_NODE_TYPES.textAnnotation,
      CANVAS_NODE_TYPES.imageGen,
      CANVAS_NODE_TYPES.audio,
    ];
  }
  // 受上游类型白名单约束的目标（如音频←文本）：直接返回领域层白名单，保证连线
  // 菜单、手动拖线、isValidConnection、store 建边收口共用同一份规则。这里不沿用
  // base 过滤——base 只看 connectMenu.fromTarget，textAnnotation 的 fromTarget
  // 为 false 会被错杀。
  if (handleType === 'target' && originNodeType) {
    const allowedUpstream = getAllowedUpstreamSourceTypes(originNodeType);
    if (allowedUpstream) {
      return [...allowedUpstream];
    }
  }
  return base;
}

// 3D 世界节点的目标允许的手动拖线源：任何可以承载图片或文本结果的节点。
const THREE_D_WORLD_MANUAL_SOURCE_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.exportImage,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.textAnnotation,
]);

// 360° 全景查看器的下游手动连线只允许图片类节点。
const PANO_360_DOWNSTREAM_IMAGE_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.exportImage,
]);

function canNodeTypeBeManualConnectionSource(
  type: CanvasNodeType,
  targetType?: CanvasNodeType,
): boolean {
  if (targetType === CANVAS_NODE_TYPES.threeDWorld) {
    return THREE_D_WORLD_MANUAL_SOURCE_TYPES.has(type);
  }
  if (type === CANVAS_NODE_TYPES.pano360Viewer) {
    return targetType ? PANO_360_DOWNSTREAM_IMAGE_TYPES.has(targetType) : true;
  }
  // 受上游类型白名单约束的目标（如音频←文本）走领域层统一规则。
  if (targetType && getAllowedUpstreamSourceTypes(targetType)) {
    return isUpstreamConnectionAllowed(type, targetType);
  }
  // 只要 getDownstreamSpawnTypes 给这种类型留了至少一个合法下游，就允许从右侧
  // source handle 拖线创建 —— 这样 + 菜单和拖线菜单始终对齐，新增节点类型时
  // 只需要更新 getDownstreamSpawnTypes 一处。
  return getDownstreamSpawnTypes(type).length > 0;
}

function canNodeBeManualConnectionSource(
  nodeId: string | null | undefined,
  nodes: CanvasNode[],
  targetNodeId?: string | null | undefined,
): boolean {
  if (!nodeId) {
    return false;
  }
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  const targetType = targetNodeId
    ? nodes.find((item) => item.id === targetNodeId)?.type
    : undefined;
  return canNodeTypeBeManualConnectionSource(node.type, targetType);
}

function getClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event && 'clientY' in event) {
    return { x: event.clientX, y: event.clientY };
  }

  const touch = 'changedTouches' in event
    ? event.changedTouches[0] ?? event.touches[0]
    : null;
  if (!touch) {
    return null;
  }

  return { x: touch.clientX, y: touch.clientY };
}

function createPreviewPath(line: PreviewConnectionLine): string {
  const { start, end, handleType } = line;
  const deltaX = end.x - start.x;
  const curveStrength = Math.max(36, Math.min(120, Math.abs(deltaX) * 0.4));
  const handleDirection = handleType === 'source' ? 1 : -1;
  const isReverseDrag = deltaX * handleDirection < 0;
  const effectiveDirection = isReverseDrag ? -handleDirection : handleDirection;
  const startControlX = start.x + effectiveDirection * curveStrength;
  const endControlX = end.x - effectiveDirection * curveStrength;

  return `M ${start.x} ${start.y} C ${startControlX} ${start.y}, ${endControlX} ${end.y}, ${end.x} ${end.y}`;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

function handleIdFromElement(
  element: Element | null | undefined,
  nodeId: string,
  handleType: HandleType,
): string | null {
  const handleElement = element?.closest?.('.react-flow__handle') as HTMLElement | null;
  if (!handleElement) return null;
  if (handleElement.dataset.nodeid !== nodeId) return null;
  if (!handleElement.classList.contains(handleType)) return null;
  const handleId = handleElement.dataset.handleid;
  return typeof handleId === 'string' && handleId.trim() ? handleId.trim() : null;
}

function isVisibleConnectionHandle(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (
    element.classList.contains('!pointer-events-none')
    || element.classList.contains('opacity-0')
    || element.classList.contains('!opacity-0')
  ) {
    return false;
  }
  const style = window.getComputedStyle(element);
  return style.pointerEvents !== 'none' && style.opacity !== '0' && style.display !== 'none';
}

function nearestHandleIdAtPoint({
  nodeElement,
  nodeId,
  handleType,
  clientPosition,
  maxDistance = 28,
}: {
  nodeElement: HTMLElement | null | undefined;
  nodeId: string;
  handleType: HandleType;
  clientPosition: { x: number; y: number };
  maxDistance?: number;
}): string | null {
  if (!nodeElement) return null;
  let best: { id: string; distance: number } | null = null;
  const handles = Array.from(
    nodeElement.querySelectorAll<HTMLElement>('.react-flow__handle'),
  );
  for (const handle of handles) {
    if (handle.dataset.nodeid !== nodeId || !handle.classList.contains(handleType)) {
      continue;
    }
    if (!isVisibleConnectionHandle(handle)) {
      continue;
    }
    const handleId = handle.dataset.handleid;
    if (!handleId) {
      continue;
    }
    const rect = handle.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const distance = Math.hypot(centerX - clientPosition.x, centerY - clientPosition.y);
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { id: handleId, distance };
    }
  }
  return best?.id ?? null;
}

function resolveConnectEndHandleId({
  eventTarget,
  nodeElement,
  nodeId,
  handleType,
  clientPosition,
}: {
  eventTarget: Element | null;
  nodeElement: HTMLElement | null | undefined;
  nodeId: string;
  handleType: HandleType;
  clientPosition: { x: number; y: number };
}): string | null {
  return (
    handleIdFromElement(eventTarget, nodeId, handleType) ??
    handleIdFromElement(document.elementFromPoint(clientPosition.x, clientPosition.y), nodeId, handleType) ??
    nearestHandleIdAtPoint({
      nodeElement,
      nodeId,
      handleType,
      clientPosition,
    })
  );
}

interface PreviewConnectionLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
  handleType: HandleType;
}

interface PlusConnectDragParams {
  nodeId: string;
  handleType: HandleType;
  clientPosition: { x: number; y: number };
}

interface PendingNodePlacement {
  type: CanvasNodeType;
  initialData?: Partial<Record<string, unknown>>;
  skill?: SkillDefinition;
}

interface CanvasProps {
  onBlankPaneClick?: () => void;
  controlsPlacement?: 'bottom-right' | 'top-right';
}

export function Canvas({
  onBlankPaneClick,
  controlsPlacement = 'bottom-right',
}: CanvasProps = {}) {
  const { t } = useTranslation();
  const reactFlowInstance = useReactFlow();
  const reactFlowStore = useStoreApi();
  const nodeTypes = useMemo(() => canvasNodeTypes, []);
  const edgeTypes = useMemo(() => canvasEdgeTypes, []);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const suppressNextPaneClickRef = useRef(false);
  // After a marquee box-select we must swallow the trailing pane `click` at the capture
  // phase: React Flow's Pane onClick calls resetSelectedElements() unconditionally (right
  // after onPaneClick), which would instantly wipe the selection we just applied. Gating
  // our own onPaneClick is not enough — that reset runs regardless. See the capture-phase
  // click listener in the marquee effect.
  const swallowMarqueeClickRef = useRef(false);
  const suppressNextEdgeClickRef = useRef(false);
  const hoveredNodeClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const plusConnectStartRef = useRef<PendingConnectStart | null>(null);
  // 手动「+」拖线时，当前被高亮为合法落点的节点 DOM。手动连线走自绘预览线
  // （非 React Flow 原生连线），RF 不会给目标 handle 挂 connectingto/valid，所以
  // 落点动画靠这里在 dragMove 时直接给命中节点的 wrapper 加类、离开时摘掉，避免把
  // 落点状态塞进 node.data 触发全量节点重渲染。
  const dropTargetElRef = useRef<HTMLElement | null>(null);
  // Source node ids waiting to be fanned into the next spawned node (batch "+").
  const batchConnectDragRef = useRef<{
    sourceIds: string[];
    start: { x: number; y: number };
  } | null>(null);

  const [minimapPinned, setMinimapPinned] = useState(false);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const minimapVisible = minimapPinned || minimapHovered;
  // 小地图弹层（含上方的书签数字行）靠 hover 显示。数字行是小地图上方、隔着间隙的
  // 独立 DOM 子树:鼠标从小地图移到数字按钮的途中会先离开小地图,若立即把
  // minimapHovered 置 false,整个 overlay 会在点到按钮前卸载,导致「点不了」。
  // 这里给「隐藏」加一个短延迟:离开时延迟 false,任意区域(小地图/触发按钮/数字行)
  // 重新 hover 会取消该延迟,从而能稳定跨越间隙去点击。
  const minimapHideTimerRef = useRef<number | null>(null);
  const setMinimapHover = useCallback((hovered: boolean) => {
    if (minimapHideTimerRef.current !== null) {
      window.clearTimeout(minimapHideTimerRef.current);
      minimapHideTimerRef.current = null;
    }
    if (hovered) {
      setMinimapHovered(true);
    } else {
      minimapHideTimerRef.current = window.setTimeout(() => {
        setMinimapHovered(false);
        minimapHideTimerRef.current = null;
      }, 180);
    }
  }, []);
  useEffect(
    () => () => {
      if (minimapHideTimerRef.current !== null) {
        window.clearTimeout(minimapHideTimerRef.current);
      }
    },
    [],
  );
  // hover 节点 id 放在 store 里：除了喂给 NodeSpawnPlusOverlay 的「+」，
  // NodeSideActionRail 的上传/替换按钮栏也要据此「hover 才显示」。
  const hoveredNodeId = useCanvasStore((state) => state.hoveredNodeId);
  const setHoveredNodeId = useCanvasStore((state) => state.setHoveredNodeId);

  const [showNodeMenu, setShowNodeMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [flowPosition, setFlowPosition] = useState({ x: 0, y: 0 });
  const [pendingNodePlacement, setPendingNodePlacement] =
    useState<PendingNodePlacement | null>(null);
  const [nodePlacementClientPosition, setNodePlacementClientPosition] =
    useState<{ x: number; y: number } | null>(null);
  const [placementConfirmNodeId, setPlacementConfirmNodeId] = useState<string | null>(null);
  const [isPlusConnectDragging, setIsPlusConnectDragging] = useState(false);
  const [menuAllowedTypes, setMenuAllowedTypes] = useState<CanvasNodeType[] | undefined>(
    undefined
  );
  const [pendingConnectStart, setPendingConnectStart] = useState<PendingConnectStart | null>(
    null
  );
  // When set, the next spawned node (from the batch "+") is fanned into by all
  // these source nodes instead of the single `pendingConnectStart`.
  const [pendingBatchConnectIds, setPendingBatchConnectIds] = useState<string[] | null>(null);
  // Right-click (no-drag) context menu on the canvas pane. `x/y` are relative to
  // the canvas wrapper; `clientX/Y` drive spawn/menu positioning; the `can*`
  // flags are captured at open time so the menu reflects state at that moment.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    canUndo: boolean;
    canRedo: boolean;
    canPaste: boolean;
  } | null>(null);
  const [previewConnectionVisual, setPreviewConnectionVisual] =
    useState<PreviewConnectionVisual | null>(null);
  const [skillRegistry, setSkillRegistry] = useState<SkillDefinition[]>([]);
  const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelectionState | null>(
    null
  );

  const isRestoringCanvasRef = useRef(true);
  const initialViewportCorrectionPendingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placementConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodesInitialized = useNodesInitialized();
  const copiedSnapshotRef = useRef<ClipboardSnapshot | null>(sharedNodeClipboard);
  const pasteIterationRef = useRef(0);
  const pasteImageHandledRef = useRef(false);
  const lastCanvasPointerClientPositionRef = useRef<{ x: number; y: number } | null>(null);

  const clearHoveredNodeTimer = useCallback(() => {
    if (hoveredNodeClearTimerRef.current !== null) {
      clearTimeout(hoveredNodeClearTimerRef.current);
      hoveredNodeClearTimerRef.current = null;
    }
  }, []);

  const triggerPlacementConfirm = useCallback((nodeId: string) => {
    if (placementConfirmTimerRef.current !== null) {
      clearTimeout(placementConfirmTimerRef.current);
    }
    setPlacementConfirmNodeId(nodeId);
    placementConfirmTimerRef.current = setTimeout(() => {
      setPlacementConfirmNodeId(null);
      placementConfirmTimerRef.current = null;
    }, 900);
  }, []);

  const scheduleHoveredNodeClear = useCallback(() => {
    clearHoveredNodeTimer();
    hoveredNodeClearTimerRef.current = setTimeout(() => {
      setHoveredNodeId(null);
      hoveredNodeClearTimerRef.current = null;
    }, NODE_SPAWN_PLUS_HIDE_DELAY_MS);
  }, [clearHoveredNodeTimer]);

  const handleNodeMouseEnter = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      clearHoveredNodeTimer();
      setHoveredNodeId(node.id);
    },
    [clearHoveredNodeTimer],
  );

  const handleNodeMouseLeave = useCallback(() => {
    scheduleHoveredNodeClear();
  }, [scheduleHoveredNodeClear]);

  const handleCanvasPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    if (pendingNodePlacement) {
      const rect = wrapperElement.getBoundingClientRect();
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        const clientPosition = { x: event.clientX, y: event.clientY };
        lastCanvasPointerClientPositionRef.current = clientPosition;
        setNodePlacementClientPosition(clientPosition);
      }
      return;
    }

    if (!isCanvasPaneTarget(event.target, wrapperElement)) {
      return;
    }
    lastCanvasPointerClientPositionRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
  }, [pendingNodePlacement]);

  useEffect(() => {
    return () => {
      clearHoveredNodeTimer();
      if (placementConfirmTimerRef.current !== null) {
        clearTimeout(placementConfirmTimerRef.current);
      }
    };
  }, [clearHoveredNodeTimer]);
  const activeGenerationPollNodeIdsRef = useRef(new Set<string>());
  const activeTaskResumeNodeIdsRef = useRef(new Set<string>());
  const pasteFromClipboardRef = useRef<
    | ((
        snapshot: ClipboardSnapshot | null,
        targetFlow?: { x: number; y: number },
      ) => string | null)
    | null
  >(null);
  const altDragCopyRef = useRef<{
    sourceNodeIds: string[];
    startPositions: Map<string, { x: number; y: number }>;
    copiedNodeIds: string[];
    sourceToCopyIdMap: Map<string, string>;
  } | null>(null);
  // 正在拖动的组内成员所属的组 id 集合（libtv 式：拖动期间不动框，松手后按成员最终
  // 落点逐组 fitGroupToChildren 重新包住）。多选拖动可能同时带上多个组的成员，所以
  // 记数组而非单个 id。null = 当前没有组内成员在拖。
  const groupFitDragRef = useRef<{ groupIds: string[] } | null>(null);
  // 「导演世界」源节点 ←→「导演世界输出」组联动拖动：拖动开始时记下另一方(partner)及
  // 其起始坐标,拖动期间按相同位移把 partner 一起移动。null = 当前拖动不涉及联动。
  const linkedDragRef = useRef<{
    partnerStarts: Map<string, { x: number; y: number }>;
    draggedStart: { x: number; y: number };
  } | null>(null);
  // 吸附对齐索引缓存：单节点拖动期间其它节点不动,索引在拖动开始(nodeId 变化)时建一次,
  // 之后每帧只做二分查找,避免每帧 filter + 重扫全部节点。拖动结束时清空。
  const snapAlignIndexRef = useRef<{ nodeId: string; index: SnapAlignIndex } | null>(null);
  const marqueeSelectionRef = useRef<{
    active: boolean;
    pointerId: number;
    startClient: { x: number; y: number };
    startLocal: { x: number; y: number };
  } | null>(null);
  const edgePanGestureRef = useRef<{
    active: boolean;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewportX: number;
    startViewportY: number;
    zoom: number;
    moved: boolean;
  } | null>(null);
  // True while the space bar is held. React Flow's panActivationKeyCode defaults
  // to 'Space', so space + left-drag pans the canvas — but our custom marquee
  // box-select also runs on left-drag over the pane and would draw a dashed
  // selection box on top of the pan. The marquee pointerdown bails when this is
  // set so space-pan stays a clean grab.
  const spacePanActiveRef = useRef(false);

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  // 连线可见性：隐藏时只给 ReactFlow 的边打 `hidden`，真实 edges 一动不动（见
  // edgeVisibilityStore）。持久化/自动布局/导出全部照用 store 里的真实连线。
  const edgesHidden = useEdgeVisibilityStore((state) => state.hidden);

  // 预取 beat-context 节点引用到的剧集 beats/episode-detail,焐热缓存。配合 BeatContextNode
  // 里「仅选中时才查询」的门控,避免视口虚拟化下节点挂载即请求、卸载即被取消的 499 循环。
  // 收敛成稳定字符串,使下方 effect 只在引用的剧集集合变化时才跑(而非每次拖拽重建 nodes)。
  const queryClient = useQueryClient();
  // 项目 ID 取自 URL,在画布生命周期内不变,memo 一次,避免在每次 store 变更的 selector 里重复解析。
  const canvasProject = useMemo(() => readUrl().project, []);
  const beatContextEpisodesKey = useCanvasStore(
    useShallow((state) => {
      const pairs = new Set<string>();
      for (const node of state.nodes) {
        if (node.type !== CANVAS_NODE_TYPES.beatContext) continue;
        const data = node.data as BeatContextNodeData;
        const project =
          typeof data.projectId === 'string' ? data.projectId : canvasProject;
        const episode = typeof data.episode === 'number' ? data.episode : undefined;
        if (project && episode && episode > 0) pairs.add(`${project}:${episode}`);
      }
      return Array.from(pairs).sort().join(',');
    }),
  );
  useEffect(() => {
    if (!beatContextEpisodesKey) return;
    for (const pair of beatContextEpisodesKey.split(',')) {
      const sep = pair.lastIndexOf(':');
      const project = pair.slice(0, sep);
      const episode = Number(pair.slice(sep + 1));
      prefetchEpisodeBeats(queryClient, project, episode);
      prefetchEpisodeDetail(queryClient, project, episode);
    }
  }, [beatContextEpisodesKey, queryClient]);
  // 触控板平移开关：开启后用 ReactFlow 的 panOnScroll（两指滑动平移、捏合缩放），
  // 关闭则回到默认的滚轮缩放。
  const trackpadPanEnabled = useTrackpadPanStore((state) => state.enabled);
  // 底部任务中心面板展开时，让出底部空间——隐藏画布快捷操作栏，避免与面板重叠。
  const taskPanelOpen = useAppStore((state) => state.taskPanelOpen);
  // Stable signatures of the nodes that need polling / resume, so those effects
  // only re-run when the *set* of pending generations changes — not on every
  // drag frame (which rebuilds the whole `nodes` array). See the two effects below.
  const pendingJobNodeKey = useCanvasStore(
    useShallow((state) =>
      state.nodes
        .filter((node) => {
          if (node.type !== CANVAS_NODE_TYPES.exportImage) return false;
          const data = node.data as Record<string, unknown>;
          return (
            data.isGenerating === true &&
            typeof data.generationJobId === 'string' &&
            (data.generationJobId as string).length > 0
          );
        })
        .map((node) => node.id),
    ),
  );
  const pendingResumeNodeKey = useCanvasStore(
    useShallow((state) => state.nodes.filter(nodeNeedsGenerationResume).map((node) => node.id)),
  );
  const history = useCanvasStore((state) => state.history);
  const dragHistorySnapshot = useCanvasStore((state) => state.dragHistorySnapshot);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const applyEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const replaceEdges = useCanvasStore((state) => state.replaceEdges);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const pendingFocusNodeId = useCanvasStore((state) => state.pendingFocusNodeId);
  const clearPendingFocus = useCanvasStore((state) => state.clearPendingFocus);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const groupNodes = useCanvasStore((state) => state.groupNodes);
  const setNodePositions = useCanvasStore((state) => state.setNodePositions);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const closeToolDialog = useCanvasStore((state) => state.closeToolDialog);
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const setCanvasViewportSize = useCanvasStore((state) => state.setCanvasViewportSize);
  // ReactFlow only mounts after useCanvasSync has hydrated the store (freezone
  // web mode renders <Canvas> behind a loading gate), so the restored camera is
  // already in `currentViewport` by our first render. Capture it here and feed
  // it as `defaultViewport` so ReactFlow initializes straight to the saved
  // position instead of {0,0,1} (which dumped all nodes to the bottom-right).
  const initialViewportRef = useRef(useCanvasStore.getState().currentViewport);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);
  const [videoViewer, setVideoViewer] = useState<{
    isOpen: boolean;
    videoUrl: string;
    title?: string;
  }>({ isOpen: false, videoUrl: '', title: undefined });
  const closeVideoViewer = useCallback(() => {
    setVideoViewer((prev) => ({ ...prev, isOpen: false }));
  }, []);
  const skillById = useMemo(
    () => new Map(skillRegistry.map((skill) => [skill.id, skill] as const)),
    [skillRegistry],
  );
  const renderedNodes = useMemo(() => {
    if (!placementConfirmNodeId) {
      return nodes;
    }
    return nodes.map((node) => {
      if (node.id !== placementConfirmNodeId) {
        return node;
      }
      return {
        ...node,
        className: [node.className, 'canvas-node-placement-confirm']
          .filter(Boolean)
          .join(' '),
      };
    });
  }, [nodes, placementConfirmNodeId]);

  // 隐藏连线时给每条边补 `hidden: true`——ReactFlow 会跳过渲染但边仍在图里，
  // 连接、reconnect、持久化都不受影响。显示时直接透传真实 edges，零额外分配。
  const renderedEdges = useMemo(() => {
    if (!edgesHidden) return edges;
    return edges.map((edge) => (edge.hidden ? edge : { ...edge, hidden: true }));
  }, [edges, edgesHidden]);

  const clearMarqueeSelection = useCallback(() => {
    marqueeSelectionRef.current = null;
    setMarqueeSelection(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSkillRegistry()
      .then((items) => {
        if (!cancelled) {
          setSkillRegistry(items);
        }
      })
      .catch((error) => {
        console.warn('[SkillNode] failed to load skill registry for canvas connections', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isSpacePanKey(event) || isTypingTarget(event.target) || isImmersiveViewerActive()) {
        return;
      }
      spacePanActiveRef.current = true;
      clearMarqueeSelection();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!isSpacePanKey(event)) {
        return;
      }
      spacePanActiveRef.current = false;
    };

    const handleBlur = () => {
      spacePanActiveRef.current = false;
      clearMarqueeSelection();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [clearMarqueeSelection]);

  const persistCanvasSnapshot = useCallback(() => {
    // supertale-fe web mode persists through useCanvasSync's Zustand
    // subscription. This callback is kept so canvas-local event handlers can
    // still schedule a save boundary without coupling to persistence details.
  }, []);

  const scheduleCanvasPersist = useCallback(
    (delayMs = 140) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        persistCanvasSnapshot();
      }, delayMs);
    },
    [persistCanvasSnapshot]
  );

  useEffect(() => {
    const unsubscribeOpen = canvasEventBus.subscribe('tool-dialog/open', (payload) => {
      openToolDialog(payload);
    });
    const unsubscribeClose = canvasEventBus.subscribe('tool-dialog/close', () => {
      closeToolDialog();
    });
    const unsubscribeVideoOpen = canvasEventBus.subscribe('video-viewer/open', ({ videoUrl, title }) => {
      setVideoViewer({ isOpen: true, videoUrl, title });
    });

    return () => {
      unsubscribeOpen();
      unsubscribeClose();
      unsubscribeVideoOpen();
    };
  }, [openToolDialog, closeToolDialog]);

  // 单一写入器:把画布缩放写进根元素的 --st-canvas-zoom CSS 变量。各浮动工具条
  // (ZoomScaledToolbar / NodeSideActionRail)改用 CSS `scale(var(...))` 跟随缩放,
  // 不再各自 useStore 订阅 zoom —— 把「每节点一份 zoom 订阅、缩放时全部重渲染」收敛
  // 成一个不触发 React 重渲染的命令式订阅。
  useEffect(() => {
    const root = document.documentElement;
    let last = NaN;
    const write = () => {
      const zoom = reactFlowStore.getState().transform[2];
      if (zoom !== last) {
        last = zoom;
        root.style.setProperty('--st-canvas-zoom', String(zoom));
      }
    };
    write();
    return reactFlowStore.subscribe(write);
  }, [reactFlowStore]);

  useEffect(() => {
    isRestoringCanvasRef.current = true;
    if (useCanvasStore.getState().nodes.length === 0) {
      // useCanvasSync owns the camera and has already restored it into the
      // store. Only center the view for a genuinely empty/new canvas;
      // otherwise we'd clobber the restored
      // viewport (and the localStorage copy that mirrors it) with the empty
      // center, snapping the user back to {w/2, h/2} on every refresh.
      setViewportState(resolveCenteredViewport(wrapperRef.current, []));
    }
    const restoreTimer = setTimeout(() => {
      isRestoringCanvasRef.current = false;
    }, 0);

    return () => {
      clearTimeout(restoreTimer);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      closeImageViewer();
      persistCanvasSnapshot();
    };
  }, [
    closeImageViewer,
    persistCanvasSnapshot,
    setViewportState,
  ]);

  useEffect(() => {
    if (isRestoringCanvasRef.current || dragHistorySnapshot) {
      return;
    }

    scheduleCanvasPersist();
  }, [nodes, edges, history, dragHistorySnapshot, scheduleCanvasPersist]);

  // 项目刚加载完时，先按用户保存的 viewport 恢复。
  // 等节点完成测量后再判断：若节点 bbox 与当前可视区完全无交集（视图飞到空白处），
  // 自动 fitView 回到节点集中区，避免用户找不到自己的内容。
  useEffect(() => {
    if (!initialViewportCorrectionPendingRef.current) return;
    if (!nodesInitialized) return;

    const container = wrapperRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    initialViewportCorrectionPendingRef.current = false;

    const topLevelNodes = nodes.filter((node) => !node.parentId);
    if (topLevelNodes.length === 0) return;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of topLevelNodes) {
      const width = node.measured?.width
        ?? (typeof node.width === 'number' ? node.width : DEFAULT_NODE_WIDTH);
      const height = node.measured?.height
        ?? (typeof node.height === 'number' ? node.height : 200);
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + width);
      maxY = Math.max(maxY, node.position.y + height);
    }
    if (!Number.isFinite(minX)) return;

    const vp = reactFlowInstance.getViewport();
    const viewMinX = -vp.x / vp.zoom;
    const viewMaxX = (rect.width - vp.x) / vp.zoom;
    const viewMinY = -vp.y / vp.zoom;
    const viewMaxY = (rect.height - vp.y) / vp.zoom;

    const overlapsView =
      maxX > viewMinX && minX < viewMaxX && maxY > viewMinY && minY < viewMaxY;

    if (!overlapsView) {
      reactFlowInstance.fitView({ padding: 0.2, duration: 0, maxZoom: 1 });
    }
  }, [nodesInitialized, nodes, reactFlowInstance]);

  // 处理外部（左侧资源面板等）发起的「聚焦节点」请求：
  // setCenter 到节点中心，并保留当前 zoom（让用户能看清新加进来的资源）。
  // 节点刚 add 完时 measured 还没到，回退到 DEFAULT_NODE_WIDTH / 240 估算。
  useEffect(() => {
    if (!pendingFocusNodeId) return;
    const target = nodes.find((node) => node.id === pendingFocusNodeId);
    if (!target) {
      clearPendingFocus();
      return;
    }
    const width =
      target.measured?.width ??
      (typeof target.width === 'number' ? target.width : DEFAULT_NODE_WIDTH);
    const height =
      target.measured?.height ??
      (typeof target.height === 'number' ? target.height : 240);
    // 组内成员的 position 是相对父组坐标；setCenter 需要绝对坐标，否则聚焦会跳偏。
    const absolute =
      reactFlowInstance.getInternalNode(pendingFocusNodeId)?.internals
        .positionAbsolute ?? target.position;
    const centerX = absolute.x + width / 2;
    const centerY = absolute.y + height / 2;
    const currentZoom = reactFlowInstance.getZoom();
    reactFlowInstance.setCenter(centerX, centerY, {
      zoom: Math.max(currentZoom, 0.6),
      duration: 320,
    });
    clearPendingFocus();
  }, [pendingFocusNodeId, nodes, reactFlowInstance, clearPendingFocus]);

  useEffect(() => {
    const sleep = (delayMs: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });

    const pendingExportNodes = useCanvasStore.getState().nodes.filter((node) => {
      if (node.type !== CANVAS_NODE_TYPES.exportImage) {
        return false;
      }
      const data = node.data as Record<string, unknown>;
      return data.isGenerating === true && typeof data.generationJobId === 'string' && data.generationJobId.length > 0;
    });

    for (const pendingNode of pendingExportNodes) {
      if (activeGenerationPollNodeIdsRef.current.has(pendingNode.id)) {
        continue;
      }
      activeGenerationPollNodeIdsRef.current.add(pendingNode.id);

      void (async () => {
        try {
          while (true) {
            const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
            if (!currentNode) {
              break;
            }

            const currentData = currentNode.data as Record<string, unknown>;
            const jobId = typeof currentData.generationJobId === 'string' ? currentData.generationJobId : '';
            const isGenerating = currentData.isGenerating === true;
            if (!jobId || !isGenerating) {
              break;
            }

            const status = await canvasAiGateway.getGenerateImageJob(jobId).catch((error) => {
              console.warn('[GenerationJob] poll failed', { nodeId: pendingNode.id, jobId, error });
              return null;
            });
            if (!status) {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === 'queued' || status.status === 'running') {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === 'succeeded' && typeof status.result === 'string' && status.result.trim()) {
              const resultUrl = status.result.trim();
              const prepared = await prepareNodeImage(resultUrl);
              const storyboardMetadataRaw = currentData.generationStoryboardMetadata as GenerationStoryboardMetadata | undefined;
              const hasStoryboardMetadata = Boolean(
                storyboardMetadataRaw
                && Number.isFinite(storyboardMetadataRaw.gridRows)
                && Number.isFinite(storyboardMetadataRaw.gridCols)
                && Array.isArray(storyboardMetadataRaw.frameNotes)
              );
              // Prefer the backend result URL as the canonical imageUrl so
              // downstream requests carry a real http URL, not the re-localized
              // base64. Only the storyboard case needs local processing (to embed
              // grid metadata into the pixels) — re-upload that so imageUrl stays
              // a backend URL too. previewImageUrl mirrors the final imageUrl so
              // the persisted node never carries the local base64 from
              // prepareNodeImage (which would bloat PUT /default).
              let imageUrl = resultUrl;
              if (hasStoryboardMetadata && storyboardMetadataRaw) {
                const imageWithMetadata = await embedStoryboardImageMetadata(prepared.imageUrl, {
                  gridRows: Math.max(1, Math.round(storyboardMetadataRaw.gridRows)),
                  gridCols: Math.max(1, Math.round(storyboardMetadataRaw.gridCols)),
                  frameNotes: storyboardMetadataRaw.frameNotes,
                }).catch((error) => {
                  console.warn('[GenerationJob] embed storyboard metadata failed', {
                    nodeId: pendingNode.id,
                    error,
                  });
                  return prepared.imageUrl;
                });
                imageUrl = await uploadLocalImageToBackend(
                  imageWithMetadata,
                  `storyboard-gen-${pendingNode.id}-${Date.now()}.png`
                );
              }
              const previewImageUrl = imageUrl;

              updateNodeData(pendingNode.id, {
                imageUrl,
                previewImageUrl,
                aspectRatio: prepared.aspectRatio,
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationProviderId: null,
                generationClientSessionId: null,
                generationStoryboardMetadata: undefined,
                generationError: null,
                generationErrorDetails: null,
                generationDebugContext: undefined,
              });
              break;
            }

            const errorMessage = status.error ?? (status.status === 'not_found' ? 'generation job not found' : 'generation failed');
            const generationClientSessionId = typeof currentData.generationClientSessionId === 'string'
              ? currentData.generationClientSessionId
              : '';
            const shouldShowDialog = generationClientSessionId === CURRENT_RUNTIME_SESSION_ID;
            if (shouldShowDialog) {
              const reportText = buildGenerationErrorReport({
                errorMessage,
                errorDetails: status.error ?? undefined,
                context: currentData.generationDebugContext,
              });
              void showErrorDialog(errorMessage, t('common.error'), status.error ?? undefined, reportText);
            }
            updateNodeData(pendingNode.id, {
              isGenerating: false,
              generationStartedAt: null,
              generationJobId: null,
              generationProviderId: null,
              generationClientSessionId: null,
              // Keep generationStoryboardMetadata + generationRequestPayload intact so
              // 重新生成 can re-submit (and re-embed grid metadata) after an async failure.
              generationError: errorMessage,
              generationErrorDetails: status.error ?? null,
              // Surface the upstream request_id so the failure card can show it
              // (async failures previously dropped it — see ImageGenNode banner).
              generationErrorRequestId:
                extractRequestId(errorMessage) ?? extractRequestId(status.error),
            });
            break;
          }
        } finally {
          activeGenerationPollNodeIdsRef.current.delete(pendingNode.id);
        }
      })();
    }
  }, [pendingJobNodeKey, updateNodeData]);

  // Resume task_key-based generations (image / video / audio / 3D / script / 反推提示词)
  // after a page refresh. The submit flows persist a GenerationTaskDescriptor on the
  // node; here we re-attach to the task API so the result lands and the 生成中 overlay
  // (driven by generationStartedAt) clears correctly.
  useEffect(() => {
    const projectId = readUrl().project;
    if (!projectId) return;

    const pendingTaskNodes = useCanvasStore.getState().nodes.filter(
      (node) =>
        nodeNeedsGenerationResume(node) &&
        !activeTaskResumeNodeIdsRef.current.has(node.id),
    );

    for (const pendingNode of pendingTaskNodes) {
      activeTaskResumeNodeIdsRef.current.add(pendingNode.id);
      void resumeNodeGeneration({
        node: pendingNode,
        projectId,
        updateNodeData,
        getNodeData: (nodeId) =>
          (useCanvasStore
            .getState()
            .nodes
            .find((node) => node.id === nodeId)?.data ?? null) as Record<string, unknown> | null,
      }).finally(() => {
        activeTaskResumeNodeIdsRef.current.delete(pendingNode.id);
      });
    }
  }, [pendingResumeNodeKey, updateNodeData]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setCanvasViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [setCanvasViewportSize]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      // 拖拽时 applyNodeChanges 每帧重建 nodes 数组。这里只在事件回调里「读一次」当前快照,
      // 不把 nodes 列进依赖,避免该回调每帧重建、进而打穿下游 memo。
      const nodes = useCanvasStore.getState().nodes;
      const lockedNodeIds = new Set(nodes.filter(isPresetManagedNode).map((node) => node.id));
      const unlockedChanges = changes.filter((change) => {
        if (!('id' in change)) {
          return true;
        }
        if (!lockedNodeIds.has(change.id)) {
          return true;
        }
        return change.type !== 'remove';
      });
      if (unlockedChanges.length === 0) {
        return;
      }
      // 吸附对齐：仅在用户启用、且只有一个节点正在被拖动时介入。
      // 多选拖动暂不做吸附 —— 各节点单独算 snap delta 会导致它们之间出现错位。
      // alt-复制拖动也跳过：handleNodeDrag 会把 source 复位 / 把 copy 按 delta 跟上，
      // 这里再吸附会和它打架。
      let effectiveChanges = unlockedChanges;
      const snapEnabled = useSnapAlignStore.getState().enabled;
      if (snapEnabled && !altDragCopyRef.current) {
        const draggingPositionChanges = unlockedChanges.filter(
          (change) =>
            change.type === 'position' &&
            'dragging' in change &&
            change.dragging === true &&
            change.position
        );
        if (draggingPositionChanges.length === 1) {
          const change = draggingPositionChanges[0] as Extract<
            NodeChange<CanvasNode>,
            { type: 'position' }
          > & { position: { x: number; y: number }; dragging: true };
          const draggedNode = nodes.find((n) => n.id === change.id);
          if (draggedNode) {
            // 仅在新一次拖动(目标节点变化)时重建索引;同一拖动的后续帧复用。
            if (snapAlignIndexRef.current?.nodeId !== change.id) {
              const otherNodes = nodes.filter(
                (n) => n.id !== change.id && n.type !== CANVAS_NODE_TYPES.group
              );
              snapAlignIndexRef.current = {
                nodeId: change.id,
                index: buildSnapAlignIndex(otherNodes),
              };
            }
            const snap = computeSnapAlignFromIndex(
              draggedNode,
              change.position,
              snapAlignIndexRef.current.index
            );
            useSnapAlignStore.getState().setGuides(snap.guides);
            effectiveChanges = unlockedChanges.map((c) =>
              c === change ? { ...change, position: snap.position } : c
            );
          }
        } else if (draggingPositionChanges.length > 1) {
          // 多选拖动期间隐藏引导线，避免误导。
          useSnapAlignStore.getState().clearGuides();
        }
      }
      applyNodesChange(effectiveChanges);

      const hasDragMove = unlockedChanges.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          Boolean(change.dragging)
      );
      const hasDragEnd = unlockedChanges.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          change.dragging === false
      );
      const hasResizeMove = unlockedChanges.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          Boolean(change.resizing)
      );
      const hasResizeEnd = unlockedChanges.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          change.resizing === false
      );
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;

      if (hasInteractionMove) {
        return;
      }

      if (hasInteractionEnd) {
        scheduleCanvasPersist(0);
        return;
      }

      scheduleCanvasPersist();
    },
    [applyNodesChange, scheduleCanvasPersist]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      const edges = useCanvasStore.getState().edges;
      const lockedEdgeIds = new Set(edges.filter(isPresetManagedEdge).map((edge) => edge.id));
      const unlockedChanges = changes.filter((change) => {
        if (!('id' in change)) {
          return true;
        }
        if (!lockedEdgeIds.has(change.id)) {
          return true;
        }
        return change.type === 'select';
      });
      if (unlockedChanges.length === 0) {
        return;
      }
      applyEdgesChange(unlockedChanges);
      scheduleCanvasPersist();
    },
    [applyEdgesChange, scheduleCanvasPersist]
  );

  const handleEdgeDoubleClick = useCallback(
    (event: ReactMouseEvent, edge: CanvasEdge) => {
      event.preventDefault();
      event.stopPropagation();
      if (isPresetManagedEdge(edge)) {
        return;
      }
      deleteEdge(edge.id);
      scheduleCanvasPersist(0);
    },
    [deleteEdge, scheduleCanvasPersist]
  );

  const handleEdgeClick = useCallback((event: ReactMouseEvent) => {
    if (!suppressNextEdgeClickRef.current) {
      return;
    }
    suppressNextEdgeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const connectSkillRoleBinding = useCallback(
    (connection: Connection, explicitSkill?: SkillDefinition | null): boolean => {
      const currentState = useCanvasStore.getState();
      const targetNode = currentState.nodes.find((node) => node.id === connection.target);
      const sourceNode = currentState.nodes.find((node) => node.id === connection.source);
      const skillNode =
        targetNode?.type === CANVAS_NODE_TYPES.skill
          ? targetNode
          : sourceNode?.type === CANVAS_NODE_TYPES.skill
            ? sourceNode
            : null;
      if (!skillNode) {
        return false;
      }
      const skillId =
        typeof (skillNode.data as { skill_id?: unknown }).skill_id === 'string'
          ? (skillNode.data as { skill_id: string }).skill_id
          : '';
      const skillSpec = explicitSkill ?? skillById.get(skillId);
      if (!skillSpec) {
        console.warn('[SkillNode] rejected role binding before skill registry loaded', {
          skillId,
          target: skillNode.id,
        });
        return true;
      }
      if (sourceNode?.type === CANVAS_NODE_TYPES.skill && targetNode?.type !== CANVAS_NODE_TYPES.skill) {
        const sourceRole =
          typeof connection.sourceHandle === 'string'
            ? connection.sourceHandle.trim().split(':', 1)[0]
            : '';
        if (!sourceRole || !skillSpec.inputs.some((input) => input.role === sourceRole)) {
          return false;
        }
      }

      const nextEdges = applySkillRoleBindingConnection({
        nodes: currentState.nodes,
        edges: currentState.edges,
        connection,
        skillSpec,
      });
      if (nextEdges === currentState.edges) {
        return true;
      }
      replaceEdges(nextEdges);
      return true;
    },
    [replaceEdges, skillById],
  );

  const connectGraphNodes = useCallback(
    (connection: Connection, explicitSkill?: SkillDefinition | null): void => {
      if (connectSkillRoleBinding(connection, explicitSkill)) {
        return;
      }
      connectNodes(connection);
    },
    [connectNodes, connectSkillRoleBinding],
  );

  const bindSingleBeatContextInput = useCallback(
    (skillNodeId: string, skill: SkillDefinition) => {
      if (!skill.inputs.some((input) => input.role === 'beat_context')) {
        return;
      }
      const currentState = useCanvasStore.getState();
      const beatContextNodes = currentState.nodes.filter(
        (node) => node.type === CANVAS_NODE_TYPES.beatContext,
      );
      if (beatContextNodes.length !== 1) {
        return;
      }
      connectSkillRoleBinding(
        {
          source: beatContextNodes[0].id,
          target: skillNodeId,
          sourceHandle: 'source',
          targetHandle: 'beat_context',
        },
        skill,
      );
    },
    [connectSkillRoleBinding],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!canNodeBeManualConnectionSource(connection.source, nodes, connection.target)) {
        return;
      }
      connectGraphNodes(connection);
      scheduleCanvasPersist(0);
    },
    [connectGraphNodes, nodes, scheduleCanvasPersist]
  );

  // 3D 世界节点只用一张上游图生成 —— 入边唯一。已有上游时实时拒绝再连入(连线
  // 落点变灰、不成边),引导用户先断开现有连线。最终 onConnect 里也有同样的硬约束
  // 兜底拖到空白生成节点等其它路径。
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const targetId = connection.target;
      if (!targetId) return true;
      const targetNode = nodes.find((node) => node.id === targetId);
      if (!targetNode) return true;
      // 上游类型规则：拖线过程中即把不合法的源（如音频连音频）变灰、禁止落点。
      const sourceNode = connection.source
        ? nodes.find((node) => node.id === connection.source)
        : undefined;
      if (sourceNode && !isUpstreamConnectionAllowed(sourceNode.type, targetNode.type)) {
        return false;
      }
      if (targetNode.type !== CANVAS_NODE_TYPES.threeDWorld) return true;
      return !edges.some(
        (edge) => edge.target === targetId && edge.source !== connection.source,
      );
    },
    [nodes, edges]
  );

  // 平移/缩放期间 onMove 每帧触发。把 currentViewport 写进 store 会让所有订阅者每帧
  // 重跑 selector(如 BackToNodesHint 的 O(n) 可见性判断)。这里节流到 ~8fps,并在
  // onMoveEnd 必定提交最终值,既消除每帧 store 风暴,又保证落库/可见性判断及时收敛。
  const lastViewportCommitRef = useRef(0);
  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      lastViewportCommitRef.current = Date.now();
      setViewportState(viewport);
    },
    [setViewportState]
  );

  const handleMove = useCallback(
    (_event: unknown, viewport: Viewport) => {
      const now = Date.now();
      if (now - lastViewportCommitRef.current < 120) {
        return;
      }
      lastViewportCommitRef.current = now;
      setViewportState(viewport);
    },
    [setViewportState]
  );

  const handleMoveStart = useCallback(() => {}, []);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const edgePathSelector = '.react-flow__edge-path, .react-flow__edge-interaction';
    const dragThreshold = 4;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (target.closest('.react-flow__edgeupdater')) {
        return;
      }

      const edgePathElement = target.closest(edgePathSelector);
      if (!edgePathElement) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      edgePanGestureRef.current = {
        active: true,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewportX: viewport.x,
        startViewportY: viewport.y,
        zoom: viewport.zoom,
        moved: false,
      };
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || !gesture.active || event.pointerId !== gesture.pointerId) {
        return;
      }

      const deltaX = event.clientX - gesture.startClientX;
      const deltaY = event.clientY - gesture.startClientY;

      if (!gesture.moved && Math.hypot(deltaX, deltaY) >= dragThreshold) {
        gesture.moved = true;
      }
      if (!gesture.moved) {
        return;
      }

      suppressNextEdgeClickRef.current = true;
      reactFlowInstance.setViewport(
        {
          x: gesture.startViewportX + deltaX,
          y: gesture.startViewportY + deltaY,
          zoom: gesture.zoom,
        },
        { duration: 0 }
      );
    };

    const completeEdgePanGesture = () => {
      const gesture = edgePanGestureRef.current;
      if (!gesture) {
        return;
      }

      edgePanGestureRef.current = null;
      if (!gesture.moved) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      setViewportState(viewport);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);

    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [
    reactFlowInstance,
    setViewportState,
  ]);

  const openNodeMenuAtClientPosition = useCallback((clientPosition: { x: number; y: number }) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    const flowPos = reactFlowInstance.screenToFlowPosition(clientPosition);
    setFlowPosition(flowPos);
    setMenuPosition({
      x: clientPosition.x - (containerRect?.left ?? 0),
      y: clientPosition.y - (containerRect?.top ?? 0),
    });
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
    setPendingNodePlacement(null);
    setNodePlacementClientPosition(null);
    setSelectedNode(null);
    setShowNodeMenu(true);
  }, [reactFlowInstance, setSelectedNode]);

  const closeNodeMenu = useCallback(() => {
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPendingBatchConnectIds(null);
    setPreviewConnectionVisual(null);
  }, []);

  const cancelNodePlacement = useCallback(() => {
    setPendingNodePlacement(null);
    setNodePlacementClientPosition(null);
  }, []);

  const commitNodePlacementAtClientPosition = useCallback(
    (clientPosition: { x: number; y: number }) => {
      if (!pendingNodePlacement) {
        return false;
      }

      const newNodeId = addNode(
        pendingNodePlacement.type,
        reactFlowInstance.screenToFlowPosition({
          x: clientPosition.x - NODE_PLACEMENT_PREVIEW_WIDTH / 2,
          y: clientPosition.y - NODE_PLACEMENT_PREVIEW_HEIGHT / 2,
        }),
        pendingNodePlacement.initialData,
      );
      setSelectedNode(newNodeId);
      if (pendingNodePlacement.skill) {
        bindSingleBeatContextInput(newNodeId, pendingNodePlacement.skill);
      }
      triggerPlacementConfirm(newNodeId);
      scheduleCanvasPersist(0);
      setPendingNodePlacement(null);
      setNodePlacementClientPosition(null);
      suppressNextPaneClickRef.current = true;
      return true;
    },
    [
      addNode,
      bindSingleBeatContextInput,
      pendingNodePlacement,
      reactFlowInstance,
      scheduleCanvasPersist,
      setSelectedNode,
      triggerPlacementConfirm,
    ],
  );

  // Clicking a storyboard board focuses it; during node placement, any node click
  // is treated as confirming the preview location instead of selecting that node.
  const handleNodeClick = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      if (pendingNodePlacement) {
        event.preventDefault();
        event.stopPropagation();
        commitNodePlacementAtClientPosition({ x: event.clientX, y: event.clientY });
        return;
      }
      if (!isStoryboardGroupNode(node)) {
        return;
      }
      const width =
        node.measured?.width ??
        (typeof node.width === 'number' ? node.width : DEFAULT_NODE_WIDTH);
      const height =
        node.measured?.height ??
        (typeof node.height === 'number' ? node.height : 240);
      reactFlowInstance.setCenter(
        node.position.x + width / 2,
        node.position.y + height / 2,
        { zoom: 1, duration: 320 },
      );
    },
    [commitNodePlacementAtClientPosition, pendingNodePlacement, reactFlowInstance],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.key !== 'Tab' ||
        isTypingTarget(event.target) ||
        isImmersiveViewerActive()
      ) {
        return;
      }

      const wrapperElement = wrapperRef.current;
      const fallbackRect = wrapperElement
        ?.querySelector<HTMLElement>('.react-flow__pane')
        ?.getBoundingClientRect()
        ?? wrapperElement?.getBoundingClientRect();
      const clientPosition = lastCanvasPointerClientPositionRef.current
        ?? (fallbackRect
          ? {
              x: fallbackRect.left + fallbackRect.width / 2,
              y: fallbackRect.top + fallbackRect.height / 2,
            }
          : null);
      if (!clientPosition) {
        return;
      }

      event.preventDefault();
      openNodeMenuAtClientPosition(clientPosition);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openNodeMenuAtClientPosition]);

  // Viewport bookmarks: ⌘/Ctrl+digit captures the current viewport into a slot,
  // a bare digit jumps to it, and ⌘/Ctrl+Shift+E clears them all.
  useEffect(() => {
    const handleBookmarkKeys = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || isImmersiveViewerActive()) {
        return;
      }
      const commandPressed = event.ctrlKey || event.metaKey;

      // ⌘/Ctrl + Shift + E — clear all bookmarks
      if (commandPressed && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        useCanvasStore.getState().clearViewportBookmarks();
        return;
      }

      // Digit keys (no Shift/Alt). ⌘/Ctrl + digit sets; bare digit jumps.
      if (event.shiftKey || event.altKey) {
        return;
      }
      const index = digitToBookmarkIndex(event.key);
      if (index == null) {
        return;
      }
      if (commandPressed) {
        event.preventDefault();
        useCanvasStore
          .getState()
          .setViewportBookmark(index, captureCurrentViewport(reactFlowInstance));
        return;
      }
      event.preventDefault();
      const bookmark = useCanvasStore.getState().viewportBookmarks[index];
      if (bookmark) {
        jumpToBookmark(reactFlowInstance, bookmark);
      }
    };

    window.addEventListener('keydown', handleBookmarkKeys);
    return () => window.removeEventListener('keydown', handleBookmarkKeys);
  }, [reactFlowInstance]);

  // M — toggle the canvas minimap (pin / unpin). Bare key only, so it never
  // collides with ⌘M (minimize) or text input.
  useEffect(() => {
    const handleMinimapKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        return;
      }
      if (event.key.toLowerCase() !== 'm') {
        return;
      }
      if (isTypingTarget(event.target) || isImmersiveViewerActive()) {
        return;
      }
      event.preventDefault();
      setMinimapPinned((value) => !value);
    };

    window.addEventListener('keydown', handleMinimapKey);
    return () => window.removeEventListener('keydown', handleMinimapKey);
  }, []);

  // Track the space bar so the marquee box-select can yield to space-pan.
  // Ignored while typing (space is a normal character there). Reset on blur so a
  // keyup that fires off-window (e.g. after an alt-tab) can't leave it stuck on.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) {
        return;
      }
      spacePanActiveRef.current = true;
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') {
        return;
      }
      spacePanActiveRef.current = false;
    };
    const handleBlur = () => {
      spacePanActiveRef.current = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      // Any fresh pointer interaction clears a stale "swallow the marquee click" flag so a
      // marquee that produced no trailing click can't eat a later, unrelated click.
      swallowMarqueeClickRef.current = false;
      if (pendingNodePlacement) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      // Space + left-drag is a pan gesture (React Flow's panActivationKeyCode).
      // Don't start a marquee on top of it, or a dashed box shows while panning.
      if (spacePanActiveRef.current) {
        clearMarqueeSelection();
        return;
      }
      if (!isCanvasPaneTarget(event.target, wrapperElement)) {
        return;
      }

      const containerRect = wrapperElement.getBoundingClientRect();
      const startLocal = {
        x: event.clientX - containerRect.left,
        y: event.clientY - containerRect.top,
      };
      // Only record a candidate gesture here. We deliberately do NOT
      // preventDefault/stopPropagation on pointer down so a plain left click (no drag)
      // still reaches React Flow's onPaneClick — keeping deselect-on-click and
      // double-click-opens-node-menu working. Suppression starts once the marquee activates.
      marqueeSelectionRef.current = {
        active: false,
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        startLocal,
      };
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = marqueeSelectionRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      if (spacePanActiveRef.current) {
        clearMarqueeSelection();
        return;
      }

      const distance = Math.hypot(
        event.clientX - gesture.startClient.x,
        event.clientY - gesture.startClient.y
      );
      if (!gesture.active && distance < MARQUEE_SELECTION_MIN_DISTANCE) {
        // Below the drag threshold: leave the event alone so a click can still form.
        return;
      }
      if (!gesture.active) {
        gesture.active = true;
        setShowNodeMenu(false);
        setMenuAllowedTypes(undefined);
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        setSelectedNode(null);
        // Drop any prior selection frame so it doesn't linger behind the new marquee.
        reactFlowStore.setState({ nodesSelectionActive: false });
      }

      const containerRect = wrapperElement.getBoundingClientRect();
      setMarqueeSelection({
        start: gesture.startLocal,
        current: {
          x: event.clientX - containerRect.left,
          y: event.clientY - containerRect.top,
        },
      });
      event.preventDefault();
      event.stopPropagation();
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = marqueeSelectionRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      if (spacePanActiveRef.current) {
        clearMarqueeSelection();
        return;
      }

      const distance = Math.hypot(
        event.clientX - gesture.startClient.x,
        event.clientY - gesture.startClient.y
      );
      // Decide purely on the start→end travel distance, NOT on gesture.active.
      // A fast flick can go pointerdown → pointerup with zero pointermove events in
      // between, so `active` (only flipped inside pointermove) stays false even though
      // the pointer travelled a real box's worth of distance. Gating on `active` here
      // dropped those quick marquees. The start point was captured on pointerdown, so we
      // can resolve the selection rect from start/end alone regardless of `active`.
      if (distance < MARQUEE_SELECTION_MIN_DISTANCE) {
        // No real drag → treat as a plain pane click and let React Flow's onPaneClick
        // run (deselect on single click, open the node menu on double click).
        clearMarqueeSelection();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const startFlow = reactFlowInstance.screenToFlowPosition(gesture.startClient);
      const endFlow = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const selectionRect = {
        x: Math.min(startFlow.x, endFlow.x),
        y: Math.min(startFlow.y, endFlow.y),
        width: Math.abs(endFlow.x - startFlow.x),
        height: Math.abs(endFlow.y - startFlow.y),
      };
      // Hit-test in ABSOLUTE flow coords. `node.position` is parent-relative for
      // grouped nodes (e.g. preset-projection children), so testing it raw against the
      // absolute selectionRect made the marquee silently miss every grouped node even
      // when the box visibly covered them. resolveAbsolutePosition walks the parent
      // chain; for top-level nodes it returns node.position unchanged.
      const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
      const hitIds = new Set(
        nodes
          .filter((node) => {
            const size = getNodeSize(node);
            const absolute = resolveAbsolutePosition(node, nodeMap);
            return rectsIntersect(selectionRect, {
              x: absolute.x,
              y: absolute.y,
              width: size.width,
              height: size.height,
            });
          })
          .map((node) => node.id)
      );
      // When the box also touches a group that ENCLOSES some of the touched nodes, drop
      // that container group and keep the inner nodes: "the box touched it, so select it"
      // means the asset nodes the user sees, not the protected projection container that
      // happens to wrap them — and selecting a parent together with its child makes React
      // Flow apply the drag delta to both, double-moving the child. Any hit node that is an
      // ancestor of another hit node is treated as such a container and removed.
      const ancestorsOfHits = new Set<string>();
      for (const id of hitIds) {
        const visited = new Set<string>();
        let parentId = nodeMap.get(id)?.parentId;
        while (parentId && !visited.has(parentId)) {
          visited.add(parentId);
          if (hitIds.has(parentId)) {
            ancestorsOfHits.add(parentId);
          }
          parentId = nodeMap.get(parentId)?.parentId;
        }
      }
      const selectedIds = new Set(
        [...hitIds].filter((id) => !ancestorsOfHits.has(id))
      );

      const changes = nodes
        .filter((node) => Boolean(node.selected) !== selectedIds.has(node.id))
        .map((node) => ({
          id: node.id,
          type: 'select' as const,
          selected: selectedIds.has(node.id),
        }));
      if (changes.length > 0) {
        applyNodesChange(changes);
      }
      // Surface React Flow's native selection frame (.react-flow__nodesselection-rect,
      // styled as the white dashed box in index.css) around the right-drag result,
      // matching Ctrl/⌘ box-select. Programmatic selection alone never sets this flag,
      // so we set it explicitly; the nodes-prop reconcile keeps it true while ≥1 node
      // stays selected, and the native pane-click path clears it like any other selection.
      reactFlowStore.setState({ nodesSelectionActive: selectedIds.size > 0 });
      setSelectedNode(selectedIds.size === 1 ? Array.from(selectedIds)[0] : null);
      // The browser fires a `click` on the pane right after this drag (mousedown + mouseup
      // share the pane as target). React Flow's Pane onClick runs resetSelectedElements()
      // unconditionally, which would wipe the selection we just applied. Swallow that one
      // click at the capture phase (handleClickCapture) before React Flow ever sees it.
      swallowMarqueeClickRef.current = true;
      clearMarqueeSelection();
    };

    const handleClickCapture = (event: MouseEvent) => {
      if (!swallowMarqueeClickRef.current) {
        return;
      }
      swallowMarqueeClickRef.current = false;
      // Stop the event during capture so it never reaches React Flow's Pane onClick (and
      // thus never triggers resetSelectedElements / nodesSelectionActive=false).
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = marqueeSelectionRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      clearMarqueeSelection();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!isCanvasPaneTarget(event.target, wrapperElement)) {
        return;
      }
      if (pendingNodePlacement) {
        event.preventDefault();
        return;
      }
      // Right-click on the empty canvas opens the canvas context menu (undo/redo/paste).
      event.preventDefault();
      const containerRect = wrapperElement.getBoundingClientRect();
      const snapshot = copiedSnapshotRef.current;
      setContextMenu({
        x: event.clientX - containerRect.left,
        y: event.clientY - containerRect.top,
        clientX: event.clientX,
        clientY: event.clientY,
        canUndo: useCanvasStore.getState().history.past.length > 0,
        canRedo: useCanvasStore.getState().history.future.length > 0,
        canPaste: (snapshot?.nodes.length ?? 0) > 0,
      });
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    wrapperElement.addEventListener('contextmenu', handleContextMenu, true);
    wrapperElement.addEventListener('click', handleClickCapture, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);

    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      wrapperElement.removeEventListener('contextmenu', handleContextMenu, true);
      wrapperElement.removeEventListener('click', handleClickCapture, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [
    applyNodesChange,
    clearMarqueeSelection,
    nodes,
    openNodeMenuAtClientPosition,
    pendingNodePlacement,
    reactFlowInstance,
    reactFlowStore,
    setContextMenu,
    setSelectedNode,
  ]);

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => Boolean(node.selected)).map((node) => node.id),
    [nodes]
  );
  const selectedUploadNodeId = useMemo(() => {
    if (selectedNodeIds.length !== 1) {
      return null;
    }
    const selectedNode = nodes.find((node) => node.id === selectedNodeIds[0]);
    if (!selectedNode || selectedNode.type !== CANVAS_NODE_TYPES.upload) {
      return null;
    }
    return selectedNode.id;
  }, [nodes, selectedNodeIds]);

  useEffect(() => {
    if (selectedNodeIds.length === 1) {
      if (selectedNodeId !== selectedNodeIds[0]) {
        setSelectedNode(selectedNodeIds[0]);
      }
      return;
    }

    if (selectedNodeId !== null) {
      setSelectedNode(null);
    }
  }, [selectedNodeId, selectedNodeIds, setSelectedNode]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      pasteImageHandledRef.current = false;
      if (isTypingTarget(event.target) || isImmersiveViewerActive()) {
        return;
      }

      // 选中了上传节点：剪贴板里的图片直接贴进该节点（原有行为）。
      if (selectedUploadNodeId) {
        const imageFile = resolveClipboardImageFile(event);
        if (imageFile) {
          event.preventDefault();
          pasteImageHandledRef.current = true;
          canvasEventBus.publish('upload-node/paste-image', {
            nodeId: selectedUploadNodeId,
            file: imageFile,
          });
          return;
        }
      }

      // 系统剪贴板里的图片 / 视频 / 音频 → 在光标处生成上传节点。
      // 与「粘贴节点快照」的优先级裁决靠 ⌘C 复制节点时清空系统剪贴板实现：
      // 复制节点后剪贴板里不再有媒体文件，这里自然落空、让位给快照粘贴。
      // clipboardData 就是 DataTransfer，直接复用文件拖放的收集与生成管线。
      const mediaFiles = event.clipboardData
        ? collectDroppedMediaFiles(event.clipboardData)
        : [];
      if (mediaFiles.length === 0) {
        return;
      }

      event.preventDefault();
      pasteImageHandledRef.current = true;

      const wrapperElement = wrapperRef.current;
      const fallbackRect = wrapperElement
        ?.querySelector<HTMLElement>('.react-flow__pane')
        ?.getBoundingClientRect()
        ?? wrapperElement?.getBoundingClientRect();
      const clientPosition = lastCanvasPointerClientPositionRef.current
        ?? (fallbackRect
          ? {
              x: fallbackRect.left + fallbackRect.width / 2,
              y: fallbackRect.top + fallbackRect.height / 2,
            }
          : null);
      if (!clientPosition) {
        return;
      }
      const basePosition = reactFlowInstance.screenToFlowPosition(clientPosition);

      let lastNodeId: string | null = null;
      mediaFiles.forEach((file, index) => {
        const position = {
          x: basePosition.x + index * 36,
          y: basePosition.y + index * 36,
        };
        // 与文件拖放同样标记 user_spawned，见 handleCanvasDrop 的说明。
        const newNodeId = addNode(
          CANVAS_NODE_TYPES.upload,
          position,
          { user_spawned: true } as Partial<CanvasNodeData>,
        );
        lastNodeId = newNodeId;
        requestAnimationFrame(() => {
          canvasEventBus.publish('upload-node/external-file', { nodeId: newNodeId, file });
        });
      });

      if (lastNodeId) {
        setSelectedNode(lastNodeId);
      }
      scheduleCanvasPersist(0);
    };

    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('paste', handlePaste);
    };
  }, [
    addNode,
    reactFlowInstance,
    scheduleCanvasPersist,
    selectedUploadNodeId,
    setSelectedNode,
  ]);

  const handleOrganizeCanvas = useCallback(() => {
    const { positions, changedCount } = computeAutoLayout(nodes, edges);
    if (Object.keys(positions).length === 0) {
      return;
    }
    if (changedCount > 0) {
      setNodePositions(positions);
      scheduleCanvasPersist(0);
    }
    window.requestAnimationFrame(() => {
      reactFlowInstance.fitView({ duration: 240, padding: 0.2 });
    });
  }, [edges, nodes, reactFlowInstance, scheduleCanvasPersist, setNodePositions]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }
      // 沉浸式查看器(3GS 导演台全屏)打开时由它独占键盘(放置/删除 marker 等);
      // 画布的全局快捷键(Delete 删节点 / 复制粘贴等)让位,避免「删假人却删了 3D 节点」。
      if (isImmersiveViewerActive()) {
        return;
      }

      const commandPressed = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const isUndo = commandPressed && key === 'z' && !event.shiftKey;
      const isRedo = commandPressed && (key === 'y' || (key === 'z' && event.shiftKey));
      const isGroup = commandPressed && key === 'g';
      const isCopy = commandPressed && key === 'c' && !event.shiftKey;
      const isPaste = commandPressed && key === 'v' && !event.shiftKey;
      const isOrganize = event.altKey && event.shiftKey && key === 'f' && !commandPressed;

      if (event.key === 'Escape') {
        if (pendingNodePlacement) {
          event.preventDefault();
          cancelNodePlacement();
          return;
        }
        if (showNodeMenu) {
          event.preventDefault();
          closeNodeMenu();
        }
        return;
      }

      if (isOrganize) {
        event.preventDefault();
        handleOrganizeCanvas();
        return;
      }

      if (isCopy) {
        if (selectedNodeIds.length === 0) {
          return;
        }
        event.preventDefault();
        const selectedIdSet = new Set(selectedNodeIds);
        // Deep-clone into a self-contained snapshot so paste no longer depends
        // on the originals still existing, and mirror it to the module-level
        // clipboard for cross-canvas paste.
        const snapshot: ClipboardSnapshot = {
          nodes: nodes
            .filter((node) => selectedIdSet.has(node.id))
            .map((node) => ({
              ...node,
              data: cloneNodeData(node.data),
              selected: false,
              dragging: false,
            })),
          edges: edges
            .filter(
              (edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target)
            )
            .map((edge) => ({ ...edge })),
          sourceProject: readUrl().project ?? null,
        };
        copiedSnapshotRef.current = snapshot;
        sharedNodeClipboard = snapshot;
        pasteIterationRef.current = 0;
        // 清空系统剪贴板（写空串会整体替换剪贴板内容，旧的图片/文件随之清掉），
        // 维持「最近一次复制赢」的标准语义——否则更早复制的系统图片会在 ⌘V 时
        // 永远抢在节点粘贴前面。写空串而非标记文本：标记会作为字面量泄漏进任何
        // 文本粘贴目标（站内输入框 / 外部应用）。写失败（权限/焦点）无妨，只是
        // 退化为「剪贴板里有媒体文件就先贴文件」。
        void navigator.clipboard?.writeText('').catch(() => undefined);
        return;
      }

      if (isPaste) {
        // 不能在这里 preventDefault / 立即贴快照：要让 paste 事件先触发，
        // 由它裁决系统剪贴板里的媒体文件（贴进选中的上传节点，或生成新
        // 上传节点）。处理过则置 pasteImageHandledRef，这里就不再贴节点快照。
        pasteImageHandledRef.current = false;
        window.setTimeout(() => {
          if (pasteImageHandledRef.current) {
            pasteImageHandledRef.current = false;
            return;
          }
          if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
            return;
          }
          pasteFromClipboardRef.current?.(copiedSnapshotRef.current);
        }, 0);
        return;
      }

      if (isUndo || isRedo) {
        event.preventDefault();
        const changed = isUndo ? undo() : redo();
        if (changed) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (isGroup) {
        if (selectedNodeIds.length < 2) {
          return;
        }
        event.preventDefault();
        const createdGroupId = groupNodes(selectedNodeIds);
        if (createdGroupId) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return;
      }

      // 选中的连线也支持快捷键删除:剔除 preset-managed 锁定的连线,
      // 与双击断开(handleEdgeDoubleClick)用同一套锁定规则。读 getState()
      // 取最新 edges,避免 keydown 闭包里拿到陈旧的选中状态。
      const allEdges = useCanvasStore.getState().edges;
      const deletableEdgeIds = allEdges
        .filter((edge) => edge.selected && !isPresetManagedEdge(edge))
        .map((edge) => edge.id);
      const hasSelectedEdge = allEdges.some((edge) => edge.selected);

      const idsToDelete = selectedNodeIds.length > 0
        ? selectedNodeIds
        : selectedNodeId
          ? [selectedNodeId]
          : [];

      const lockedNodeIds = new Set(nodes.filter(isPresetManagedNode).map((node) => node.id));
      const deletableNodeIds = idsToDelete.filter((nodeId) => !lockedNodeIds.has(nodeId));

      if (deletableNodeIds.length === 0 && deletableEdgeIds.length === 0) {
        // 有选中目标(哪怕全被锁定)时仍吞掉默认行为,避免退格触发浏览器返回。
        if (idsToDelete.length > 0 || hasSelectedEdge) {
          event.preventDefault();
        }
        return;
      }

      event.preventDefault();
      deletableEdgeIds.forEach((edgeId) => deleteEdge(edgeId));
      if (deletableNodeIds.length === 1) {
        deleteNode(deletableNodeIds[0]);
      } else if (deletableNodeIds.length > 1) {
        deleteNodes(deletableNodeIds);
      }
      scheduleCanvasPersist(0);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    selectedNodeId,
    selectedNodeIds,
    deleteNode,
    deleteNodes,
    deleteEdge,
    groupNodes,
    undo,
    redo,
    scheduleCanvasPersist,
    handleOrganizeCanvas,
    showNodeMenu,
    closeNodeMenu,
    pendingNodePlacement,
    cancelNodePlacement,
  ]);

  const handlePaneClick = useCallback((event: ReactMouseEvent) => {
    if (pendingNodePlacement) {
      commitNodePlacementAtClientPosition({ x: event.clientX, y: event.clientY });
      return;
    }

    if (suppressNextPaneClickRef.current) {
      suppressNextPaneClickRef.current = false;
      return;
    }

    if (event.detail >= 2) {
      openNodeMenuAtClientPosition({ x: event.clientX, y: event.clientY });
      suppressNextPaneClickRef.current = true;
      return;
    }

    setSelectedNode(null);
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
    onBlankPaneClick?.();
  }, [
    commitNodePlacementAtClientPosition,
    onBlankPaneClick,
    openNodeMenuAtClientPosition,
    pendingNodePlacement,
    setSelectedNode,
  ]);

  // 直接把图片 / 视频 / 音频文件从系统拖进画布 → 在落点生成上传节点并把文件喂给它。
  // UploadNode 会按文件类型自行处理：图片就地上传，视频 / 音频 morph 成对应节点。
  // 复用既有上传管道，无需在画布层重复实现上传 / 转码逻辑。
  const fileDragDepthRef = useRef(0);
  const [isFileDropActive, setIsFileDropActive] = useState(false);

  const hasDraggedFiles = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) =>
      Array.from(event.dataTransfer.types ?? []).includes('Files'),
    []
  );

  // 侧栏素材卡片拖进画布时携带的自定义 MIME(见 assetDrag.ts)。
  const hasDraggedAsset = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) =>
      Array.from(event.dataTransfer.types ?? []).includes(CANVAS_ASSET_DRAG_MIME),
    []
  );

  const hasDraggedAnyPayload = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) =>
      hasDraggedFiles(event) || hasDraggedAsset(event),
    [hasDraggedFiles, hasDraggedAsset]
  );

  const handleCanvasDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedAnyPayload(event)) {
        return;
      }
      event.preventDefault();
      fileDragDepthRef.current += 1;
      setIsFileDropActive(true);
    },
    [hasDraggedAnyPayload, hasDraggedFiles]
  );

  const handleCanvasDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedAnyPayload(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [hasDraggedAnyPayload]
  );

  const handleCanvasDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedAnyPayload(event)) {
        return;
      }
      fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
      if (fileDragDepthRef.current === 0) {
        setIsFileDropActive(false);
      }
    },
    [hasDraggedAnyPayload]
  );

  const handleCanvasDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedAnyPayload(event)) {
        return;
      }
      event.preventDefault();
      fileDragDepthRef.current = 0;
      setIsFileDropActive(false);

      const basePosition = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      // ── Sidebar asset drop path ──
      // 侧栏素材卡片(图片 / 视频 / 音频 / 3GS)拖进来 → 在落点直接生成对应节点。
      // 与「加入」按钮共用 spawnAssetNode,保持节点构造一致。
      const assetPayload = readAssetDragPayload(event.dataTransfer);
      if (assetPayload) {
        void (async () => {
          let hydratedPayload = assetPayload;
          try {
            hydratedPayload = await hydrateAssetDragPayload(assetPayload);
          } catch (error) {
            console.warn('[canvas] scene director world manifest unavailable during import', error);
          }
          const newNodeId = spawnAssetNode(
            useCanvasStore.getState(),
            hydratedPayload,
            basePosition,
          );
          setSelectedNode(newNodeId);
          scheduleCanvasPersist(0);
        })();
        return;
      }

      // ── File drop path ──
      // Files become uploadNode spawns. Pre-existing behavior; preserved on
      // every canvas now that the mainline preset reject is lifted.
      const mediaFiles = collectDroppedMediaFiles(event.dataTransfer);
      if (mediaFiles.length === 0) {
        return;
      }

      let lastNodeId: string | null = null;
      mediaFiles.forEach((file, index) => {
        const position = {
          x: basePosition.x + index * 36,
          y: basePosition.y + index * 36,
        };
        // File drops are user actions by definition — stamp user_spawned: true
        // so the new node is correctly classified by `nodeMainlineFlags` and
        // survives `_merge_restored_preset_canvas` refresh (the backend's
        // `_is_replaceable_projection_node` refuses to overwrite it).
        //
        // NB: this is NOT about unlocking. The canvas-level fallback that used
        // to lock unmarked nodes on preset canvases is gone — NodeActionToolbar
        // now locks on `isPresetManaged` alone, and an unmarked node classifies
        // as "ordinary" (see system-managed-node-data.test.ts).
        const newNodeId = addNode(
          CANVAS_NODE_TYPES.upload,
          position,
          { user_spawned: true } as Partial<CanvasNodeData>,
        );
        lastNodeId = newNodeId;
        // 等新节点挂载并订阅事件后再投递文件（与 UploadNode 内部 morph 的时序一致）。
        requestAnimationFrame(() => {
          canvasEventBus.publish('upload-node/external-file', { nodeId: newNodeId, file });
        });
      });

      if (lastNodeId) {
        setSelectedNode(lastNodeId);
      }
      scheduleCanvasPersist(0);
    },
    [
      addNode,
      hasDraggedAnyPayload,
      reactFlowInstance,
      scheduleCanvasPersist,
      setSelectedNode,
    ]
  );

  // 文件落在「节点」上(而非空白画布)时,由该节点自己的 onDrop 处理,且会
  // stopPropagation —— 画布层的 handleCanvasDrop 收不到,于是「释放以添加到画布」
  // 蒙层得不到复位,要刷新才消失。这里在 window 捕获阶段兜底复位:捕获先于任何
  // 节点的 stopPropagation,无论 drop 落在页面哪处都能可靠清掉蒙层状态。
  useEffect(() => {
    const resetFileDrop = () => {
      fileDragDepthRef.current = 0;
      setIsFileDropActive(false);
    };
    window.addEventListener('drop', resetFileDrop, true);
    window.addEventListener('dragend', resetFileDrop, true);
    return () => {
      window.removeEventListener('drop', resetFileDrop, true);
      window.removeEventListener('dragend', resetFileDrop, true);
    };
  }, []);

  const finalizeNodeSpawn = useCallback(
    (newNodeId: string, explicitSkill?: SkillDefinition | null) => {
      if (pendingBatchConnectIds && pendingBatchConnectIds.length > 0) {
        // Batch "+": fan every selected source node into the freshly spawned node.
        for (const sourceId of pendingBatchConnectIds) {
          connectGraphNodes(
            {
              source: sourceId,
              target: newNodeId,
              sourceHandle: 'source',
              targetHandle: 'target',
            },
            explicitSkill,
          );
        }
      } else if (pendingConnectStart) {
        if (pendingConnectStart.handleType === 'source') {
          connectGraphNodes(
            {
              source: pendingConnectStart.nodeId,
              target: newNodeId,
              sourceHandle: 'source',
              targetHandle: 'target',
            },
            explicitSkill,
          );
        } else {
          connectGraphNodes(
            {
              source: newNodeId,
              target: pendingConnectStart.nodeId,
              sourceHandle: 'source',
              targetHandle: 'target',
            },
            explicitSkill,
          );
        }
      }

      scheduleCanvasPersist(0);
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPendingBatchConnectIds(null);
      setPreviewConnectionVisual(null);
    },
    [
      connectGraphNodes,
      pendingBatchConnectIds,
      pendingConnectStart,
      scheduleCanvasPersist,
      setPreviewConnectionVisual,
    ],
  );

  const handleNodeSelect = useCallback(
    (type: CanvasNodeType, selectionClientPosition?: { x: number; y: number }) => {
      // 「上传资源」改成直接在画布生成一个空的上传节点；选择具体文件
      // （图片 / 视频）由节点内部 UI 负责，并根据文件类型自行 morph 成
      // video 节点。这样画布菜单的所有入口都保持一致：点选即生成节点。
      let initialData: Partial<Record<string, unknown>> | undefined;
      if (pendingConnectStart && type === CANVAS_NODE_TYPES.imageEdit) {
        initialData = { generationMode: 'image_reference', requestAspectRatio: 'auto' };
      } else if (
        pendingConnectStart
        && pendingConnectStart.handleType === 'target'
        && type === CANVAS_NODE_TYPES.upload
      ) {
        // 从 imageGen 的 target handle 拖出来 → 点「图片」落到 upload 节点
        // 时，按「上传图片」语义初始化（同步 ImageGen 的 spawn-upstream-image
        // 按钮：拒视频）。
        const originNode = nodes.find((node) => node.id === pendingConnectStart.nodeId);
        if (originNode?.type === CANVAS_NODE_TYPES.imageGen) {
          initialData = { imageOnly: true };
        }
      }

      const isPlainAddNodeMenu =
        !pendingConnectStart && !pendingBatchConnectIds && !menuAllowedTypes;
      if (isPlainAddNodeMenu) {
        const containerRect = wrapperRef.current?.getBoundingClientRect();
        const fallbackClientPosition = containerRect
          ? {
              x: containerRect.left + menuPosition.x,
              y: containerRect.top + menuPosition.y,
            }
          : null;
        const clientPosition =
          selectionClientPosition ??
          lastCanvasPointerClientPositionRef.current ??
          fallbackClientPosition;
        setShowNodeMenu(false);
        setMenuAllowedTypes(undefined);
        setPendingNodePlacement({ type, initialData });
        setNodePlacementClientPosition(clientPosition);
        setSelectedNode(null);
        suppressNextPaneClickRef.current = false;
        return;
      }

      const newNodeId = addNode(type, flowPosition, initialData);
      finalizeNodeSpawn(newNodeId);
    },
    [
      addNode,
      finalizeNodeSpawn,
      flowPosition,
      menuAllowedTypes,
      menuPosition.x,
      menuPosition.y,
      nodes,
      pendingBatchConnectIds,
      pendingConnectStart,
      setSelectedNode,
    ]
  );

  const handleSkillSelect = useCallback(
    (skill: SkillDefinition) => {
      const initialData = {
        skill_id: skill.id,
        skill_schema_version: skill.schema_version ?? SKILL_SCHEMA_VERSION,
        displayName: skill.display_name,
      } as Partial<CanvasNodeData>;
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const fallbackClientPosition = containerRect
        ? {
            x: containerRect.left + menuPosition.x,
            y: containerRect.top + menuPosition.y,
          }
        : null;
      const clientPosition =
        lastCanvasPointerClientPositionRef.current ??
        fallbackClientPosition;
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingNodePlacement({
        type: CANVAS_NODE_TYPES.skill,
        initialData,
        skill,
      });
      setNodePlacementClientPosition(clientPosition);
      setSelectedNode(null);
      suppressNextPaneClickRef.current = false;
    },
    [
      menuPosition.x,
      menuPosition.y,
      setSelectedNode,
    ],
  );

  // Bottom quick-action bar spawns at the current viewport center (no click /
  // pending-connect context), unlike the right-click / double-click menu which
  // drops the node at the cursor.
  const spawnAtViewportCenter = useCallback((): { x: number; y: number } => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const center = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return reactFlowInstance.screenToFlowPosition(center);
  }, [reactFlowInstance]);

  const handleQuickAddNode = useCallback(
    (type: CanvasNodeType) => {
      const newNodeId = addNode(type, spawnAtViewportCenter());
      setSelectedNode(newNodeId);
      scheduleCanvasPersist(0);
    },
    [addNode, scheduleCanvasPersist, setSelectedNode, spawnAtViewportCenter],
  );

  const handleQuickAddSkill = useCallback(
    (skill: SkillDefinition) => {
      const newNodeId = addNode(CANVAS_NODE_TYPES.skill, spawnAtViewportCenter(), {
        skill_id: skill.id,
        skill_schema_version: skill.schema_version ?? SKILL_SCHEMA_VERSION,
        displayName: skill.display_name,
      } as Partial<CanvasNodeData>);
      setSelectedNode(newNodeId);
      bindSingleBeatContextInput(newNodeId, skill);
      scheduleCanvasPersist(0);
    },
    [addNode, bindSingleBeatContextInput, scheduleCanvasPersist, setSelectedNode, spawnAtViewportCenter],
  );

  // 历史资产弹窗「使用」：把该资产作为新节点生成到视口中心（复用素材落点的 spawnAssetNode）。
  // 批量使用时传 placement，把多个新节点在视口中心附近铺成网格，避免全部叠在同一点。
  const handleUseHistoryAsset = useCallback(
    (asset: CanvasAsset, placement?: { index: number; total: number }) => {
      const payload: CanvasAssetDragPayload = {
        kind: asset.kind,
        label: asset.label ?? '',
        // 历史记录里存的原始提示词，回填到新建视频节点的提示词框（见 spawnAssetNode）。
        prompt: asset.prompt ?? undefined,
        url: asset.url,
        // 世界模型节点用 coverUrl 当封面（previewImageUrl）；其余类型无封面。
        coverUrl: asset.kind === 'model' ? asset.previewUrl : null,
        // 历史「使用」还原的是生成产物：图片应还原成成品「图片节点」(imageGen)——
        // 带回提示词、展开操作区、按图自适应比例，而非只读的上传参考图节点（见 spawnAssetNode）。
        restoreAsGeneratedImage: true,
        // 原始生成的注册表模型 id / 生成模式,透传给还原节点以复现原次生成配置
        // （视频写回 data.model+data.genMode；图片写回 data.model）。旧记录为 undefined。
        model: asset.model ?? undefined,
        genMode: asset.genMode ?? undefined,
        source: {},
      };
      const origin = spawnAtViewportCenter();
      // 网格铺开：每行最多 4 个，格间距 320，整体大致以视口中心为中心。
      const position =
        placement && placement.total > 1
          ? (() => {
              const perRow = Math.min(4, placement.total);
              const gap = 320;
              const col = placement.index % perRow;
              const row = Math.floor(placement.index / perRow);
              const rows = Math.ceil(placement.total / perRow);
              return {
                x: origin.x + (col - (perRow - 1) / 2) * gap,
                y: origin.y + (row - (rows - 1) / 2) * gap,
              };
            })()
          : origin;
      const newNodeId = spawnAssetNode(useCanvasStore.getState(), payload, position);
      setSelectedNode(newNodeId);
      scheduleCanvasPersist(0);
    },
    [scheduleCanvasPersist, setSelectedNode, spawnAtViewportCenter],
  );

  // 历史资产弹窗「删除」：从画布移除该资产对应的源节点。
  const handleDeleteHistoryNode = useCallback(
    (nodeId: string) => {
      deleteNode(nodeId);
      scheduleCanvasPersist(0);
    },
    [deleteNode, scheduleCanvasPersist],
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}) => {
      // Source is either a serialized clipboard snapshot (paste) or live nodes
      // looked up by id (duplicate / 创建副本).
      const snapshot = options.sourceSnapshot;
      const sourceNodes = snapshot
        ? snapshot.nodes
        : nodes.filter((node) => sourceNodeIds.includes(node.id));
      if (sourceNodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceIdSet = new Set(sourceNodes.map((node) => node.id));
      const internalEdges = snapshot
        ? snapshot.edges
        : edges.filter(
            (edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target)
          );

      // Cursor paste: lay the group out with its top-left at the target flow
      // position instead of the offset-from-original layout used by duplicate.
      const targetPos = options.targetFlowPosition;
      const groupMinX = targetPos
        ? Math.min(...sourceNodes.map((node) => node.position.x))
        : 0;
      const groupMinY = targetPos
        ? Math.min(...sourceNodes.map((node) => node.position.y))
        : 0;

      const baseOffsets = [
        { x: 44, y: 30 },
        { x: 72, y: 8 },
        { x: 18, y: 68 },
        { x: 96, y: 42 },
      ];
      const existingNodes = useCanvasStore.getState().nodes;
      const ignoreNodeIds = new Set<string>();
      const offsetStep = options.disableOffsetIteration ? 0 : pasteIterationRef.current;
      let chosenOffset = options.explicitOffset ?? baseOffsets[0];

      const isOffsetAvailable = (offset: { x: number; y: number }) => sourceNodes.every((node) => {
        const size = getNodeSize(node);
        return !hasRectCollision(
          {
            x: node.position.x + offset.x + offsetStep * 8,
            y: node.position.y + offset.y + offsetStep * 6,
            width: size.width,
            height: size.height,
          },
          existingNodes,
          ignoreNodeIds
        );
      });

      if (!targetPos && !options.explicitOffset) {
        const matchedBaseOffset = baseOffsets.find((offset) => isOffsetAvailable(offset));
        if (matchedBaseOffset) {
          chosenOffset = matchedBaseOffset;
        } else {
          const maxStep = 16;
          for (let step = 1; step <= maxStep; step += 1) {
            const candidate = { x: 24 + step * 26, y: 16 + step * 18 };
            if (isOffsetAvailable(candidate)) {
              chosenOffset = candidate;
              break;
            }
          }
        }
      }

      const idMap = new Map<string, string>();
      const sizeMap = new Map<string, { width: number; height: number }>();
      const pastedForMigration: Array<{ id: string; data: CanvasNodeData }> = [];
      for (const sourceNode of sourceNodes) {
        const data = cloneNodeData(sourceNode.data);
        if ('isGenerating' in (data as Record<string, unknown>)) {
          (data as { isGenerating?: boolean }).isGenerating = false;
        }
        if ('generationStartedAt' in (data as Record<string, unknown>)) {
          (data as { generationStartedAt?: number | null }).generationStartedAt = null;
        }
        if ('generationJobId' in (data as Record<string, unknown>)) {
          (data as { generationJobId?: string | null }).generationJobId = null;
        }
        if ('generationProviderId' in (data as Record<string, unknown>)) {
          (data as { generationProviderId?: string | null }).generationProviderId = null;
        }
        if ('generationClientSessionId' in (data as Record<string, unknown>)) {
          (data as { generationClientSessionId?: string | null }).generationClientSessionId = null;
        }
        if ('generationStoryboardMetadata' in (data as Record<string, unknown>)) {
          (data as { generationStoryboardMetadata?: unknown }).generationStoryboardMetadata = undefined;
        }
        if ('generationError' in (data as Record<string, unknown>)) {
          (data as { generationError?: string | null }).generationError = null;
        }
        if ('generationErrorDetails' in (data as Record<string, unknown>)) {
          (data as { generationErrorDetails?: string | null }).generationErrorDetails = null;
        }
        if ('generationDebugContext' in (data as Record<string, unknown>)) {
          (data as { generationDebugContext?: unknown }).generationDebugContext = undefined;
        }

        const position = targetPos
          ? {
              x: targetPos.x + (sourceNode.position.x - groupMinX),
              y: targetPos.y + (sourceNode.position.y - groupMinY),
            }
          : {
              x: sourceNode.position.x + chosenOffset.x + offsetStep * 8,
              y: sourceNode.position.y + chosenOffset.y + offsetStep * 6,
            };
        const nextNodeId = addNode(
          sourceNode.type as CanvasNodeType,
          position,
          { ...data }
        );
        idMap.set(sourceNode.id, nextNodeId);
        sizeMap.set(nextNodeId, getNodeSize(sourceNode));
        pastedForMigration.push({ id: nextNodeId, data });
      }

      const sizeSyncChanges = Array.from(sizeMap.entries()).map(([nodeId, size]) => ({
        id: nodeId,
        type: 'dimensions' as const,
        dimensions: { width: size.width, height: size.height },
        resizing: false,
        setAttributes: true,
      }));
      if (sizeSyncChanges.length > 0) {
        applyNodesChange(sizeSyncChanges);
      }

      for (const edge of internalEdges) {
        const nextSource = idMap.get(edge.source);
        const nextTarget = idMap.get(edge.target);
        if (!nextSource || !nextTarget) {
          continue;
        }
        connectNodes({
          source: nextSource,
          target: nextTarget,
          sourceHandle: edge.sourceHandle ?? 'source',
          targetHandle: edge.targetHandle ?? 'target',
        });
      }

      if (!options.disableOffsetIteration && !targetPos) {
        pasteIterationRef.current += 1;
      }
      const firstNodeId = idMap.get(sourceNodes[0].id) ?? null;
      if (!options.suppressSelect) {
        if (options.selectAll && idMap.size > 0) {
          // Select the whole pasted group (and deselect the originals) so it can
          // be dragged immediately — same selection model as a box-select.
          const pastedIds = new Set(idMap.values());
          applyNodesChange(
            useCanvasStore
              .getState()
              .nodes.filter(
                (node) => Boolean(node.selected) !== pastedIds.has(node.id),
              )
              .map((node) => ({
                id: node.id,
                type: 'select' as const,
                selected: pastedIds.has(node.id),
              })),
          );
          setSelectedNode(pastedIds.size === 1 ? firstNodeId : null);
        } else if (firstNodeId) {
          setSelectedNode(firstNodeId);
        }
      }
      if (!options.suppressPersist) {
        scheduleCanvasPersist(0);
      }

      // 跨项目粘贴：把节点里指向「源项目」的媒体资产重新上传到当前项目，完成后静默
      // 改写 URL。后台执行、不阻塞粘贴；单条失败保留原 URL 并提示。仅当来自序列化
      // 剪贴板（paste）且源项目与当前项目不同才触发——同项目复制/副本无需迁移。
      const sourceProject = snapshot?.sourceProject ?? null;
      const currentProject = readUrl().project ?? null;
      if (
        sourceProject
        && currentProject
        && sourceProject !== currentProject
        && pastedForMigration.length > 0
      ) {
        void migratePastedNodeAssets({
          nodes: pastedForMigration,
          targetProject: currentProject,
          getLiveNodeData: (nodeId) =>
            useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data ?? null,
          updateNodeData,
        })
          .then(({ migrated, failed }) => {
            if (failed > 0) {
              toast.error(t('canvas.crossProjectAssets.partialFailure', { count: failed }));
            } else if (migrated > 0) {
              toast.success(t('canvas.crossProjectAssets.success', { count: migrated }));
            }
            if (migrated > 0) {
              scheduleCanvasPersist(0);
            }
          })
          .catch((error) => {
            console.warn('[canvas] cross-project asset migration failed', error);
          });
      }

      return { firstNodeId, idMap };
    },
    [
      addNode,
      applyNodesChange,
      connectNodes,
      edges,
      nodes,
      scheduleCanvasPersist,
      setSelectedNode,
      t,
      updateNodeData,
    ]
  );

  // Paste the clipboard snapshot as fresh, self-contained nodes. `targetFlow`
  // (cursor flow position) lays the group out under the cursor; without it the
  // group is offset from its copied position (keyboard paste).
  const pasteFromClipboard = useCallback(
    (
      snapshot: ClipboardSnapshot | null,
      targetFlow?: { x: number; y: number },
    ): string | null => {
      if (!snapshot || snapshot.nodes.length === 0) {
        return null;
      }
      return (
        duplicateNodes([], {
          sourceSnapshot: snapshot,
          targetFlowPosition: targetFlow,
          selectAll: true,
        })?.firstNodeId ?? null
      );
    },
    [duplicateNodes],
  );

  // Keep a ref so the keyboard handler can paste without re-binding on every
  // node change (mirrors `duplicateNodesRef`).
  useEffect(() => {
    pasteFromClipboardRef.current = pasteFromClipboard;
  }, [pasteFromClipboard]);

  const handleConnectStart = useCallback(
    (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPreviewConnectionVisual(null);

      if (!params.nodeId || !params.handleType) {
        setPendingConnectStart(null);
        return;
      }

      // 拖线起点是 source handle 时，只要存在「至少一种合法的下游节点类型」就允许开拽；
      // 实际连接合法性会在 onConnect 里按目标类型再次校验。
      if (
        params.handleType === 'source'
        && !canNodeBeManualConnectionSource(params.nodeId, nodes)
        && !canNodeBeManualConnectionSource(
          params.nodeId,
          nodes,
          CANVAS_NODE_TYPES.threeDWorld,
        )
      ) {
        setPendingConnectStart(null);
        return;
      }

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const eventTarget = event.target as Element | null;
      const handleElement = eventTarget?.closest?.('.react-flow__handle') as HTMLElement | null;
      const clientPosition = getClientPosition(event);
      let start: { x: number; y: number } | undefined;
      if (containerRect && handleElement) {
        const handleRect = handleElement.getBoundingClientRect();
        start = {
          x: handleRect.left - containerRect.left + handleRect.width / 2,
          y: handleRect.top - containerRect.top + handleRect.height / 2,
        };
      } else if (containerRect && clientPosition) {
        start = {
          x: clientPosition.x - containerRect.left,
          y: clientPosition.y - containerRect.top,
        };
      }

      setPendingConnectStart({
        nodeId: params.nodeId,
        handleType: params.handleType,
        handleId: params.handleId,
        start,
      });
    },
    [nodes]
  );

  const handleNodeDragStart = useCallback(
    (event: ReactMouseEvent, node: CanvasNode, draggedNodes: CanvasNode[]) => {
      // 组内成员拖动：记下「所有被拖成员」（多选时第三参带全量）所属的组 id，松手时
      // 逐组按成员最终落点 fitGroupToChildren 重新包住（libtv 式，拖动期间不动框）。
      // 只看被抓节点会漏掉多选里其它组的成员 —— 它们没有 extent:'parent' 钳制，
      // 拖完不 refit 就永久悬在组框外。alt 复制拖动不参与（原节点回弹）。
      // parentId 从 store 读 —— React Flow 传给拖动回调的 node 参数是精简 drag item，
      // 可能不带 parentId，直接用 node.parentId 会取不到。
      groupFitDragRef.current = null;
      linkedDragRef.current = null;
      if (!event.altKey) {
        const stateNodes = useCanvasStore.getState().nodes;
        const dragged = draggedNodes?.length ? draggedNodes : [node];
        const groupIds = new Set<string>();
        for (const item of dragged) {
          const parentId = stateNodes.find((n) => n.id === item.id)?.parentId;
          if (parentId) groupIds.add(parentId);
        }
        if (groupIds.size > 0) {
          groupFitDragRef.current = { groupIds: [...groupIds] };
        }

        // 单节点拖动时,若被拖的是「导演世界」源节点或其「导演世界输出」组,记下另一方
        // 并准备按相同位移联动(多选/框选拖动不联动,交给用户自行摆放)。
        if (!draggedNodes || draggedNodes.length <= 1) {
          const stateEdges = useCanvasStore.getState().edges;
          const partnerIds = findLinkedCapturePartnerIds(node.id, stateNodes, stateEdges);
          if (partnerIds.length > 0) {
            const nodeById = new Map(stateNodes.map((n) => [n.id, n] as const));
            const draggedNode = nodeById.get(node.id);
            const partnerStarts = new Map<string, { x: number; y: number }>();
            for (const partnerId of partnerIds) {
              const partner = nodeById.get(partnerId);
              if (partner && !partner.parentId) {
                partnerStarts.set(partnerId, { x: partner.position.x, y: partner.position.y });
              }
            }
            if (draggedNode && partnerStarts.size > 0) {
              linkedDragRef.current = {
                partnerStarts,
                draggedStart: { x: draggedNode.position.x, y: draggedNode.position.y },
              };
            }
          }
        }
      }

      if (!event.altKey) {
        altDragCopyRef.current = null;
        return;
      }

      const sourceNodeIds = selectedNodeIds.includes(node.id)
        ? selectedNodeIds
        : [node.id];
      if (sourceNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }
      const startPositions = new Map<string, { x: number; y: number }>();
      for (const sourceNodeId of sourceNodeIds) {
        const sourceNode = nodes.find((item) => item.id === sourceNodeId);
        if (!sourceNode) {
          continue;
        }
        startPositions.set(sourceNodeId, {
          x: sourceNode.position.x,
          y: sourceNode.position.y,
        });
      }
      if (startPositions.size === 0) {
        altDragCopyRef.current = null;
        return;
      }

      const duplicateResult = duplicateNodes(sourceNodeIds, {
        explicitOffset: { x: 0, y: 0 },
        disableOffsetIteration: true,
        suppressPersist: true,
        suppressSelect: true,
      });
      if (!duplicateResult) {
        altDragCopyRef.current = null;
        return;
      }

      const copiedNodeIds = sourceNodeIds
        .map((sourceId) => duplicateResult.idMap.get(sourceId))
        .filter((id): id is string => Boolean(id));
      if (copiedNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }

      // Keep the duplicated nodes visually above the original dragged node.
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          if (!copiedNodeIds.includes(currentNode.id)) {
            return currentNode;
          }
          return {
            ...currentNode,
            zIndex: ALT_DRAG_COPY_Z_INDEX,
            style: {
              ...(currentNode.style ?? {}),
              zIndex: ALT_DRAG_COPY_Z_INDEX,
            },
          };
        }),
      }));

      altDragCopyRef.current = {
        sourceNodeIds,
        startPositions,
        copiedNodeIds,
        sourceToCopyIdMap: duplicateResult.idMap,
      };
    },
    [duplicateNodes, nodes, selectedNodeIds]
  );

  const handleNodeDrag = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      // 联动拖动:把 partner(源节点或输出组)按被拖节点的位移同步移动。移动组时
      // 其子节点(相对坐标)会自动跟随,无需额外处理。
      const linked = linkedDragRef.current;
      if (linked) {
        const linkDeltaX = node.position.x - linked.draggedStart.x;
        const linkDeltaY = node.position.y - linked.draggedStart.y;
        const linkChanges = [...linked.partnerStarts].map(([partnerId, start]) => ({
          id: partnerId,
          type: 'position' as const,
          position: { x: start.x + linkDeltaX, y: start.y + linkDeltaY },
          dragging: true as const,
        }));
        if (linkChanges.length > 0) {
          applyNodesChange(linkChanges);
        }
      }

      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const deltaX = node.position.x - startPosition.x;
      const deltaY = node.position.y - startPosition.y;

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const moveCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + deltaX, y: sourceStart.y + deltaY },
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...moveCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
    },
    [applyNodesChange]
  );

  const handleNodeDragStop = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      useSnapAlignStore.getState().clearGuides();
      snapAlignIndexRef.current = null;
      // 联动拖动收尾:partner 的最终位置已在拖动期间(dragging:true)写入,松手时
      // React Flow 对被拖节点发出的 dragging:false 变更会统一压入同一条撤销记录,
      // 故这里只需清掉引用,不再额外提交以免产生重复的 undo 步骤。
      linkedDragRef.current = null;
      // 组内成员拖动收尾（libtv 式）：按成员的最终落点把每个涉及的组框重新撑大包住
      //（fitGroupToChildren 含左/上方向的整体平移）。普通组成员不带 extent，可自由落点。
      const groupFit = groupFitDragRef.current;
      groupFitDragRef.current = null;
      if (groupFit) {
        const { fitGroupToChildren } = useCanvasStore.getState();
        for (const groupId of groupFit.groupIds) {
          fitGroupToChildren(groupId);
        }
      }
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }
      altDragCopyRef.current = null;

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const offset = {
        x: node.position.x - startPosition.x,
        y: node.position.y - startPosition.y,
      };

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const finalizeCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + offset.x, y: sourceStart.y + offset.y },
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...finalizeCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
      if (altCopyState.copiedNodeIds.length > 0) {
        setSelectedNode(altCopyState.copiedNodeIds[0]);
      }
      scheduleCanvasPersist(0);
    },
    [applyNodesChange, scheduleCanvasPersist, setSelectedNode]
  );

  // 拖「选区框」整体移动多选节点时，React Flow 走 onSelectionDrag* 而非 onNodeDrag*，
  // 组成员的 refit 同样要在这条路径上收尾，否则组成员被拖出框后无人包住。
  const handleSelectionDragStart = useCallback(
    (_event: ReactMouseEvent, draggedNodes: CanvasNode[]) => {
      const stateNodes = useCanvasStore.getState().nodes;
      const groupIds = new Set<string>();
      for (const item of draggedNodes) {
        const parentId = stateNodes.find((n) => n.id === item.id)?.parentId;
        if (parentId) groupIds.add(parentId);
      }
      groupFitDragRef.current =
        groupIds.size > 0 ? { groupIds: [...groupIds] } : null;
    },
    []
  );

  const handleSelectionDragStop = useCallback(() => {
    const groupFit = groupFitDragRef.current;
    groupFitDragRef.current = null;
    if (groupFit) {
      const { fitGroupToChildren } = useCanvasStore.getState();
      for (const groupId of groupFit.groupIds) {
        fitGroupToChildren(groupId);
      }
    }
  }, []);

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid || !pendingConnectStart) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const clientPosition = getClientPosition(event);
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!clientPosition || !containerRect) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const eventTarget = event.target as Element | null;
      const nodeElementFromTarget = eventTarget?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const nodeElementFromPoint = document.elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const dropNodeElement = nodeElementFromTarget ?? nodeElementFromPoint;
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;

      if (dropNodeId && dropNodeId !== pendingConnectStart.nodeId) {
        const sourceNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === pendingConnectStart.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pendingConnectStart.nodeId);

        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type, targetNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          const sourceHandle =
            pendingConnectStart.handleType === 'source'
              ? pendingConnectStart.handleId ?? 'source'
              : resolveConnectEndHandleId({
                  eventTarget,
                  nodeElement: dropNodeElement,
                  nodeId: sourceNode.id,
                  handleType: 'source',
                  clientPosition,
                }) ?? 'source';
          const targetHandle =
            pendingConnectStart.handleType === 'source'
              ? resolveConnectEndHandleId({
                  eventTarget,
                  nodeElement: dropNodeElement,
                  nodeId: targetNode.id,
                  handleType: 'target',
                  clientPosition,
                }) ?? 'target'
              : pendingConnectStart.handleId ?? 'target';
          connectGraphNodes({
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle,
            targetHandle,
          });
          scheduleCanvasPersist(0);
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }

      const originNode = nodes.find((node) => node.id === pendingConnectStart.nodeId);
      const allowedTypes = resolveAllowedNodeTypes(
        pendingConnectStart.handleType,
        originNode?.type,
      );
      if (allowedTypes.length === 0) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const endX = clientPosition.x - containerRect.left;
      const endY = clientPosition.y - containerRect.top;
      let startX: number | null = pendingConnectStart.start?.x ?? null;
      let startY: number | null = pendingConnectStart.start?.y ?? null;

      if (startX === null || startY === null) {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${pendingConnectStart.nodeId}"]`
        );
        const handleElement = nodeElement?.querySelector<HTMLElement>(
          `.react-flow__handle-${pendingConnectStart.handleType}`
        );
        if (handleElement) {
          const handleRect = handleElement.getBoundingClientRect();
          startX = handleRect.left - containerRect.left + handleRect.width / 2;
          startY = handleRect.top - containerRect.top + handleRect.height / 2;
        } else if (nodeElement) {
          const nodeRect = nodeElement.getBoundingClientRect();
          startX =
            pendingConnectStart.handleType === 'source'
              ? nodeRect.right - containerRect.left
              : nodeRect.left - containerRect.left;
          startY = nodeRect.top - containerRect.top + nodeRect.height / 2;
        } else if (connectionState.from) {
          startX = connectionState.from.x;
          startY = connectionState.from.y;
        }
      }

      if (startX === null || startY === null) {
        setPreviewConnectionVisual(null);
      } else {
        setPreviewConnectionVisual({
          d: createPreviewPath({
            start: { x: startX, y: startY },
            end: { x: endX, y: endY },
            handleType: pendingConnectStart.handleType,
          }),
          stroke: 'rgba(255,255,255,0.9)',
          strokeWidth: 1,
          strokeLinecap: 'round',
          left: 0,
          top: 0,
          width: containerRect.width,
          height: containerRect.height,
        });
      }

      const flowPos = reactFlowInstance.screenToFlowPosition(clientPosition);
      setFlowPosition(flowPos);
      setMenuPosition({
        x: clientPosition.x - containerRect.left,
        y: clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [
      connectGraphNodes,
      nodes,
      pendingConnectStart,
      reactFlowInstance,
      scheduleCanvasPersist,
    ]
  );

  const handlePlusOpenMenu = useCallback(
    (params: PlusConnectDragParams) => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) return;

      const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${cssEscape(params.nodeId)}"]`,
      );
      const handleElement = nodeElement?.querySelector<HTMLElement>(
        `.react-flow__handle-${params.handleType}`,
      );
      const handleRect = handleElement?.getBoundingClientRect();
      const nodeRect = nodeElement?.getBoundingClientRect();
      const start = handleRect
        ? {
            x: handleRect.left - containerRect.left + handleRect.width / 2,
            y: handleRect.top - containerRect.top + handleRect.height / 2,
          }
        : nodeRect
          ? {
              x: (params.handleType === 'source' ? nodeRect.right : nodeRect.left) - containerRect.left,
              y: nodeRect.top - containerRect.top + nodeRect.height / 2,
            }
          : {
              x: params.clientPosition.x - containerRect.left,
              y: params.clientPosition.y - containerRect.top,
            };

      const originNode = nodes.find((node) => node.id === params.nodeId);
      const allowedTypes = resolveAllowedNodeTypes(params.handleType, originNode?.type);
      if (allowedTypes.length === 0) return;

      setPendingConnectStart({
        nodeId: params.nodeId,
        handleType: params.handleType,
        start,
      });
      setPreviewConnectionVisual(null);
      setFlowPosition(reactFlowInstance.screenToFlowPosition(params.clientPosition));
      setMenuPosition({
        x: params.clientPosition.x - containerRect.left,
        y: params.clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [nodes, reactFlowInstance],
  );

  // 摘掉当前落点高亮（拖线结束/离开合法节点时调用）。
  const clearDropTargetHighlight = useCallback(() => {
    if (dropTargetElRef.current) {
      dropTargetElRef.current.classList.remove('canvas-node-drop-target');
      dropTargetElRef.current = null;
    }
  }, []);

  // 给定光标位置 + 起手信息，返回「可作为合法落点」的节点 DOM（否则 null）。
  // 校验规则与 dragEnd/handleConnectEnd 建边时一致：非自身、类型可连、两端 handle 齐备。
  // 命中方式：① 光标直接压在某节点上优先；② 否则在节点边缘 MANUAL_DROP_PROXIMITY_PX
  // 邻域内挑「点到矩形」距离最近的合法节点——不必压进节点内部才触发。
  const resolveManualDropTargetEl = useCallback(
    (clientPosition: { x: number; y: number }, pending: PendingConnectStart) => {
      const validate = (el: HTMLElement | null): HTMLElement | null => {
        const dropNodeId = el?.dataset?.id ?? null;
        if (!el || !dropNodeId || dropNodeId === pending.nodeId) return null;
        const sourceNode =
          pending.handleType === 'source'
            ? nodes.find((node) => node.id === pending.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pending.handleType === 'source'
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pending.nodeId);
        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type, targetNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          return el;
        }
        return null;
      };

      // ① 光标直接落在某节点上。
      const direct = validate(
        document
          .elementFromPoint(clientPosition.x, clientPosition.y)
          ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null,
      );
      if (direct) return direct;

      // ② 邻域内找「点到节点矩形」最近的合法节点。
      const wrapper = wrapperRef.current;
      if (!wrapper) return null;
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      wrapper
        .querySelectorAll<HTMLElement>('.react-flow__node[data-id]')
        .forEach((el) => {
          const rect = el.getBoundingClientRect();
          const dx =
            clientPosition.x < rect.left
              ? rect.left - clientPosition.x
              : clientPosition.x > rect.right
                ? clientPosition.x - rect.right
                : 0;
          const dy =
            clientPosition.y < rect.top
              ? rect.top - clientPosition.y
              : clientPosition.y > rect.bottom
                ? clientPosition.y - rect.bottom
                : 0;
          const dist = Math.hypot(dx, dy);
          if (dist > MANUAL_DROP_PROXIMITY_PX || dist >= bestDist) return;
          if (validate(el)) {
            best = el;
            bestDist = dist;
          }
        });
      return best;
    },
    [nodes],
  );

  const handlePlusConnectDragStart = useCallback((params: PlusConnectDragParams) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    clearHoveredNodeTimer();
    clearDropTargetHighlight();
    setHoveredNodeId(null);
    setIsPlusConnectDragging(true);

    const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${cssEscape(params.nodeId)}"]`,
    );
    const handleElement = nodeElement?.querySelector<HTMLElement>(
      `.react-flow__handle-${params.handleType}`,
    );
    const handleRect = handleElement?.getBoundingClientRect();
    const nodeRect = nodeElement?.getBoundingClientRect();
    const start = handleRect
      ? {
          x: handleRect.left - containerRect.left + handleRect.width / 2,
          y: handleRect.top - containerRect.top + handleRect.height / 2,
        }
      : nodeRect
        ? {
            x: (params.handleType === 'source' ? nodeRect.right : nodeRect.left) - containerRect.left,
            y: nodeRect.top - containerRect.top + nodeRect.height / 2,
          }
        : {
            x: params.clientPosition.x - containerRect.left,
            y: params.clientPosition.y - containerRect.top,
          };

    const pending: PendingConnectStart = {
      nodeId: params.nodeId,
      handleType: params.handleType,
      start,
    };

    plusConnectStartRef.current = pending;
    setPendingConnectStart(pending);
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPreviewConnectionVisual(null);
  }, [clearHoveredNodeTimer, clearDropTargetHighlight]);

  const handlePlusConnectDragMove = useCallback((params: PlusConnectDragParams) => {
    const pending = plusConnectStartRef.current;
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!pending || !containerRect || !pending.start) return;

    setPreviewConnectionVisual({
      d: createPreviewPath({
        start: pending.start,
        end: {
          x: params.clientPosition.x - containerRect.left,
          y: params.clientPosition.y - containerRect.top,
        },
        handleType: pending.handleType,
      }),
      stroke: 'rgba(255,255,255,0.9)',
      strokeWidth: 1,
      strokeLinecap: 'round',
      left: 0,
      top: 0,
      width: containerRect.width,
      height: containerRect.height,
    });

    // 落点反馈：光标进入某个合法目标节点时高亮它（呼吸+发光），离开则摘掉。
    const dropEl = resolveManualDropTargetEl(params.clientPosition, pending);
    if (dropEl !== dropTargetElRef.current) {
      clearDropTargetHighlight();
      if (dropEl) {
        dropEl.classList.add('canvas-node-drop-target');
        dropTargetElRef.current = dropEl;
      }
    }
  }, [clearDropTargetHighlight, resolveManualDropTargetEl]);

  const handlePlusConnectDragEnd = useCallback(
    (params: PlusConnectDragParams) => {
      const pending = plusConnectStartRef.current;
      plusConnectStartRef.current = null;
      setIsPlusConnectDragging(false);
      clearDropTargetHighlight();

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!pending || !containerRect) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      // 与拖动高亮同一套邻域判定：松手时落在节点周围一圈邻域内即可建边，不必压进节点内部。
      const dropNodeElement = resolveManualDropTargetEl(params.clientPosition, pending);
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;

      if (dropNodeId && dropNodeId !== pending.nodeId) {
        const sourceNode =
          pending.handleType === 'source'
            ? nodes.find((node) => node.id === pending.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pending.handleType === 'source'
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pending.nodeId);

        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type, targetNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          const sourceHandle =
            pending.handleType === 'source'
              ? pending.handleId ?? 'source'
              : resolveConnectEndHandleId({
                  eventTarget: dropNodeElement,
                  nodeElement: dropNodeElement,
                  nodeId: sourceNode.id,
                  handleType: 'source',
                  clientPosition: params.clientPosition,
                }) ?? 'source';
          const targetHandle =
            pending.handleType === 'source'
              ? resolveConnectEndHandleId({
                  eventTarget: dropNodeElement,
                  nodeElement: dropNodeElement,
                  nodeId: targetNode.id,
                  handleType: 'target',
                  clientPosition: params.clientPosition,
                }) ?? 'target'
              : pending.handleId ?? 'target';
          connectGraphNodes({
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle,
            targetHandle,
          });
          scheduleCanvasPersist(0);
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }

      const originNode = nodes.find((node) => node.id === pending.nodeId);
      const allowedTypes = resolveAllowedNodeTypes(pending.handleType, originNode?.type);
      if (allowedTypes.length === 0) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const end = {
        x: params.clientPosition.x - containerRect.left,
        y: params.clientPosition.y - containerRect.top,
      };
      const start = pending.start ?? end;
      setPendingConnectStart(pending);
      setPreviewConnectionVisual({
        d: createPreviewPath({
          start,
          end,
          handleType: pending.handleType,
        }),
        stroke: 'rgba(255,255,255,0.9)',
        strokeWidth: 1,
        strokeLinecap: 'round',
        left: 0,
        top: 0,
        width: containerRect.width,
        height: containerRect.height,
      });

      const flowPos = reactFlowInstance.screenToFlowPosition(params.clientPosition);
      setFlowPosition(flowPos);
      setMenuPosition(end);
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [
      connectGraphNodes,
      nodes,
      reactFlowInstance,
      scheduleCanvasPersist,
      clearDropTargetHighlight,
      resolveManualDropTargetEl,
    ],
  );

  // ---- Batch connect from the multi-selection "+" -------------------------
  // Selected source-capable nodes + the downstream types valid for ALL of them
  // + the right-center of their bounding box (where a spawned node is anchored).
  const getBatchConnectContext = useCallback(() => {
    const sources = nodes.filter(
      (node) => Boolean(node.selected) && nodeHasSourceHandle(node.type),
    );
    if (sources.length < 2) {
      return null;
    }
    let allowed: CanvasNodeType[] | null = null;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxX = -Infinity;
    for (const node of sources) {
      const downstream = getDownstreamSpawnTypes(node.type);
      allowed =
        allowed === null ? downstream : allowed.filter((type) => downstream.includes(type));
      const size = getNodeSize(node);
      minY = Math.min(minY, node.position.y);
      maxY = Math.max(maxY, node.position.y + size.height);
      maxX = Math.max(maxX, node.position.x + size.width);
    }
    if (!allowed || allowed.length === 0) {
      return null;
    }
    return {
      sourceIds: sources.map((node) => node.id),
      allowedTypes: allowed,
      bboxRightCenter: { x: maxX, y: (minY + maxY) / 2 },
    };
  }, [nodes]);

  // Open the spawn menu pre-armed to fan all selected sources into the new node.
  const openBatchSpawnMenu = useCallback(
    (
      sourceIds: string[],
      allowedTypes: CanvasNodeType[],
      spawnFlowPosition: { x: number; y: number },
      menuClientPosition: { x: number; y: number },
    ) => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) {
        return;
      }
      setPendingConnectStart(null);
      setPendingBatchConnectIds(sourceIds);
      setFlowPosition(spawnFlowPosition);
      setMenuPosition({
        x: menuClientPosition.x - containerRect.left,
        y: menuClientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [],
  );

  const handleBatchConnectOpenMenu = useCallback(
    ({ clientPosition }: BatchConnectParams) => {
      const ctx = getBatchConnectContext();
      if (!ctx) {
        return;
      }
      setPreviewConnectionVisual(null);
      openBatchSpawnMenu(
        ctx.sourceIds,
        ctx.allowedTypes,
        {
          x: ctx.bboxRightCenter.x + BATCH_CONNECT_SPAWN_GAP,
          y: ctx.bboxRightCenter.y - BATCH_CONNECT_SPAWN_VERTICAL_OFFSET,
        },
        clientPosition,
      );
    },
    [getBatchConnectContext, openBatchSpawnMenu, setPreviewConnectionVisual],
  );

  const handleBatchConnectDragStart = useCallback(
    ({ clientPosition }: BatchConnectParams) => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const ctx = getBatchConnectContext();
      if (!containerRect || !ctx) {
        return;
      }
      batchConnectDragRef.current = {
        sourceIds: ctx.sourceIds,
        start: {
          x: clientPosition.x - containerRect.left,
          y: clientPosition.y - containerRect.top,
        },
      };
      setIsPlusConnectDragging(true);
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPreviewConnectionVisual(null);
    },
    [getBatchConnectContext, setPreviewConnectionVisual],
  );

  const handleBatchConnectDragMove = useCallback(
    ({ clientPosition }: BatchConnectParams) => {
      const drag = batchConnectDragRef.current;
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!drag || !containerRect) {
        return;
      }
      setPreviewConnectionVisual({
        d: createPreviewPath({
          start: drag.start,
          end: {
            x: clientPosition.x - containerRect.left,
            y: clientPosition.y - containerRect.top,
          },
          handleType: 'source',
        }),
        stroke: 'rgba(255,255,255,0.9)',
        strokeWidth: 1,
        strokeLinecap: 'round',
        left: 0,
        top: 0,
        width: containerRect.width,
        height: containerRect.height,
      });
    },
    [setPreviewConnectionVisual],
  );

  const handleBatchConnectDragEnd = useCallback(
    ({ clientPosition }: BatchConnectParams) => {
      const drag = batchConnectDragRef.current;
      batchConnectDragRef.current = null;
      setIsPlusConnectDragging(false);

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!drag || !containerRect) {
        setPreviewConnectionVisual(null);
        return;
      }

      const dropNodeElement = document
        .elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;
      const sourceIdSet = new Set(drag.sourceIds);

      // Dropped on an existing node → fan every valid source straight into it.
      if (dropNodeId && !sourceIdSet.has(dropNodeId)) {
        const targetNode = nodes.find((node) => node.id === dropNodeId);
        if (targetNode && nodeHasTargetHandle(targetNode.type)) {
          let connected = 0;
          for (const sourceId of drag.sourceIds) {
            const sourceNode = nodes.find((node) => node.id === sourceId);
            if (
              sourceNode &&
              nodeHasSourceHandle(sourceNode.type) &&
              canNodeTypeBeManualConnectionSource(sourceNode.type, targetNode.type)
            ) {
              connectGraphNodes({
                source: sourceId,
                target: dropNodeId,
                sourceHandle: 'source',
                targetHandle: 'target',
              });
              connected += 1;
            }
          }
          if (connected > 0) {
            scheduleCanvasPersist(0);
          }
          setPreviewConnectionVisual(null);
          return;
        }
      }

      // Dropped on empty canvas (or an invalid target) → spawn menu at the drop.
      const ctx = getBatchConnectContext();
      if (!ctx) {
        setPreviewConnectionVisual(null);
        return;
      }
      openBatchSpawnMenu(
        ctx.sourceIds,
        ctx.allowedTypes,
        reactFlowInstance.screenToFlowPosition(clientPosition),
        clientPosition,
      );
    },
    [
      connectGraphNodes,
      getBatchConnectContext,
      nodes,
      openBatchSpawnMenu,
      reactFlowInstance,
      scheduleCanvasPersist,
      setPreviewConnectionVisual,
    ],
  );

  const emptyHint = useMemo(() => {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.06] backdrop-blur-xl px-4 py-2">
          <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-white/60" aria-hidden="true" />
          <span className="text-sm text-white/70">
            {t('canvas.emptyHintBeforeTab')}
            <span className="text-primary">Tab</span>
            {t('canvas.emptyHintAfterTab')}
          </span>
        </div>
      </div>
    );
  }, [t]);
  const marqueeSelectionRect = useMemo(() => {
    if (!marqueeSelection) {
      return null;
    }
    return {
      left: Math.min(marqueeSelection.start.x, marqueeSelection.current.x),
      top: Math.min(marqueeSelection.start.y, marqueeSelection.current.y),
      width: Math.abs(marqueeSelection.current.x - marqueeSelection.start.x),
      height: Math.abs(marqueeSelection.current.y - marqueeSelection.start.y),
    };
  }, [marqueeSelection]);
  const nodePlacementPreview = useMemo(() => {
    if (!pendingNodePlacement || !nodePlacementClientPosition) {
      return null;
    }
    const wrapperRect = wrapperRef.current?.getBoundingClientRect();
    if (!wrapperRect) {
      return null;
    }
    const definition = nodeCatalog.getDefinition(pendingNodePlacement.type);
    const label = pendingNodePlacement.skill
      ? translateSkillName(pendingNodePlacement.skill, t)
      : definition ? t(definition.menuLabelKey) : pendingNodePlacement.type;
    return {
      left:
        nodePlacementClientPosition.x -
        wrapperRect.left -
        NODE_PLACEMENT_PREVIEW_WIDTH / 2,
      top:
        nodePlacementClientPosition.y -
        wrapperRect.top -
        NODE_PLACEMENT_PREVIEW_HEIGHT / 2,
      label,
    };
  }, [nodePlacementClientPosition, pendingNodePlacement, t]);

  return (
    <CreditDisplayHiddenProvider value={isCeRuntime()}>
    <div
      ref={wrapperRef}
      className="relative h-full w-full bg-background"
      onDragEnter={handleCanvasDragEnter}
      onDragOver={handleCanvasDragOver}
      onDragLeave={handleCanvasDragLeave}
      onDrop={handleCanvasDrop}
      onPointerMove={handleCanvasPointerMove}
    >
      <ReactFlow
        nodes={renderedNodes}
        edges={renderedEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onEdgeClick={handleEdgeClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onNodeClick={handleNodeClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onSelectionDragStart={handleSelectionDragStart}
        onSelectionDragStop={handleSelectionDragStop}
        onPaneClick={handlePaneClick}
        onMove={handleMove}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        connectionMode={ConnectionMode.Loose}
        defaultViewport={initialViewportRef.current}
        connectionRadius={CONNECTION_SNAP_RADIUS}
        minZoom={0.1}
        maxZoom={8}
        nodesDraggable
        nodesConnectable
        edgesReconnectable
        panOnDrag={PAN_ON_DRAG_BUTTONS}
        panOnScroll={trackpadPanEnabled}
        zoomOnScroll={!trackpadPanEnabled}
        panActivationKeyCode={PAN_ACTIVATION_KEY_CODE}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={MULTI_SELECTION_KEY_CODES}
        selectionKeyCode={null}
        deleteKeyCode={null}
        onlyRenderVisibleElements
        zoomOnDoubleClick={false}
        proOptions={REACT_FLOW_PRO_OPTIONS}
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={2} color="#4a4a4a" />
        {minimapVisible && (
          <MiniMap
            position={controlsPlacement === 'top-right' ? 'top-right' : 'bottom-right'}
            className="canvas-minimap canvas-minimap--popover nopan nowheel !border-border-dark !bg-surface-dark"
            style={{ pointerEvents: 'all', zIndex: 10000 }}
            nodeColor="rgba(120, 120, 120, 0.92)"
            maskColor="rgba(0, 0, 0, 0.62)"
            pannable
            zoomable
            onMouseEnter={() => setMinimapHover(true)}
            onMouseLeave={() => setMinimapHover(false)}
          />
        )}
        {minimapVisible && <CanvasMinimapBookmarksOverlay onHoverChange={setMinimapHover} />}

        <SelectedNodeOverlay />
        <MultiSelectionToolbar />
        <MultiSelectionConnectButton
          onBatchOpenMenu={handleBatchConnectOpenMenu}
          onBatchDragStart={handleBatchConnectDragStart}
          onBatchDragMove={handleBatchConnectDragMove}
          onBatchDragEnd={handleBatchConnectDragEnd}
        />
        <NodeSpawnPlusOverlay
          hoveredNodeId={hoveredNodeId}
          hidden={isPlusConnectDragging}
          onOverlayHoverStart={clearHoveredNodeTimer}
          onOverlayHoverEnd={scheduleHoveredNodeClear}
          onPlusOpenMenu={handlePlusOpenMenu}
          onPlusDragStart={handlePlusConnectDragStart}
          onPlusDragMove={handlePlusConnectDragMove}
          onPlusDragEnd={handlePlusConnectDragEnd}
        />
        <SnapAlignGuides />
      </ReactFlow>

      {marqueeSelectionRect && (
        <div
          className="pointer-events-none absolute z-[130] rounded-md border border-dashed border-white/55 bg-white/[0.04]"
          style={{
            left: marqueeSelectionRect.left,
            top: marqueeSelectionRect.top,
            width: marqueeSelectionRect.width,
            height: marqueeSelectionRect.height,
          }}
        />
      )}

      {nodePlacementPreview && (
        <div
          className="pointer-events-none absolute z-[135] select-none rounded-2xl border border-cyan-200/55 bg-[#101217]/58 shadow-[0_18px_50px_rgba(0,0,0,0.38),0_0_0_1px_rgba(255,255,255,0.06)_inset] backdrop-blur-md"
          style={{
            left: nodePlacementPreview.left,
            top: nodePlacementPreview.top,
            width: NODE_PLACEMENT_PREVIEW_WIDTH,
            height: NODE_PLACEMENT_PREVIEW_HEIGHT,
          }}
        >
          <div className="absolute inset-0 rounded-2xl bg-cyan-200/[0.035]" />
          <div className="relative flex h-full flex-col justify-between p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium leading-5 text-white/86">
                  {nodePlacementPreview.label}
                </div>
                <div className="mt-1 text-[12px] leading-4 text-white/45">
                  {t('canvas.nodePlacement.previewHint')}
                </div>
              </div>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-300/[0.14] text-cyan-100">
                <MousePointerClick className="h-4 w-4" aria-hidden="true" />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4 text-white/38">
              <span>{t('canvas.nodePlacement.confirmHint')}</span>
              <span>{t('canvas.nodePlacement.cancelHint')}</span>
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <CanvasContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          sections={[
            [
              {
                key: 'upload',
                label: '上传',
                onSelect: () => {
                  const flowPos = reactFlowInstance.screenToFlowPosition({
                    x: contextMenu.clientX,
                    y: contextMenu.clientY,
                  });
                  addNode(CANVAS_NODE_TYPES.upload, flowPos);
                  scheduleCanvasPersist(0);
                },
              },
              {
                key: 'add-node',
                label: '添加节点',
                onSelect: () =>
                  openNodeMenuAtClientPosition({
                    x: contextMenu.clientX,
                    y: contextMenu.clientY,
                  }),
              },
            ],
            [
              {
                key: 'undo',
                label: '撤销',
                shortcut: '⌘Z',
                disabled: !contextMenu.canUndo,
                onSelect: () => {
                  if (undo()) {
                    scheduleCanvasPersist(0);
                  }
                },
              },
              {
                key: 'redo',
                label: '重做',
                shortcut: '⇧⌘Z',
                disabled: !contextMenu.canRedo,
                onSelect: () => {
                  if (redo()) {
                    scheduleCanvasPersist(0);
                  }
                },
              },
            ],
            [
              {
                key: 'paste',
                label: '粘贴',
                shortcut: '⌘V',
                disabled: !contextMenu.canPaste,
                onSelect: () => {
                  // Paste the group with its top-left at the right-click point.
                  pasteFromClipboard(
                    copiedSnapshotRef.current,
                    reactFlowInstance.screenToFlowPosition({
                      x: contextMenu.clientX,
                      y: contextMenu.clientY,
                    }),
                  );
                },
              },
            ],
          ]}
        />
      )}

      {nodes.length === 0 && emptyHint}

      {isFileDropActive && (
        <div className="pointer-events-none absolute inset-0 z-[120] flex items-center justify-center">
          <div className="absolute inset-3 rounded-2xl border-2 border-dashed border-accent/70 bg-accent/[0.06]" />
          <div className="relative flex flex-col items-center gap-3 rounded-2xl bg-surface-dark/90 px-8 py-6 text-center shadow-2xl ring-1 ring-white/10">
            <Upload className="h-8 w-8 text-accent" />
            <div className="text-sm font-medium text-text-dark">释放以添加到画布</div>
            <div className="text-xs text-text-muted">支持图片、视频、音频，自动生成对应节点</div>
          </div>
        </div>
      )}

      <CanvasMinimapButton
        pinned={minimapPinned}
        onTogglePin={() => setMinimapPinned((value) => !value)}
        onHoverChange={setMinimapHover}
        placement={controlsPlacement}
      />

      <CanvasSnapAlignButton placement={controlsPlacement} />

      <CanvasFpsMeter />

      <BackToNodesHint />

      <CanvasZoomControl
        onOrganize={handleOrganizeCanvas}
        placement={controlsPlacement}
      />

      {!taskPanelOpen && (
        <CanvasQuickActionBar
          placement={controlsPlacement}
          skillItems={skillRegistry}
          onAddNode={handleQuickAddNode}
          onAddSkill={handleQuickAddSkill}
          onUseAsset={handleUseHistoryAsset}
          onDeleteNode={handleDeleteHistoryNode}
        />
      )}

      {previewConnectionVisual && (
        <svg
          className="pointer-events-none absolute z-40 overflow-visible"
          style={{
            left: previewConnectionVisual.left,
            top: previewConnectionVisual.top,
            width: previewConnectionVisual.width,
            height: previewConnectionVisual.height,
          }}
          width={previewConnectionVisual.width}
          height={previewConnectionVisual.height}
        >
          <path
            className="pointer-events-none"
            d={previewConnectionVisual.d}
            fill="none"
            stroke={previewConnectionVisual.stroke}
            strokeWidth={previewConnectionVisual.strokeWidth}
            strokeLinecap={previewConnectionVisual.strokeLinecap}
          />
        </svg>
      )}

      {showNodeMenu && (
        <NodeSelectionMenu
          position={menuPosition}
          allowedTypes={menuAllowedTypes}
          onSelect={handleNodeSelect}
          skillItems={menuAllowedTypes ? undefined : skillRegistry}
          onSelectSkill={menuAllowedTypes ? undefined : handleSkillSelect}
          onClose={closeNodeMenu}
        />
      )}

      <NodeToolDialog />

      <ImageViewerModal
        open={imageViewer.isOpen}
        imageUrl={imageViewer.currentImageUrl || ''}
        imageList={imageViewer.imageList}
        currentIndex={imageViewer.currentIndex}
        onClose={closeImageViewer}
        onNavigate={navigateImageViewer}
      />

      <VideoViewerModal
        open={videoViewer.isOpen}
        videoUrl={videoViewer.videoUrl}
        title={videoViewer.title}
        onClose={closeVideoViewer}
      />
    </div>
    </CreditDisplayHiddenProvider>
  );
}
