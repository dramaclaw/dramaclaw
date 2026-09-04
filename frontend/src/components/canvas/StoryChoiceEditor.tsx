import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { X } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import { resolveMediaUrl } from '@/lib/media-url';
import { isVideoNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  defaultStoryChoiceAnchor,
  normalizeStoryChoiceInteraction,
} from '@/features/canvas/story/storyTypes';
import {
  coverPointToMediaAnchor,
  objectCoverRenderRect,
  type MediaPoint,
  type MediaRenderRect,
  type MediaSize,
} from '@/features/canvas/story/objectCoverCoordinates';
import type {
  StoryChoiceAnchor,
  StoryChoiceCondition,
  StoryChoiceEdgeData,
  StoryChoiceEffect,
  StoryChoiceInteraction,
  StoryChoiceMotion,
  StoryChoicePresentation,
  StoryChoiceUiStyle,
  StoryConditionExpr,
  StoryConditionLeaf,
  StoryVariable,
  StoryFlag,
  StoryFlagCondition,
  StoryTransitionMode,
  StoryVisitCondition,
} from '@/features/canvas/story/storyTypes';
import { conditionLeaves, isConditionGroup, isFlagCondition, isVisitCondition } from '@/features/canvas/story/conditionExpr';

const OPS: StoryChoiceCondition['op'][] = ['>=', '<=', '==', '>', '<'];

/** 稳定的空成员数组引用:无故事组分支回退到它,避免 selector 每次返回新 [] 触发重渲染。 */
const EMPTY_MEMBER_NODES: CanvasNode[] = [];

const FIELD_CLASS =
  'rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-white/90 outline-none transition-colors focus:border-accent/50 focus:bg-white/[0.08]';
const SELECT_CLASS = `${FIELD_CLASS} cursor-pointer`;
const CHECKBOX_CLASS = 'h-3.5 w-3.5 shrink-0 accent-[rgb(var(--accent-rgb))]';
const SECTION_LABEL_CLASS = 'text-[11px] font-medium uppercase tracking-wide text-white/45';
const ANCHOR_PREVIEW_STYLE_CLASS: Record<NonNullable<StoryChoiceInteraction['uiStyle']>, string> = {
  glass: 'rounded-xl border border-white/30 bg-black/35 text-white/95 shadow-[0_10px_24px_rgba(0,0,0,0.45)] backdrop-blur-md',
  tag: 'h-[52px] w-[52px] rounded-full border-0 bg-transparent p-0',
  warning: 'rounded-xl border border-amber-200/45 bg-amber-950/65 text-amber-50 shadow-[0_10px_24px_rgba(120,53,15,0.42)] backdrop-blur-md',
};
type HotspotCorner = 'nw' | 'ne' | 'se' | 'sw';
type HotspotGesture = {
  pointerId: number;
  kind: 'draw' | 'move' | 'resize';
  start: MediaPoint;
  initial: StoryChoiceAnchor;
  corner?: HotspotCorner;
  changed: boolean;
};

const HOTSPOT_HANDLE_POSITION: Record<HotspotCorner, string> = {
  nw: '-left-4 -top-4 cursor-nwse-resize',
  ne: '-right-4 -top-4 cursor-nesw-resize',
  se: '-bottom-4 -right-4 cursor-nwse-resize',
  sw: '-bottom-4 -left-4 cursor-nesw-resize',
};

/** 互动选项出现在片段收束后；编辑锚点时展示结尾前一帧，避开 duration 的不可 seek 边界。 */
function seekPreviewToTailFrame(video: HTMLVideoElement) {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  video.currentTime = Math.max(0, video.duration - 0.08);
}

function TechTargetRingPreview() {
  return (
    <span
      aria-hidden
      style={{ position: 'absolute', left: 6, top: 6, display: 'block', width: 40, height: 40, border: '2px solid rgba(255,255,255,0.92)', borderRadius: '50%', boxSizing: 'border-box', boxShadow: '0 0 0 1px rgba(165,243,252,0.18), 0 0 10px rgba(165,243,252,0.42)', pointerEvents: 'none' }}
    >
      <span style={{ position: 'absolute', left: 6, top: 6, width: 24, height: 24, border: '1px solid rgba(207,250,254,0.72)', borderRadius: '50%', boxSizing: 'border-box' }} />
      <span style={{ position: 'absolute', left: 14, top: 14, width: 8, height: 8, border: '2px solid rgba(255,255,255,0.96)', borderRadius: '50%', boxSizing: 'border-box', boxShadow: '0 0 6px rgba(165,243,252,0.72)' }} />
    </span>
  );
}

/**
 * 组字期间不能把每一次拼音按键都写回画布 store：更新一条边会让 React Flow
 * 重新渲染边及其编辑器，进而打断输入法候选。草稿仅在组字完成后持久化。
 */
function useCompositionSafeText(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  const isComposingRef = useRef(false);
  const lastCommittedValueRef = useRef(value);

  useEffect(() => {
    lastCommittedValueRef.current = value;
    if (!isComposingRef.current) setDraft(value);
  }, [value]);

  const commit = useCallback((next: string) => {
    // 部分浏览器会在 compositionend 后补发 change；去重避免重复写历史记录。
    if (next === lastCommittedValueRef.current) return;
    lastCommittedValueRef.current = next;
    onCommit(next);
  }, [onCommit]);

  return {
    value: draft,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = event.target.value;
      setDraft(next);
      if (!isComposingRef.current) commit(next);
    },
    onCompositionStart: () => {
      isComposingRef.current = true;
    },
    onCompositionEnd: (event: CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      isComposingRef.current = false;
      const next = event.currentTarget.value;
      setDraft(next);
      commit(next);
    },
  };
}

