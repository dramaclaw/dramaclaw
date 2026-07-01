import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { useCanvasStore } from '@/stores/canvasStore';
import { isVideoNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type {
  StoryChoiceCondition,
  StoryChoiceEffect,
  StoryConditionExpr,
  StoryConditionLeaf,
  StoryVariable,
  StoryVisitCondition,
} from '@/features/canvas/story/storyTypes';
import { conditionLeaves, isConditionGroup, isVisitCondition } from '@/features/canvas/story/conditionExpr';

const OPS: StoryChoiceCondition['op'][] = ['>=', '<=', '==', '>', '<'];

/** 稳定的空成员数组引用:无故事组分支回退到它,避免 selector 每次返回新 [] 触发重渲染。 */
const EMPTY_MEMBER_NODES: CanvasNode[] = [];

const FIELD_CLASS =
  'rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-white/90 outline-none transition-colors focus:border-accent/50 focus:bg-white/[0.08]';
const SELECT_CLASS = `${FIELD_CLASS} cursor-pointer`;
const CHECKBOX_CLASS = 'h-3.5 w-3.5 shrink-0 accent-[rgb(var(--accent-rgb))]';
const SECTION_LABEL_CLASS = 'text-[11px] font-medium uppercase tracking-wide text-white/45';

/** 选项编辑器:编辑某条 storyChoiceEdge 的文案 / 条件 / 效果。挂在边中点上方。 */
export const StoryChoiceEditor = memo(function StoryChoiceEditor({
  edgeId,
  sourceNodeId,
  choiceText,
  condition,
  effects,
  isDefault,
  variables,
}: {
  edgeId: string;
  sourceNodeId: string;
  choiceText: string;
  condition?: StoryConditionExpr;
  effects?: StoryChoiceEffect[];
  isDefault?: boolean;
  variables: StoryVariable[];
}) {
  const { t } = useTranslation();
  const update = useCanvasStore((s) => s.updateStoryChoiceEdgeData);
  const setDefault = useCanvasStore((s) => s.setStoryDefaultChoice);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const timeLimitSec = useCanvasStore((s) => {
    const node = s.nodes.find((n) => n.id === sourceNodeId);
    const v = (node?.data as { choiceTimeLimitSec?: number } | undefined)?.choiceTimeLimitSec;
    return typeof v === 'number' ? v : 0;
  });
  const firstVar = variables[0]?.name ?? '';
  const hasVariables = variables.length > 0;

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
  const canCondition = hasVariables || hasMembers;
  const newVarLeaf = (): StoryChoiceCondition => ({ var: firstVar, op: '>=', value: 0 });
  const newVisitLeaf = (): StoryVisitCondition => ({ visitedNodeId: firstMember, op: '>=', value: 1 });
  const newLeaf = (): StoryConditionLeaf => (hasVariables ? newVarLeaf() : newVisitLeaf());

  // 条件存储约定:0 条 → undefined;1 条 → 叶子(保持旧形态);≥2 条 → 复合组。
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

  return (
    <div
      className="nodrag nopan flex w-80 flex-col gap-3 rounded-2xl border border-white/10 bg-[#16181c]/98 p-3.5 text-sm text-white/90 shadow-[0_24px_64px_rgba(0,0,0,0.55)] backdrop-blur-xl"
      // 拦住编辑器内的指针/点击事件,避免冒泡到 ReactFlow 把选项边取消选中、误选父级故事组。
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 标题 */}
      <span className={SECTION_LABEL_CLASS}>{t('canvas.story.choiceEditorTitle')}</span>

      <input
        value={choiceText}
        onChange={(e) => update(edgeId, { choiceText: e.target.value })}
        placeholder={t('canvas.story.choicePrompt')}
        className={`${FIELD_CLASS} w-full px-2.5 py-1.5`}
      />

      {!hasVariables && (
        <span className="rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-xs text-amber-300/90">
          {t('canvas.story.noVariablesHint')}
        </span>
      )}

      <div className="h-px bg-white/[0.07]" />

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
                value={isVisitCondition(leaf) ? 'visit' : 'var'}
                onChange={(e) => setLeaf(e.target.value === 'visit' ? newVisitLeaf() : newVarLeaf())}
                className={SELECT_CLASS}
              >
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
              ) : (
                <select
                  value={leaf.var}
                  onChange={(e) => setLeaf({ ...leaf, var: e.target.value })}
                  className={`${SELECT_CLASS} min-w-0 flex-1`}
                >
                  {variables.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}
                </select>
              )}
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
            <select value={eff.var} onChange={(e) => {
              const next = [...(effects ?? [])]; next[i] = { ...eff, var: e.target.value }; update(edgeId, { effects: next });
            }} className={`${SELECT_CLASS} min-w-0 flex-1`}>
              {variables.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}
            </select>
            <span className="text-white/40">+=</span>
            <input type="number" value={eff.delta} onChange={(e) => {
              const next = [...(effects ?? [])]; next[i] = { ...eff, delta: Number(e.target.value) }; update(edgeId, { effects: next });
            }} className={`${FIELD_CLASS} w-14`} />
            <button onClick={() => update(edgeId, { effects: (effects ?? []).filter((_, j) => j !== i) })} className="rounded p-1 text-white/45 transition-colors hover:bg-white/10 hover:text-red-400" aria-label={t('common.delete')}>✕</button>
          </div>
        ))}
        <button
          disabled={variables.length === 0}
          onClick={() => update(edgeId, { effects: [...(effects ?? []), { var: firstVar, delta: 1 }] })}
          className="self-start rounded-md border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/80 transition-colors hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
        >
          + {t('canvas.story.addEffect')}
        </button>
      </div>

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
    </div>
  );
});
