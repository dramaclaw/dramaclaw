import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { Pencil, Crosshair, Scissors } from 'lucide-react';

import { useShallow } from 'zustand/react/shallow';

import { StoryChoiceEditor } from '@/components/canvas/StoryChoiceEditor';
import { useCanvasStore } from '@/stores/canvasStore';
import { isPresetManagedEdge } from '@/features/canvas/domain/mainlineNodeFlags';
import type { CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type StoryChoiceEdgeData } from '@/features/canvas/story/storyTypes';
import { selectStoryFlagsForEdgeSource, selectStoryVariablesForEdgeSource } from '@/features/canvas/story/storyVariableSelectors';

/** 同一对节点之间多条选项边时,相邻曲线上下错开的步长(px)。 */
const PARALLEL_OFFSET_STEP = 48;

/**
 * 故事选项边:贝塞尔曲线 + 中点可读的选项文案 chip。
 * 点击选择 chip 后打开居中编辑弹窗(文案/互动/条件/效果)。
 */
export const StoryChoiceEdge = memo(function StoryChoiceEdge(props: EdgeProps) {
  const { id, source, target, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, markerEnd, data, selected } = props;
  const { t } = useTranslation();
  const edgeData = data as StoryChoiceEdgeData | undefined;
  const choiceText = edgeData?.choiceText ?? '';
  const isAutomatic = edgeData?.transitionMode === 'automatic';
  const selectEdge = useCanvasStore((s) => s.onEdgesChange);
  const deleteEdge = useCanvasStore((s) => s.deleteEdge);
  const locked = isPresetManagedEdge({ id, source, target, data } as CanvasEdge);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionRegion = useRef<HTMLDivElement | null>(null);
  const edgeRegion = useRef<SVGPathElement | null>(null);
  const enter = () => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    if (locked || showDisconnect || hoverTimer.current !== null) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setShowDisconnect(true);
    }, 500);
  };
  const leave = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      // SVG 连线与 HTML 标签是两个独立层，切层时 leave 可能晚于 enter。
      // 以当前真实悬停/焦点为准，避免旧计时器收起正在操作的剪刀。
      if (actionRegion.current?.matches(':hover')
        || edgeRegion.current?.matches(':hover')
        || actionRegion.current?.contains(document.activeElement)) return;
      setShowDisconnect(false);
    }, 800);
  };
  useEffect(() => () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
  }, []);
  const hasAnchoredInteraction = edgeData?.interaction?.presentation === 'object-anchor'
    || edgeData?.interaction?.presentation === 'baked-video';
  const groupVariables = useCanvasStore(
    useShallow((s) => selectStoryVariablesForEdgeSource(s.nodes, source)),
  );
  const groupFlags = useCanvasStore(
    useShallow((s) => selectStoryFlagsForEdgeSource(s.nodes, source)),
  );
  // 本边在「同一对节点的所有选项边」里的序号与总数 —— 返回基本类型(useShallow 比较),
  // 避免每次返回新对象触发无限重渲染。
  const { parallelIndex, parallelCount } = useCanvasStore(
    useShallow((s) => {
      const siblings = s.edges.filter(
        (e) => e.type === STORY_CHOICE_EDGE_TYPE && e.source === source && e.target === target,
      );
      const idx = siblings.findIndex((e) => e.id === id);
      return { parallelIndex: idx < 0 ? 0 : idx, parallelCount: siblings.length };
    }),
  );

  const [bezierPath, bezierLabelX, bezierLabelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });
  // 单条边:用原始贝塞尔。多条平行边:按序号把曲线上下错开成扇形,各自可见可点。
  const offset = parallelCount > 1 ? (parallelIndex - (parallelCount - 1) / 2) * PARALLEL_OFFSET_STEP : 0;
  let edgePath = bezierPath;
  let labelX = bezierLabelX;
  let labelY = bezierLabelY;
  if (offset !== 0) {
    const cx = (sourceX + targetX) / 2;
    edgePath = `M ${sourceX},${sourceY} C ${cx},${sourceY + offset} ${cx},${targetY + offset} ${targetX},${targetY}`;
    labelX = cx;
    labelY = (sourceY + targetY) / 2 + offset * 0.75;
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ stroke: 'rgb(var(--accent-rgb) / 0.7)', strokeWidth: 2, strokeDasharray: isAutomatic ? '7 5' : undefined }}
      />
      <path
        ref={edgeRegion}
        className="nodrag nopan"
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        style={{ pointerEvents: 'stroke' }}
        onPointerEnter={enter}
        onPointerLeave={leave}
      />
      <EdgeLabelRenderer>
        <div
          ref={actionRegion}
          // 分组内的边会被 React Flow 提升到 z=1001；标签操作区必须高于边的命中层。
          className="nodrag nopan absolute z-[1002]"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onFocus={enter}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) leave();
          }}
        >
        {/* 选项文案 chip */}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            // EdgeLabelRenderer 的标签不在 SVG 边上，点击不会自动触发 React Flow 的边选中。
            // 显式选中后才显示该选项的剧情、反馈和锚点编辑器。
            selectEdge([{ type: 'select', id, selected: true }]);
          }}
          title={t('canvas.story.choiceEditorTitle')}
          aria-label={t('canvas.story.choiceEditorTitle')}
          className="nodrag nopan group flex max-w-[180px] items-center gap-1 rounded-full border border-white/15 bg-[#17191d]/95 px-3 py-1 text-left text-xs text-white/90 shadow-lg backdrop-blur transition-colors hover:border-cyan-200/45 hover:bg-[#20242a]"
        >
          <span className="min-w-0 truncate">{isAutomatic ? t('canvas.story.automaticTransition') : (choiceText || t('canvas.story.choicePlaceholder'))}</span>
          {edgeData?.condition && <span className="ml-1 opacity-70">{'{}'}</span>}
          {edgeData?.effects && edgeData.effects.length > 0 && <span className="ml-1 opacity-70">±</span>}
          {hasAnchoredInteraction && <Crosshair className="h-3 w-3 shrink-0 text-cyan-200" aria-hidden />}
          {edgeData?.needsReview && (
            <span className="ml-1 text-amber-400" title={edgeData.reviewNote}>
              ⚠
            </span>
          )}
          <Pencil className="h-3 w-3 shrink-0 text-white/40 transition-colors group-hover:text-cyan-100" aria-hidden />
        </button>
        {showDisconnect && !locked && (
          <div
            className="absolute left-full top-1/2 -translate-y-1/2 py-3 pl-2 pr-3"
            onPointerEnter={enter}
            onPointerLeave={leave}
          >
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-[#17191d]/95 text-white/85 shadow-[0_12px_28px_rgba(0,0,0,0.45)] transition-colors hover:border-white/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              title={t('canvas.story.disconnect')}
              aria-label={t('canvas.story.disconnect')}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                deleteEdge(id);
              }}
            >
              <Scissors className="h-6 w-6 stroke-[2.35]" />
            </button>
          </div>
        )}
        </div>

        {/* 选中时打开编辑弹窗；不再受边中点和故事组层级的尺寸限制。 */}
        {selected && (
          <StoryChoiceEditor
            edgeId={id}
            sourceNodeId={source}
            choiceText={choiceText}
            feedbackText={edgeData?.feedbackText}
            interaction={edgeData?.interaction}
            condition={edgeData?.condition}
            effects={edgeData?.effects}
            transitionMode={edgeData?.transitionMode}
            isDefault={edgeData?.isDefault}
            variables={groupVariables}
            flags={groupFlags}
            onClose={() => selectEdge([{ type: 'select', id, selected: false }])}
          />
        )}
      </EdgeLabelRenderer>
    </>
  );
});
