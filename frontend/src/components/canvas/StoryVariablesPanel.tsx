import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, X } from 'lucide-react';

import { useShallow } from 'zustand/react/shallow';

import { useCanvasStore } from '@/stores/canvasStore';
import { selectGroupStoryFlags, selectGroupStoryVariables } from '@/features/canvas/story/storyVariableSelectors';

/** 故事变量面板:按组增/删变量、改 label 与初始值。变量 name 创建后只读。 */
export const StoryVariablesPanel = memo(function StoryVariablesPanel({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const variables = useCanvasStore(useShallow((s) => selectGroupStoryVariables(s.nodes, groupId)));
  const flags = useCanvasStore(useShallow((s) => selectGroupStoryFlags(s.nodes, groupId)));
  const addStoryVariable = useCanvasStore((s) => s.addStoryVariable);
  const updateStoryVariable = useCanvasStore((s) => s.updateStoryVariable);
  const removeStoryVariable = useCanvasStore((s) => s.removeStoryVariable);
  const addStoryFlag = useCanvasStore((s) => s.addStoryFlag);
  const updateStoryFlag = useCanvasStore((s) => s.updateStoryFlag);
  const removeStoryFlag = useCanvasStore((s) => s.removeStoryFlag);
  const [newLabel, setNewLabel] = useState('');
  const [newFlagLabel, setNewFlagLabel] = useState('');

  return (
    <div className="absolute right-4 top-16 z-30 w-80 rounded-xl border border-white/15 bg-[#17191d]/97 p-3 text-white/90 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{t('canvas.story.states')}</span>
        <button onClick={onClose} aria-label={t('common.close')} className="text-white/60 hover:text-white"><X className="h-4 w-4" /></button>
      </div>
      <p className="mb-2 text-xs font-medium text-white/70">{t('canvas.story.numberStates')}</p>
      <div className="flex flex-col gap-2">
        {variables.map((v) => (
          <div key={v.name} className="flex items-center gap-2">
            <input value={v.label} onChange={(e) => updateStoryVariable(groupId, v.name, { label: e.target.value })} className="min-w-0 flex-1 rounded bg-white/5 px-2 py-1 text-sm outline-none focus:bg-white/10" />
            <input type="number" value={v.initial} onChange={(e) => updateStoryVariable(groupId, v.name, { initial: Number(e.target.value) })} className="w-16 rounded bg-white/5 px-2 py-1 text-sm outline-none focus:bg-white/10" />
            <button onClick={() => removeStoryVariable(groupId, v.name)} className="text-white/50 hover:text-red-400" aria-label={t('common.delete')}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder={t('canvas.story.newVariablePlaceholder')} className="min-w-0 flex-1 rounded bg-white/5 px-2 py-1 text-sm outline-none focus:bg-white/10" />
        <button onClick={() => { if (!newLabel.trim()) return; addStoryVariable(groupId, newLabel.trim()); setNewLabel(''); }} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-sm hover:bg-white/20"><Plus className="h-4 w-4" /></button>
      </div>
      <div className="my-3 h-px bg-white/[0.08]" />
      <p className="mb-2 text-xs font-medium text-white/70">{t('canvas.story.flagStates')}</p>
      <div className="flex flex-col gap-2">
        {flags.map((flag) => (
          <div key={flag.name} className="flex items-center gap-2">
            <input value={flag.label} onChange={(e) => updateStoryFlag(groupId, flag.name, { label: e.target.value })} className="min-w-0 flex-1 rounded bg-white/5 px-2 py-1 text-sm outline-none focus:bg-white/10" />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-white/70">
              <input type="checkbox" checked={flag.initial} onChange={(e) => updateStoryFlag(groupId, flag.name, { initial: e.target.checked })} className="accent-[rgb(var(--accent-rgb))]" />
              {t('canvas.story.initiallyOn')}
            </label>
            <button onClick={() => removeStoryFlag(groupId, flag.name)} className="text-white/50 hover:text-red-400" aria-label={t('common.delete')}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input value={newFlagLabel} onChange={(e) => setNewFlagLabel(e.target.value)} placeholder={t('canvas.story.newFlagPlaceholder')} className="min-w-0 flex-1 rounded bg-white/5 px-2 py-1 text-sm outline-none focus:bg-white/10" />
        <button onClick={() => { if (!newFlagLabel.trim()) return; addStoryFlag(groupId, newFlagLabel.trim()); setNewFlagLabel(''); }} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-sm hover:bg-white/20" aria-label={t('canvas.story.addFlag')}><Plus className="h-4 w-4" /></button>
      </div>
    </div>
  );
});
