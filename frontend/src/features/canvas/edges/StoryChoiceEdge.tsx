import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { Pencil, Crosshair } from 'lucide-react';

import { useShallow } from 'zustand/react/shallow';

import { StoryChoiceEditor } from '@/components/canvas/StoryChoiceEditor';
import { useCanvasStore } from '@/stores/canvasStore';
import { STORY_CHOICE_EDGE_TYPE, type StoryChoiceEdgeData } from '@/features/canvas/story/storyTypes';
import { selectStoryVariablesForEdgeSource } from '@/features/canvas/story/storyVariableSelectors';

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
  const selectEdge = useCanvasStore((s) => s.onEdgesChange);
  const hasAnchoredInteraction = edgeData?.interaction?.presentation === 'object-anchor'
    || edgeData?.interaction?.presentation === 'baked-video';
  const groupVariables = useCanvasStore(
    useShallow((s) => selectStoryVariablesForEdgeSource(s.nodes, source)),
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
        style={{ stroke: 'rgb(var(--accent-rgb) / 0.7)', strokeWidth: 2 }}
      />
      <EdgeLabelRenderer>
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
          className="nodrag nopan group absolute flex max-w-[180px] items-center gap-1 rounded-full border border-white/15 bg-[#17191d]/95 px-3 py-1 text-left text-xs text-white/90 shadow-lg backdrop-blur transition-colors hover:border-cyan-200/45 hover:bg-[#20242a]"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
        >
          <span className="min-w-0 truncate">{choiceText || t('canvas.story.choicePlaceholder')}</span>
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
            isDefault={edgeData?.isDefault}
            variables={groupVariables}
            onClose={() => selectEdge([{ type: 'select', id, selected: false }])}
          />
        )}
      </EdgeLabelRenderer>
    </>
  );
});
