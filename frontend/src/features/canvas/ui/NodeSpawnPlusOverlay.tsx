// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position, useStore } from '@xyflow/react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  CANVAS_NODE_TYPES,
  isScriptNode,
  isVideoNode,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import {
  getDownstreamSpawnTypes,
  getNodeDefinition,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';

type SpawnDirection = 'right' | 'left';

interface PlusButtonProps {
  nodeId: string;
  direction: SpawnDirection;
  allowedTypes: CanvasNodeType[];
  exiting?: boolean;
  onOpenMenu?: (params: PlusDragEventParams) => void;
  onDragStart?: (params: PlusDragEventParams) => void;
  onDragMove?: (params: PlusDragEventParams) => void;
  onDragEnd?: (params: PlusDragEventParams) => void;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
}

const PLUS_DRAG_THRESHOLD_PX = 5;
// 磁吸跟随半径：鼠标进入该半径内「+」才开始追随光标，超出即复位回锚点。
// 需 >= 下方隐形命中区(`-inset-2`)的四角距离(~34px)，否则命中区边角会提前复位。
// 刻意收窄：旧值(160/`-inset-20`)的大感应区在画布缩小时会盖到节点本体上，抢走
// 节点的 pointerdown → 节点拖不动 / 不显示抓手。现在感应区只贴着按钮本身，
// 「+」的出现仍由节点 hover(onNodeMouseEnter)驱动，不受影响。
const PLUS_MAGNET_RADIUS_PX = 48;
// 「+」最多能离锚点多远地追向光标（越大追得越远）。
const PLUS_MAGNET_MAX_OFFSET_PX = 18;
// 每帧把当前位移朝目标位移插值的比例（0~1）：越小越「飘」越丝滑、越大越跟手。
const PLUS_MAGNET_LERP = 0.18;
// 「+」距节点边缘的基础间距（NodeToolbar offset）。
const PLUS_TOOLBAR_OFFSET = 20;
// 磁吸朝向节点方向时，按钮贴近节点一侧的边缘至少离节点边缘这么远——避免把节点边缘
// 的连接小球（Handle，约外露 4px）盖住。
const PLUS_MIN_GAP_FROM_NODE_PX = 10;
// Explicit contract anchor: pano360 viewer remains a supported freezone spawn type.
const FREEZONE_VIEWER_CONTRACT_TYPES = [CANVAS_NODE_TYPES.pano360Viewer] as const;

type PlusHandleType = 'source' | 'target';

interface PlusDragEventParams {
  nodeId: string;
  handleType: PlusHandleType;
  clientPosition: { x: number; y: number };
}

interface PlusDragStart {
  x: number;
  y: number;
  pointerId: number;
}

function PlusButton({
  nodeId,
  direction,
  allowedTypes,
  exiting = false,
  onOpenMenu,
  onDragStart,
  onDragMove,
  onDragEnd,
  onHoverStart,
  onHoverEnd,
}: PlusButtonProps) {
  const { t } = useTranslation();
  const dragStartRef = useRef<PlusDragStart | null>(null);
  const dragStartedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // 磁吸位移走 rAF 插值并直接写 DOM transform，不进 React state —— 避免每次
  // pointermove 触发重渲染，跟随更丝滑（current 每帧朝 target lerp）。
  const targetOffsetRef = useRef({ x: 0, y: 0 });
  const currentOffsetRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const handleType: PlusHandleType = direction === 'right' ? 'source' : 'target';

  // 跟随画布缩放：直接用 zoom 作为按钮 scale（不夹取，严格按画布比例——与浮动
  // 工具条/上传按钮栏一致），缩小时一起变小、放大时一起变大，不再显得突兀。
  // grow 方向背离节点（右侧「+」以左缘为原点向右长、左侧「+」以右缘为原点向左长），
  // 避免放大时盖回节点本体。
  const zoom = useStore((state) => state.transform[2]);
  const plusScale = zoom;
  const plusScaleRef = useRef(plusScale);
  plusScaleRef.current = plusScale;

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || allowedTypes.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
      };
      dragStartedRef.current = false;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const start = dragStartRef.current;
        if (!start || start.pointerId !== moveEvent.pointerId) {
          return;
        }
        const clientPosition = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!dragStartedRef.current) {
          const delta = Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y);
          if (delta < PLUS_DRAG_THRESHOLD_PX) return;
          dragStartedRef.current = true;
          suppressClickRef.current = true;
          onDragStart?.({
            nodeId,
            handleType,
            clientPosition: { x: start.x, y: start.y },
          });
        }
        onDragMove?.({ nodeId, handleType, clientPosition });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        const wasDragging = dragStartedRef.current;
        if (dragStartRef.current?.pointerId === upEvent.pointerId) {
          dragStartRef.current = null;
        }
        window.removeEventListener('pointermove', handlePointerMove, true);
        window.removeEventListener('pointerup', handlePointerUp, true);
        window.removeEventListener('pointercancel', handlePointerUp, true);
        if (wasDragging) {
          onDragEnd?.({
            nodeId,
            handleType,
            clientPosition: { x: upEvent.clientX, y: upEvent.clientY },
          });
        }
      };

      window.addEventListener('pointermove', handlePointerMove, true);
      window.addEventListener('pointerup', handlePointerUp, true);
      window.addEventListener('pointercancel', handlePointerUp, true);
    },
    [allowedTypes.length, handleType, nodeId, onDragEnd, onDragMove, onDragStart],
  );

  // rAF 循环：每帧把 currentOffset 朝 targetOffset 插值，直接写到按钮的 transform。
  // 一旦贴近当前目标（无论目标是原点还是某个静止偏移）就停掉循环——光标静止时
  // 目标不再变，没有可动画的内容；下次 pointermove 会经 ensureMagnetLoop 重启。
  // 这样指针停在偏离中心处时不会空转。
  const runMagnetLoop = useCallback(() => {
    const cur = currentOffsetRef.current;
    const tgt = targetOffsetRef.current;
    const nx = cur.x + (tgt.x - cur.x) * PLUS_MAGNET_LERP;
    const ny = cur.y + (tgt.y - cur.y) * PLUS_MAGNET_LERP;
    const settled = Math.abs(nx - tgt.x) < 0.1 && Math.abs(ny - tgt.y) < 0.1;
    const x = settled ? tgt.x : nx;
    const y = settled ? tgt.y : ny;
    currentOffsetRef.current = { x, y };
    if (buttonRef.current) {
      // translate(磁吸位移, 屏幕 px，不随 scale 改变) + scale(跟随缩放)。
      buttonRef.current.style.transform = `translate(${x}px, ${y}px) scale(${plusScaleRef.current})`;
    }
    if (settled) {
      rafRef.current = null;
      return;
    }
    rafRef.current = requestAnimationFrame(runMagnetLoop);
  }, []);

  const ensureMagnetLoop = useCallback(() => {
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(runMagnetLoop);
    }
  }, [runMagnetLoop]);

  const resetMagnetOffset = useCallback(() => {
    targetOffsetRef.current = { x: 0, y: 0 };
    ensureMagnetLoop();
  }, [ensureMagnetLoop]);

  const updateMagnetOffset = useCallback((event: React.PointerEvent) => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const distance = Math.hypot(dx, dy);

    if (distance > PLUS_MAGNET_RADIUS_PX) {
      resetMagnetOffset();
      return;
    }

    const strength = Math.min(1, distance / PLUS_MAGNET_RADIUS_PX);
    const maxOffset = PLUS_MAGNET_MAX_OFFSET_PX * strength;
    const scale = distance > maxOffset && distance > 0 ? maxOffset / distance : 1;
    // 限制朝向节点方向的位移：按钮贴近节点的一侧不得越过 PLUS_MIN_GAP_FROM_NODE_PX，
    // 否则磁吸会把「+」拉到节点边缘、盖住连接小球（Handle）。远离节点 / 纵向不限制。
    const towardNodeLimit = PLUS_TOOLBAR_OFFSET - PLUS_MIN_GAP_FROM_NODE_PX;
    let offsetX = dx * scale;
    if (direction === 'right') {
      offsetX = Math.max(offsetX, -towardNodeLimit);
    } else {
      offsetX = Math.min(offsetX, towardNodeLimit);
    }
    targetOffsetRef.current = { x: offsetX, y: dy * scale };
    ensureMagnetLoop();
  }, [direction, ensureMagnetLoop, resetMagnetOffset]);

  // 卸载时停掉 rAF，避免泄漏。
  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  // zoom 变化时立即重写 transform —— 磁吸 rAF 在静止后会停掉，不会自动跟上新的
  // scale；这里在缩放变化时补一次，保证空闲态的「+」也随缩放即时变大变小。
  useEffect(() => {
    if (buttonRef.current) {
      const { x, y } = currentOffsetRef.current;
      buttonRef.current.style.transform = `translate(${x}px, ${y}px) scale(${plusScale})`;
    }
  }, [plusScale]);

  return (
    <div
      ref={anchorRef}
      className={`relative transition-[opacity,transform] duration-200 ease-out ${
        exiting ? 'pointer-events-none scale-95 opacity-0' : 'scale-100 opacity-100'
      }`}
      onPointerEnter={(event) => {
        onHoverStart?.();
        updateMagnetOffset(event);
      }}
      onPointerMove={updateMagnetOffset}
      onPointerLeave={() => {
        resetMagnetOffset();
        onHoverEnd?.();
      }}
    >
      {/* 贴着按钮的小命中区(仅做点击容错 + 磁吸感应)。刻意不再朝节点方向外扩，
          也不再有 node→button 的悬停桥——那些大面积 pointer-events-auto 层在画布
          缩小时会盖住节点、抢走拖拽。移到「+」的过程靠节点 hover 的 400ms 隐藏
          延迟兜住(见 Canvas: NODE_SPAWN_PLUS_HIDE_DELAY_MS)。 */}
      <span
        aria-hidden="true"
        className="pointer-events-auto absolute -inset-2 z-0 rounded-full"
        onPointerEnter={(event) => {
          onHoverStart?.();
          updateMagnetOffset(event);
        }}
        onPointerMove={updateMagnetOffset}
        onPointerLeave={() => {
          resetMagnetOffset();
          onHoverEnd?.();
        }}
      />
      <button
        ref={buttonRef}
        type="button"
        aria-label={
          direction === 'right'
            ? t('canvas.spawnPlus.referenceThisNode')
            : t('canvas.spawnPlus.connectIntoThisNode')
        }
        // 缩放原点放在贴近节点的一侧，放大时朝远离节点的方向生长，不会盖回节点本体。
        style={{ transformOrigin: direction === 'right' ? 'left center' : 'right center' }}
        className="canvas-spawn-plus-magnetic-button nodrag relative z-10 flex h-8 w-8 items-center justify-center rounded-full border border-white/40 bg-surface-dark/95 text-white/85 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_6px_18px_rgba(0,0,0,0.32)] transition-[border-color,color,box-shadow] duration-150 will-change-transform hover:border-white/85 hover:text-white hover:shadow-[0_0_0_1px_rgba(255,255,255,0.42),0_0_18px_rgba(255,255,255,0.22)]"
        onPointerEnter={(event) => {
          onHoverStart?.();
          updateMagnetOffset(event);
        }}
        onPointerMove={updateMagnetOffset}
        onPointerLeave={() => {
          resetMagnetOffset();
          onHoverEnd?.();
        }}
        onPointerDown={handlePointerDown}
        onClick={(event) => {
          event.stopPropagation();
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onOpenMenu?.({
            nodeId,
            handleType,
            clientPosition: { x: event.clientX, y: event.clientY },
          });
        }}
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

interface NodeSpawnPlusOverlayProps {
  hoveredNodeId?: string | null;
  hidden?: boolean;
  onOverlayHoverStart?: () => void;
  onOverlayHoverEnd?: () => void;
  onPlusOpenMenu?: (params: PlusDragEventParams) => void;
  onPlusDragStart?: (params: PlusDragEventParams) => void;
  onPlusDragMove?: (params: PlusDragEventParams) => void;
  onPlusDragEnd?: (params: PlusDragEventParams) => void;
}

export const NodeSpawnPlusOverlay = memo(({
  hoveredNodeId = null,
  hidden = false,
  onOverlayHoverStart,
  onOverlayHoverEnd,
  onPlusOpenMenu,
  onPlusDragStart,
  onPlusDragMove,
  onPlusDragEnd,
}: NodeSpawnPlusOverlayProps) => {
  const { t: _t } = useTranslation();
  void FREEZONE_VIEWER_CONTRACT_TYPES;
  const nodes = useCanvasStore((state) => state.nodes);
  const activeOverlayNodeId = useCanvasStore((state) => state.activeOverlayNodeId);
  // 「+」与节点的间距随画布缩放：NodeToolbar 的 offset 是固定屏幕像素，画布缩小时
  // 节点变小、这段固定间距相对就显得很远。改成 offset = 基础间距 × zoom，让间距在
  // 流空间里恒定 —— 缩小时「+」紧贴节点、放大时按比例拉开。留 4px 屏幕下限避免贴到
  // 连接小球上。
  const zoom = useStore((state) => state.transform[2]);
  const toolbarOffset = Math.max(4, PLUS_TOOLBAR_OFFSET * zoom);
  const [renderNodeId, setRenderNodeId] = useState<string | null>(hidden ? null : hoveredNodeId);
  const [isExiting, setIsExiting] = useState(false);

  const activeNodeId = hidden ? null : hoveredNodeId;

  useEffect(() => {
    if (activeNodeId) {
      setRenderNodeId(activeNodeId);
      setIsExiting(false);
      return;
    }

    setIsExiting(true);
    const timeout = window.setTimeout(() => {
      setRenderNodeId(null);
      setIsExiting(false);
    }, 200);

    return () => window.clearTimeout(timeout);
  }, [activeNodeId]);

  const selectedNode = useMemo(
    () => (renderNodeId ? nodes.find((node) => node.id === renderNodeId) ?? null : null),
    [nodes, renderNodeId],
  );

  // 「引用该节点生成」+ 菜单的下游白名单，与 Canvas 拖线落空菜单共用同一份
  // `getDownstreamSpawnTypes` —— 单一事实来源避免两边漂移。
  const rightAllowedTypes = useMemo<CanvasNodeType[]>(() => {
    return getDownstreamSpawnTypes(selectedNode?.type);
  }, [selectedNode]);

  // Left side (video only): upstream inputs allowed for video gen.
  // Scope per product spec: 文本 / 图片 / 音频 —— 多版本 / 视频 不作为
  // video 节点的上游入口（避免生成链路自环 / 语义混乱）。
  const leftAllowedTypes = useMemo<CanvasNodeType[]>(() => {
    return [
        CANVAS_NODE_TYPES.textAnnotation,
        CANVAS_NODE_TYPES.imageGen,
        CANVAS_NODE_TYPES.audio,
      ].filter((type) => {
        const def = getNodeDefinition(type);
        return def?.connectivity.sourceHandle;
      });
  }, []);

  if (!selectedNode) {
    return null;
  }

  // 节点正被二级浮层接管（多角度/打光/叠卡画册展开等）时不显示「+」——
  // 浮层盖在节点上方，+ 会穿透浮层浮在错误的位置。
  if (selectedNode.id === activeOverlayNodeId) {
    return null;
  }

  // 脚本节点不暴露主动「+」入口：脚本只能通过节点本体里的三个快捷动作
  // （剧本 / 视频参考 / 角色 → 生成分镜脚本）创建上游节点，不允许下游派生。
  if (isScriptNode(selectedNode)) {
    return null;
  }

  const showRight = nodeHasSourceHandle(selectedNode.type) && rightAllowedTypes.length > 0;
  // Left + is scoped to the video node per product spec: a video node can pull
  // resources from upstream image/audio/text inputs. Other node types only show
  // the right + (existing "引用该节点生成" affordance).
  // Only a BLANK video node exposes the upstream「+」—— once it already holds a
  // video, the left「+」disappears (与音频节点一致：有资源后只剩右侧「+」)。
  const videoHasResource =
    isVideoNode(selectedNode) &&
    typeof selectedNode.data.videoUrl === 'string' &&
    selectedNode.data.videoUrl.length > 0;
  const showLeft =
    isVideoNode(selectedNode) &&
    !videoHasResource &&
    nodeHasTargetHandle(selectedNode.type) &&
    leftAllowedTypes.length > 0;

  if (!showRight && !showLeft) {
    return null;
  }

  return (
    <>
      {showRight && (
        <ReactFlowNodeToolbar
          nodeId={selectedNode.id}
          isVisible
          position={Position.Right}
          align="center"
          offset={toolbarOffset}
          className="pointer-events-auto"
          onPointerEnter={onOverlayHoverStart}
          onPointerLeave={onOverlayHoverEnd}
        >
          <PlusButton
            nodeId={selectedNode.id}
            direction="right"
            allowedTypes={rightAllowedTypes}
            exiting={isExiting}
            onOpenMenu={onPlusOpenMenu}
            onDragStart={onPlusDragStart}
            onDragMove={onPlusDragMove}
            onDragEnd={onPlusDragEnd}
            onHoverStart={onOverlayHoverStart}
            onHoverEnd={onOverlayHoverEnd}
          />
        </ReactFlowNodeToolbar>
      )}
      {showLeft && (
        <ReactFlowNodeToolbar
          nodeId={selectedNode.id}
          isVisible
          position={Position.Left}
          align="center"
          offset={toolbarOffset}
          className="pointer-events-auto"
          onPointerEnter={onOverlayHoverStart}
          onPointerLeave={onOverlayHoverEnd}
        >
          <PlusButton
            nodeId={selectedNode.id}
            direction="left"
            allowedTypes={leftAllowedTypes}
            exiting={isExiting}
            onOpenMenu={onPlusOpenMenu}
            onDragStart={onPlusDragStart}
            onDragMove={onPlusDragMove}
            onDragEnd={onPlusDragEnd}
            onHoverStart={onOverlayHoverStart}
            onHoverEnd={onOverlayHoverEnd}
          />
        </ReactFlowNodeToolbar>
      )}
    </>
  );
});

NodeSpawnPlusOverlay.displayName = 'NodeSpawnPlusOverlay';