/** 选项编辑器:编辑某条 storyChoiceEdge 的文案 / 条件 / 效果。挂在边中点上方。 */
export const StoryChoiceEditor = memo(function StoryChoiceEditor({
  edgeId,
  sourceNodeId,
  choiceText,
  feedbackText,
  interaction,
  condition,
  effects,
  transitionMode,
  isDefault,
  variables,
  flags = [],
  onClose,
}: {
  edgeId: string;
  sourceNodeId: string;
  choiceText: string;
  feedbackText?: string;
  interaction?: StoryChoiceInteraction;
  condition?: StoryConditionExpr;
  effects?: StoryChoiceEffect[];
  transitionMode?: StoryTransitionMode;
  isDefault?: boolean;
  variables: StoryVariable[];
  flags?: StoryFlag[];
  /** 弹窗关闭时由选项边取消选中；编辑内容均为即时保存。 */
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const update = useCanvasStore((s) => s.updateStoryChoiceEdgeData);
  const setChoicePresentation = useCanvasStore((s) => s.setStoryChoicePresentation);
  const setDefault = useCanvasStore((s) => s.setStoryDefaultChoice);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const selectEdge = useCanvasStore((s) => s.onEdgesChange);
  const sourceNode = useCanvasStore((s) => s.nodes.find((node) => node.id === sourceNodeId));
  // 一个选择点的所有出边共用同一弹窗，用左栏切换，避免逐条边打开多个浮层。
  const sourceChoiceEdges = useCanvasStore(
    useShallow((s) => s.edges.filter(
      (edge) => edge.type === 'storyChoiceEdge' && edge.source === sourceNodeId,
    )),
  );
  const timeLimitSec = useCanvasStore((s) => {
    const node = s.nodes.find((n) => n.id === sourceNodeId);
    const v = (node?.data as { choiceTimeLimitSec?: number } | undefined)?.choiceTimeLimitSec;
    return typeof v === 'number' ? v : 0;
  });
  const firstVar = variables[0]?.name ?? '';
  const firstFlag = flags[0]?.name ?? '';
  const hasVariables = variables.length > 0;
  const hasFlags = flags.length > 0;
  const resolvedTransitionMode: StoryTransitionMode = transitionMode === 'automatic' ? 'automatic' : 'visible';
  const resolvedInteraction = normalizeStoryChoiceInteraction(interaction);
  // 呈现方式属于整个选择点；锚点/外观/动画仍是某一选项自己的资料。
  const choicePresentation = useMemo(() => {
    const presentations = sourceChoiceEdges.map((edge) =>
      normalizeStoryChoiceInteraction((edge.data as StoryChoiceEdgeData | undefined)?.interaction).presentation,
    );
    const first = presentations[0] ?? resolvedInteraction.presentation;
    return presentations.every((presentation) => presentation === first) ? first : undefined;
  }, [resolvedInteraction.presentation, sourceChoiceEdges]);
  const isAnchored = resolvedInteraction.presentation !== 'overlay';
  const sourceVideoUrl = (sourceNode?.data as { videoUrl?: string | null } | undefined)?.videoUrl ?? null;
  const previewVideoUrl = sourceVideoUrl ? (resolveMediaUrl(sourceVideoUrl) ?? sourceVideoUrl) : null;
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const previewMediaSizeRef = useRef<MediaSize | null>(null);
  const [previewCoverRect, setPreviewCoverRect] = useState<MediaRenderRect | null>(null);
  const anchorPointerIdRef = useRef<number | null>(null);
  const hotspotGestureRef = useRef<HotspotGesture | null>(null);
  // 锚点拖动只影响弹窗内的预览；结束时才进入画布 store，避免每个 pointermove
  // 都遍历整张画布的边、写一条 undo 历史并触发同步订阅。
  const anchorDraftRef = useRef<StoryChoiceInteraction['anchor']>(undefined);
  const [anchorDraft, setAnchorDraft] = useState<StoryChoiceInteraction['anchor']>(undefined);
  const choiceTextField = useCompositionSafeText(choiceText, useCallback(
    (next) => update(edgeId, { choiceText: next }),
    [edgeId, update],
  ));
  const feedbackTextField = useCompositionSafeText(feedbackText ?? '', useCallback(
    (next) => update(edgeId, { feedbackText: next }),
    [edgeId, update],
  ));
  const writeInteraction = (patch: Partial<StoryChoiceInteraction>) => {
    update(edgeId, { interaction: { ...resolvedInteraction, ...patch } });
  };
  const setPresentation = (presentation: StoryChoicePresentation) => {
    if (presentation !== choicePresentation) setChoicePresentation(edgeId, presentation);
  };
  const measurePreviewCover = useCallback(() => {
    const frame = previewFrameRef.current;
    if (!frame) return;
    const bounds = frame.getBoundingClientRect();
    const container = { width: bounds.width, height: bounds.height };
    const media = previewMediaSizeRef.current;
    setPreviewCoverRect(media
      ? objectCoverRenderRect(container, media)
      : { left: 0, top: 0, ...container });
  }, []);
  useEffect(() => {
    // 切换片段时不能沿用上一支视频的宽高，否则新视频 metadata 到达前热区会短暂错位。
    previewMediaSizeRef.current = null;
    setPreviewCoverRect(null);
  }, [previewVideoUrl]);
  useEffect(() => {
    if (!isAnchored) return;
    measurePreviewCover();
    const frame = previewFrameRef.current;
    const observer = frame && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measurePreviewCover)
      : null;
    if (frame) observer?.observe(frame);
    window.addEventListener('resize', measurePreviewCover);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measurePreviewCover);
    };
  }, [isAnchored, measurePreviewCover, previewVideoUrl]);
  const mediaPointFromPointer = (event: PointerEvent<HTMLElement>): MediaPoint | null => {
    const frameRect = previewFrameRef.current?.getBoundingClientRect();
    const eventRect = event.currentTarget.getBoundingClientRect();
    const rect = frameRect && frameRect.width > 0 && frameRect.height > 0 ? frameRect : eventRect;
    if (rect.width <= 0 || rect.height <= 0) return null;
    const containerPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return previewMediaSizeRef.current
      ? coverPointToMediaAnchor(
          containerPoint,
          { width: rect.width, height: rect.height },
          previewMediaSizeRef.current,
        )
      : {
          x: Math.min(1, Math.max(0, containerPoint.x / rect.width)),
          y: Math.min(1, Math.max(0, containerPoint.y / rect.height)),
        };
  };
  const anchorFromPointer = (event: PointerEvent<HTMLElement>) => {
    const mediaPoint = mediaPointFromPointer(event);
    const currentAnchor = anchorDraftRef.current
      ?? resolvedInteraction.anchor
      ?? defaultStoryChoiceAnchor(resolvedInteraction.presentation);
    return normalizeStoryChoiceInteraction({
      ...resolvedInteraction,
      anchor: {
        ...currentAnchor,
        x: mediaPoint?.x ?? currentAnchor.x,
        y: mediaPoint?.y ?? currentAnchor.y,
      },
    }).anchor!;
  };
  const updateAnchorDraft = (event: PointerEvent<HTMLButtonElement>) => {
    const next = anchorFromPointer(event);
    anchorDraftRef.current = next;
    setAnchorDraft(next);
  };
  const startAnchorDrag = (event: PointerEvent<HTMLButtonElement>) => {
    anchorPointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateAnchorDraft(event);
  };
  const moveAnchorDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (anchorPointerIdRef.current === event.pointerId) updateAnchorDraft(event);
  };
  const finishAnchorDrag = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    if (anchorPointerIdRef.current !== event.pointerId) return;
    anchorPointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const anchor = anchorDraftRef.current;
    anchorDraftRef.current = undefined;
    setAnchorDraft(undefined);
    if (commit && anchor) writeInteraction({ anchor });
  };
  const endAnchorDrag = (event: PointerEvent<HTMLButtonElement>) => finishAnchorDrag(event, true);
  const cancelAnchorDrag = (event: PointerEvent<HTMLButtonElement>) => finishAnchorDrag(event, false);
  const displayAnchor = anchorDraft ?? resolvedInteraction.anchor;
  const previewAnchorStyle = displayAnchor
    ? {
        left: previewCoverRect
          ? `${previewCoverRect.left + displayAnchor.x * previewCoverRect.width}px`
          : `${displayAnchor.x * 100}%`,
        top: previewCoverRect
          ? `${previewCoverRect.top + displayAnchor.y * previewCoverRect.height}px`
          : `${displayAnchor.y * 100}%`,
        ...(resolvedInteraction.presentation === 'baked-video'
          ? {
              width: previewCoverRect
                ? `${(displayAnchor.width ?? 0) * previewCoverRect.width}px`
                : `${(displayAnchor.width ?? 0) * 100}%`,
              height: previewCoverRect
                ? `${(displayAnchor.height ?? 0) * previewCoverRect.height}px`
                : `${(displayAnchor.height ?? 0) * 100}%`,
            }
          : {}),
      }
    : undefined;
  const normalizeBakedAnchor = (anchor: StoryChoiceAnchor): StoryChoiceAnchor => (
    normalizeStoryChoiceInteraction({
      ...resolvedInteraction,
      presentation: 'baked-video',
      anchor,
    }).anchor ?? defaultStoryChoiceAnchor('baked-video')
  );
  const setHotspotDraft = (anchor: StoryChoiceAnchor) => {
    const nextAnchor = normalizeBakedAnchor(anchor);
    anchorDraftRef.current = nextAnchor;
    setAnchorDraft(nextAnchor);
  };
  const hotspotFromDraw = (start: MediaPoint, point: MediaPoint, initial: StoryChoiceAnchor) => {
    const left = Math.min(start.x, point.x);
    const right = Math.max(start.x, point.x);
    const top = Math.min(start.y, point.y);
    const bottom = Math.max(start.y, point.y);
    return normalizeBakedAnchor({
      ...initial,
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      width: Math.max(0.02, right - left),
      height: Math.max(0.02, bottom - top),
    });
  };
  const hotspotFromMove = (gesture: HotspotGesture, point: MediaPoint) => {
    const fallback = defaultStoryChoiceAnchor('baked-video');
    const width = gesture.initial.width ?? fallback.width!;
    const height = gesture.initial.height ?? fallback.height!;
    return normalizeBakedAnchor({
      ...gesture.initial,
      x: Math.min(1 - width / 2, Math.max(width / 2, gesture.initial.x + point.x - gesture.start.x)),
      y: Math.min(1 - height / 2, Math.max(height / 2, gesture.initial.y + point.y - gesture.start.y)),
      width,
      height,
    });
  };
  const hotspotFromResize = (
    initial: StoryChoiceAnchor,
    corner: HotspotCorner,
    point: MediaPoint,
  ) => {
    const fallback = defaultStoryChoiceAnchor('baked-video');
    const width = initial.width ?? fallback.width!;
    const height = initial.height ?? fallback.height!;
    let left = initial.x - width / 2;
    let right = initial.x + width / 2;
    let top = initial.y - height / 2;
    let bottom = initial.y + height / 2;
    if (corner.includes('w')) left = Math.min(right - 0.02, point.x);
    else right = Math.max(left + 0.02, point.x);
    if (corner.includes('n')) top = Math.min(bottom - 0.02, point.y);
    else bottom = Math.max(top + 0.02, point.y);
    return normalizeBakedAnchor({
      ...initial,
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      width: right - left,
      height: bottom - top,
    });
  };
  const startHotspotGesture = (
    event: PointerEvent<HTMLElement>,
    kind: HotspotGesture['kind'],
    corner?: HotspotCorner,
  ) => {
    const point = mediaPointFromPointer(event);
    const initial = displayAnchor ?? defaultStoryChoiceAnchor('baked-video');
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    hotspotGestureRef.current = {
      pointerId: event.pointerId,
      kind,
      start: point,
      initial,
      corner,
      changed: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const updateHotspotGesture = (event: PointerEvent<HTMLElement>) => {
    const gesture = hotspotGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const point = mediaPointFromPointer(event);
    if (!point) return;
    if (gesture.kind === 'draw') {
      if (Math.abs(point.x - gesture.start.x) < 0.005 && Math.abs(point.y - gesture.start.y) < 0.005) return;
      setHotspotDraft(hotspotFromDraw(gesture.start, point, gesture.initial));
    } else if (gesture.kind === 'move') {
      setHotspotDraft(hotspotFromMove(gesture, point));
    } else if (gesture.corner) {
      setHotspotDraft(hotspotFromResize(gesture.initial, gesture.corner, point));
    }
    gesture.changed = true;
  };
  const finishHotspotGesture = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    const gesture = hotspotGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.stopPropagation();
    hotspotGestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const anchor = anchorDraftRef.current;
    anchorDraftRef.current = undefined;
    setAnchorDraft(undefined);
    if (commit && gesture.changed && anchor) writeInteraction({ anchor });
  };
  const resizeHotspotByKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    corner: HotspotCorner,
  ) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const initial = displayAnchor ?? defaultStoryChoiceAnchor('baked-video');
    const fallback = defaultStoryChoiceAnchor('baked-video');
    const width = initial.width ?? fallback.width!;
    const height = initial.height ?? fallback.height!;
    const step = event.shiftKey ? 0.05 : 0.01;
    const point = {
      x: corner.includes('w') ? initial.x - width / 2 : initial.x + width / 2,
      y: corner.includes('n') ? initial.y - height / 2 : initial.y + height / 2,
    };
    if (event.key === 'ArrowLeft') point.x -= step;
    if (event.key === 'ArrowRight') point.x += step;
    if (event.key === 'ArrowUp') point.y -= step;
    if (event.key === 'ArrowDown') point.y += step;
    writeInteraction({
      anchor: hotspotFromResize(initial, corner, {
        x: Math.min(1, Math.max(0, point.x)),
        y: Math.min(1, Math.max(0, point.y)),
      }),
    });
  };
  const moveHotspotByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const initial = displayAnchor ?? defaultStoryChoiceAnchor('baked-video');
    const fallback = defaultStoryChoiceAnchor('baked-video');
    const width = initial.width ?? fallback.width!;
    const height = initial.height ?? fallback.height!;
    const step = event.shiftKey ? 0.05 : 0.01;
    writeInteraction({
      anchor: normalizeBakedAnchor({
        ...initial,
        x: initial.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
        y: initial.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
        width,
        height,
      }),
    });
  };

  // 同组成员(供「去过片段」选择);含源节点自身(重复进入本片段 N 次合法)。
  // selector 只做 filter(保留原节点引用),useShallow 可逐元素比较、结果引用稳定;
  // {id,label} 映射放到 useMemo —— 若在 selector 里 map 出新对象,useShallow 每次都判不等 →
  // useSyncExternalStore 认为快照一直在变 → 无限重渲染("Maximum update depth exceeded")。
  const memberNodes = useCanvasStore(
    useShallow((s) => {
      const src = s.nodes.find((n) => n.id === sourceNodeId);
      const groupId = src?.parentId;
      if (!groupId) return EMPTY_MEMBER_NODES;
      return s.nodes.filter((n) => n.parentId === groupId && isVideoNode(n));
    }),
  );
  const members = useMemo(
    () =>
      memberNodes.map((n) => ({
        id: n.id,
        label: (n.data as { displayName?: string }).displayName || n.id,
      })),
    [memberNodes],
  );
  const firstMember = members[0]?.id ?? '';
  const hasMembers = members.length > 0;
  const canCondition = hasVariables || hasFlags || hasMembers;
  const newVarLeaf = (): StoryChoiceCondition => ({ var: firstVar, op: '>=', value: 0 });
  const newVisitLeaf = (): StoryVisitCondition => ({ visitedNodeId: firstMember, op: '>=', value: 1 });
  const newFlagLeaf = (): StoryFlagCondition => ({ flag: firstFlag, value: true });
  const newLeaf = (): StoryConditionLeaf => hasFlags ? newFlagLeaf() : hasVariables ? newVarLeaf() : newVisitLeaf();

  // 条件存储约定:0 条 → undefined;1 条 → 叶子;≥2 条 → 复合组。
  const leaves = conditionLeaves(condition);
  const join: 'and' | 'or' = condition && isConditionGroup(condition) ? condition.join : 'and';
  const writeCondition = (nextLeaves: StoryConditionLeaf[], nextJoin: 'and' | 'or') => {
    const next: StoryConditionExpr | undefined =
      nextLeaves.length === 0
        ? undefined
        : nextLeaves.length === 1
          ? nextLeaves[0]
          : { join: nextJoin, items: nextLeaves };
    update(edgeId, { condition: next });
  };

  useEffect(() => {
    if (!onClose) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // 输入法使用 Escape 取消候选窗；组字中不能把它当成关闭编辑器。
      if (event.key === 'Escape' && !event.isComposing) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[1001] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t('canvas.story.choiceEditorTitle')}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('common.close')}
        className="absolute inset-0 cursor-default bg-black/65 backdrop-blur-sm"
        onClick={onClose}
      />
    <div
      className="nodrag nopan relative flex max-h-[calc(100dvh-32px)] w-[min(1000px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#16181c]/98 text-sm text-white/90 shadow-[0_24px_64px_rgba(0,0,0,0.55)] backdrop-blur-xl"
      // 拦住编辑器内的指针/点击事件,避免冒泡到 ReactFlow 把选项边取消选中、误选父级故事组。
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.08] px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-white">{t('canvas.story.choiceEditorTitle')}</h2>
          <p className="mt-0.5 text-xs text-white/45">{t('canvas.story.choicePrompt')}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          aria-label={t('common.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-48 shrink-0 border-r border-white/[0.08] bg-black/15 p-3 sm:block">
          <p className={`${SECTION_LABEL_CLASS} px-2 pb-2`}>{t('canvas.story.choiceEditorTitle')}</p>
          <div className="flex max-h-full flex-col gap-1 overflow-y-auto">
            {sourceChoiceEdges.map((edge) => {
              const item = edge.data as StoryChoiceEdgeData | undefined;
              const active = edge.id === edgeId;
              return (
                <button
                  key={edge.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => selectEdge([
                    { type: 'select', id: edgeId, selected: false },
                    { type: 'select', id: edge.id, selected: true },
                  ])}
                  className={`w-full rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                    active
                      ? 'bg-cyan-300/15 text-cyan-50 ring-1 ring-cyan-200/25'
                      : 'text-white/60 hover:bg-white/[0.07] hover:text-white/90'
                  }`}
                >
                  <span className="block truncate">{item?.transitionMode === 'automatic' ? t('canvas.story.automaticTransition') : (item?.choiceText || t('canvas.story.choicePlaceholder'))}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:p-5">

      <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-white/[0.08] bg-black/[0.08] p-1.5" role="group" aria-label={t('canvas.story.transitionType')}>
        {(['visible', 'automatic'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={resolvedTransitionMode === mode}
            onClick={() => {
              update(edgeId, {
                transitionMode: mode,
                ...(mode === 'automatic' ? { choiceText: '', feedbackText: '', interaction: undefined } : {}),
              });
              if (mode === 'automatic' && isDefault) setDefault(edgeId, false);
            }}
            className={`min-h-9 rounded-lg px-3 text-xs font-medium transition-colors ${resolvedTransitionMode === mode ? 'bg-accent/20 text-white ring-1 ring-accent/35' : 'text-white/60 hover:bg-white/[0.06] hover:text-white/90'}`}
          >
            {t(mode === 'automatic' ? 'canvas.story.transitionAutomatic' : 'canvas.story.transitionVisible')}
          </button>
        ))}
      </div>

      {resolvedTransitionMode === 'visible' ? (
        <input
          {...choiceTextField}
          placeholder={t('canvas.story.choicePrompt')}
          className={`${FIELD_CLASS} w-full px-2.5 py-1.5`}
        />
      ) : (
        <p className="rounded-xl border border-accent/20 bg-accent/[0.08] px-3 py-2 text-xs leading-5 text-white/75">
          {t('canvas.story.automaticTransitionHint')}
        </p>
      )}

      {resolvedTransitionMode === 'visible' && (
      <div className="flex flex-col gap-2 rounded-xl border border-cyan-200/[0.12] bg-cyan-950/[0.08] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className={SECTION_LABEL_CLASS}>{t('canvas.story.interactionPresentation')}</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label={t('canvas.story.interactionPresentation')}>
          {([
            ['overlay', 'interactionOverlay'],
            ['object-anchor', 'interactionObjectAnchor'],
            ['baked-video', 'interactionBakedVideo'],
          ] as const).map(([presentation, label]) => (
            <button
              key={presentation}
              type="button"
              aria-pressed={choicePresentation === presentation}
              onClick={() => setPresentation(presentation)}
              className={`min-h-9 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                choicePresentation === presentation
                  ? 'border-cyan-200/45 bg-cyan-200/15 text-cyan-50'
                  : 'border-white/10 bg-black/10 text-white/55 hover:border-white/25 hover:text-white/85'
              }`}
            >
              {t(`canvas.story.${label}`)}
            </button>
          ))}
        </div>

        {isAnchored && (
          <>
            <p className="text-[11px] leading-4 text-white/45">
              {resolvedInteraction.presentation === 'baked-video'
                ? t('canvas.story.interactionBakedHint')
                : t('canvas.story.interactionAnchorHint')}
            </p>
            <div
              ref={previewFrameRef}
              data-testid="story-hotspot-preview"
              className="relative aspect-video overflow-hidden rounded-lg border border-white/10 bg-[#0b0d12]"
            >
              {previewVideoUrl ? (
                <video
                  src={previewVideoUrl}
                  muted
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    previewMediaSizeRef.current = {
                      width: event.currentTarget.videoWidth,
                      height: event.currentTarget.videoHeight,
                    };
                    measurePreviewCover();
                    seekPreviewToTailFrame(event.currentTarget);
                  }}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center px-5 text-center text-[11px] leading-4 text-white/35">
                  {t('canvas.story.interactionAnchorNoVideo')}
                </div>
              )}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 to-transparent" />
              {resolvedInteraction.presentation === 'baked-video' ? (
                <div
                  aria-label={t('canvas.story.interactionDrawHotspot')}
                  onPointerDown={(event) => startHotspotGesture(event, 'draw')}
                  onPointerMove={updateHotspotGesture}
                  onPointerUp={(event) => {
                    updateHotspotGesture(event);
                    finishHotspotGesture(event, true);
                  }}
                  onPointerCancel={(event) => finishHotspotGesture(event, false)}
                  className="absolute inset-0 z-[1] cursor-crosshair touch-none"
                />
              ) : (
                <button
                  type="button"
                  aria-label={t('canvas.story.interactionPickAnchor')}
                  onPointerDown={startAnchorDrag}
                  onPointerMove={moveAnchorDrag}
                  onPointerUp={endAnchorDrag}
                  onPointerCancel={cancelAnchorDrag}
                  className="absolute inset-0 z-[1] cursor-crosshair touch-none"
                />
              )}
              {displayAnchor && (resolvedInteraction.presentation === 'object-anchor' ? (
                <span
                  aria-hidden
                  className={`pointer-events-none absolute max-w-[68%] -translate-x-1/2 -translate-y-1/2 text-center text-xs font-semibold leading-snug ${
                    resolvedInteraction.uiStyle === 'tag' ? '' : 'px-3 py-2'
                  } ${ANCHOR_PREVIEW_STYLE_CLASS[resolvedInteraction.uiStyle]}`}
                  style={previewAnchorStyle}
                >
                  {resolvedInteraction.uiStyle === 'tag' && <TechTargetRingPreview />}
                  {resolvedInteraction.uiStyle !== 'tag' && <span>{choiceText || t('canvas.story.choicePlaceholder')}</span>}
                </span>
              ) : (
                <div
                  role="group"
                  tabIndex={0}
                  aria-label={t('canvas.story.interactionMoveHotspot')}
                  onPointerDown={(event) => startHotspotGesture(event, 'move')}
                  onPointerMove={updateHotspotGesture}
                  onPointerUp={(event) => {
                    updateHotspotGesture(event);
                    finishHotspotGesture(event, true);
                  }}
                  onPointerCancel={(event) => finishHotspotGesture(event, false)}
                  onKeyDown={moveHotspotByKeyboard}
                  className="absolute z-[2] flex min-h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 cursor-move touch-none items-center justify-center rounded-md border-2 border-accent bg-accent/15 shadow-[0_8px_24px_rgba(0,0,0,0.35)] outline-none focus-visible:ring-2 focus-visible:ring-white"
                  style={previewAnchorStyle}
                >
                  <span className="pointer-events-none whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white shadow-sm">
                    {t('canvas.story.interactionHotspotArea')} · {Math.round((displayAnchor.width ?? 0) * 100)}% × {Math.round((displayAnchor.height ?? 0) * 100)}%
                  </span>
                  {(['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
                    <button
                      key={corner}
                      type="button"
                      aria-label={t('canvas.story.interactionResizeHotspot')}
                      onPointerDown={(event) => startHotspotGesture(event, 'resize', corner)}
                      onPointerMove={updateHotspotGesture}
                      onPointerUp={(event) => {
                        updateHotspotGesture(event);
                        finishHotspotGesture(event, true);
                      }}
                      onPointerCancel={(event) => finishHotspotGesture(event, false)}
                      onKeyDown={(event) => resizeHotspotByKeyboard(event, corner)}
                      className={`absolute z-[3] flex h-8 w-8 touch-none items-center justify-center rounded-md bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-white ${HOTSPOT_HANDLE_POSITION[corner]}`}
                    >
                      <span className="pointer-events-none h-2.5 w-2.5 rounded-[2px] border border-accent bg-white shadow-[0_2px_6px_rgba(0,0,0,0.45)]" />
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {resolvedInteraction.presentation === 'object-anchor' && (
              <div className="grid grid-cols-2 gap-1.5">
                <select
                  value={resolvedInteraction.uiStyle}
                  onChange={(event) => writeInteraction({ uiStyle: event.target.value as StoryChoiceUiStyle })}
                  className={SELECT_CLASS}
                  aria-label={t('canvas.story.interactionStyle')}
                >
                  <option value="glass">{t('canvas.story.interactionStyleGlass')}</option>
                  <option value="tag">{t('canvas.story.interactionStyleTag')}</option>
                  <option value="warning">{t('canvas.story.interactionStyleWarning')}</option>
                </select>
                <select
                  value={resolvedInteraction.motion}
                  onChange={(event) => writeInteraction({ motion: event.target.value as StoryChoiceMotion })}
                  className={SELECT_CLASS}
                  aria-label={t('canvas.story.interactionMotion')}
                >
                  <option value="fade">{t('canvas.story.interactionMotionFade')}</option>
                  <option value="pop">{t('canvas.story.interactionMotionPop')}</option>
                  <option value="pulse">{t('canvas.story.interactionMotionPulse')}</option>
                </select>
              </div>
            )}
          </>
        )}
      </div>
      )}

      {resolvedTransitionMode === 'visible' && (
      <div className="flex flex-col gap-1.5 rounded-xl border border-white/[0.08] bg-black/[0.08] p-3">
        <label className={SECTION_LABEL_CLASS} htmlFor={`${edgeId}-feedback`}>
          {t('canvas.story.choiceFeedbackLabel')}
        </label>
        <textarea
          id={`${edgeId}-feedback`}
          {...feedbackTextField}
          maxLength={500}
          rows={2}
          placeholder={t('canvas.story.choiceFeedbackPlaceholder')}
          className={`${FIELD_CLASS} min-h-16 w-full resize-y px-2.5 py-1.5 leading-relaxed`}
        />
        <span className="text-[11px] leading-4 text-white/45">
          {t('canvas.story.choiceFeedbackHint')}
        </span>
      </div>
      )}

      <details className="rounded-xl border border-white/[0.08] bg-black/[0.06]">
        <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-medium text-white/60 transition-colors hover:text-white/90">
          {t('canvas.story.choiceAdvanced')}
        </summary>
        <div className="flex flex-col gap-3 border-t border-white/[0.08] p-3">
      {!hasVariables && !hasFlags && (
        <span className="rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-xs text-amber-300/90">
          {t('canvas.story.noVariablesHint')}
        </span>
      )}

      {/* 条件:多条(变量 / 去过片段)+ 单一 AND/OR 连接(≥2 条时可切换)。 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label className="flex cursor-pointer select-none items-center gap-2 font-medium text-white/80">
            <input
              type="checkbox"
              className={CHECKBOX_CLASS}
              checked={leaves.length > 0}
              disabled={!canCondition}
              onChange={(e) => writeCondition(e.target.checked ? [newLeaf()] : [], join)}
            />
            {t('canvas.story.condition')}
          </label>
          {leaves.length >= 2 && (
            <select
              value={join}
              onChange={(e) => writeCondition(leaves, e.target.value as 'and' | 'or')}
              className={SELECT_CLASS}
            >
              <option value="and">{t('canvas.story.conditionJoinAll')}</option>
              <option value="or">{t('canvas.story.conditionJoinAny')}</option>
            </select>
          )}
        </div>
        {leaves.map((leaf, i) => {
          const setLeaf = (nl: StoryConditionLeaf) => {
            const next = [...leaves];
            next[i] = nl;
            writeCondition(next, join);
          };
          return (
            <div key={i} className="flex items-center gap-1.5 pl-6">
              <select
                value={isVisitCondition(leaf) ? 'visit' : isFlagCondition(leaf) ? 'flag' : 'var'}
                onChange={(e) => setLeaf(e.target.value === 'visit' ? newVisitLeaf() : e.target.value === 'flag' ? newFlagLeaf() : newVarLeaf())}
                className={SELECT_CLASS}
              >
                <option value="flag" disabled={!hasFlags}>{t('canvas.story.condFlag')}</option>
                <option value="var" disabled={!hasVariables}>{t('canvas.story.condVar')}</option>
                <option value="visit" disabled={!hasMembers}>{t('canvas.story.condVisit')}</option>
              </select>
              {isVisitCondition(leaf) ? (
                <select
                  value={leaf.visitedNodeId}
                  onChange={(e) => setLeaf({ ...leaf, visitedNodeId: e.target.value })}
                  className={`${SELECT_CLASS} min-w-0 flex-1`}
                >
                  {members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              ) : isFlagCondition(leaf) ? (
                <select
                  value={leaf.flag}
                  onChange={(e) => setLeaf({ ...leaf, flag: e.target.value })}
                  className={`${SELECT_CLASS} min-w-0 flex-1`}
                >
                  {flags.map((flag) => <option key={flag.name} value={flag.name}>{flag.label}</option>)}
                </select>
              ) : (
                <select
                  value={leaf.var}
                  onChange={(e) => setLeaf({ ...leaf, var: e.target.value })}
                  className={`${SELECT_CLASS} min-w-0 flex-1`}
                >
                  {variables.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}
                </select>
              )}
              {isFlagCondition(leaf) ? (
                <select value={leaf.value ? 'true' : 'false'} onChange={(e) => setLeaf({ ...leaf, value: e.target.value === 'true' })} className={SELECT_CLASS}>
                  <option value="true">{t('canvas.story.flagOn')}</option>
                  <option value="false">{t('canvas.story.flagOff')}</option>
                </select>
              ) : (
                <>
                  <select
                    value={leaf.op}
                    onChange={(e) => setLeaf({ ...leaf, op: e.target.value as StoryChoiceCondition['op'] })}
                    className={SELECT_CLASS}
                  >
                    {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                  </select>
                  <input
                    type="number"
                    value={leaf.value}
                    onChange={(e) => setLeaf({ ...leaf, value: Number(e.target.value) })}
                    className={`${FIELD_CLASS} w-12`}
                  />
                </>
              )}
              <button onClick={() => writeCondition(leaves.filter((_, j) => j !== i), join)} className="rounded p-1 text-white/45 transition-colors hover:bg-white/10 hover:text-red-400" aria-label={t('common.delete')}>✕</button>
            </div>
          );
        })}
        {leaves.length > 0 && (
          <button
            disabled={!canCondition}
            onClick={() => writeCondition([...leaves, newLeaf()], join)}
            className="ml-6 self-start rounded-md border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/80 transition-colors hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
          >
            + {t('canvas.story.addCondition')}
          </button>
        )}
      </div>

      <div className="h-px bg-white/[0.07]" />

      {/* 效果 */}
      <div className="flex flex-col gap-2">
        <span className={SECTION_LABEL_CLASS}>{t('canvas.story.effects')}</span>
        {(effects ?? []).map((eff, i) => (
          <div key={i} className="flex items-center gap-1.5">
            {'flag' in eff ? (
              <>
                <select value={eff.flag} onChange={(e) => {
                  const next = [...(effects ?? [])]; next[i] = { ...eff, flag: e.target.value }; update(edgeId, { effects: next });
                }} className={`${SELECT_CLASS} min-w-0 flex-1`}>
                  {flags.map((flag) => <option key={flag.name} value={flag.name}>{flag.label}</option>)}
                </select>
                <select value={eff.value ? 'true' : 'false'} onChange={(e) => {
                  const next = [...(effects ?? [])]; next[i] = { ...eff, value: e.target.value === 'true' }; update(edgeId, { effects: next });
                }} className={SELECT_CLASS}>
                  <option value="true">{t('canvas.story.flagOn')}</option>
                  <option value="false">{t('canvas.story.flagOff')}</option>
                </select>
              </>
            ) : (
              <>
                <select value={eff.var} onChange={(e) => {
                  const next = [...(effects ?? [])]; next[i] = { ...eff, var: e.target.value }; update(edgeId, { effects: next });
                }} className={`${SELECT_CLASS} min-w-0 flex-1`}>
                  {variables.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}
                </select>
                <span className="text-white/40">+=</span>
                <input type="number" value={eff.delta} onChange={(e) => {
                  const next = [...(effects ?? [])]; next[i] = { ...eff, delta: Number(e.target.value) }; update(edgeId, { effects: next });
                }} className={`${FIELD_CLASS} w-14`} />
              </>
            )}
            <button onClick={() => update(edgeId, { effects: (effects ?? []).filter((_, j) => j !== i) })} className="rounded p-1 text-white/45 transition-colors hover:bg-white/10 hover:text-red-400" aria-label={t('common.delete')}>✕</button>
          </div>
        ))}
        <div className="flex flex-wrap gap-1.5">
          <button disabled={!hasVariables} onClick={() => update(edgeId, { effects: [...(effects ?? []), { var: firstVar, delta: 1 }] })} className="rounded-md border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/80 transition-colors hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40">
            + {t('canvas.story.addNumberEffect')}
          </button>
          <button disabled={!hasFlags} onClick={() => update(edgeId, { effects: [...(effects ?? []), { flag: firstFlag, value: true }] })} className="rounded-md border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/80 transition-colors hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40">
            + {t('canvas.story.addFlagEffect')}
          </button>
        </div>
      </div>

      {resolvedTransitionMode === 'visible' && (<>
      <div className="h-px bg-white/[0.07]" />

      {/* 限时:本片段的选择时限(写源节点,同源所有选项共享)+ 默认选项(超时自动选,同源单选)。 */}
      <div className="flex flex-col gap-2">
        <label className="flex items-center justify-between gap-2">
          <span className="font-medium text-white/80">{t('canvas.story.choiceTimeLimit')}</span>
          <span className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              value={timeLimitSec || ''}
              placeholder="0"
              onChange={(e) => {
                const n = Number(e.target.value);
                updateNodeData(sourceNodeId, {
                  choiceTimeLimitSec: Number.isFinite(n) && n > 0 ? n : undefined,
                });
              }}
              className={`${FIELD_CLASS} w-14 text-right`}
            />
            <span className="text-xs text-white/40">{t('canvas.story.choiceTimeLimitUnit')}</span>
          </span>
        </label>
        <label className="flex cursor-pointer select-none items-center gap-2 font-medium text-white/80">
          <input
            type="checkbox"
            className={CHECKBOX_CLASS}
            checked={!!isDefault}
            onChange={(e) => setDefault(edgeId, e.target.checked)}
          />
          {t('canvas.story.defaultChoiceToggle')}
        </label>
      </div>
      </>)}
        </div>
      </details>
        </div>
      </div>
    </div>
    </div>,
    document.body,
  );
});
