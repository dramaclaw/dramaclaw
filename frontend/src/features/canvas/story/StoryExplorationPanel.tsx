import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import { explorationSummary } from './storyExploration';
import { StoryBranchGraph } from './StoryBranchGraph';

export function StoryExplorationPanel({ t, onClose }: {
  t: (key: string, values?: Record<string, unknown>) => string;
  onClose: () => void;
}) {
  const nodes = useStoryRuntimeStore((s) => s.explorationNodes);
  const exploration = useStoryRuntimeStore((s) => s.exploration);
  const currentNodeId = useStoryRuntimeStore((s) => s.currentNodeId);
  const rewind = useStoryRuntimeStore((s) => s.rewindToNode);
  const clear = useStoryRuntimeStore((s) => s.clearProgress);
  const panel = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const summary = explorationSummary(nodes, exploration);
  const label = (key: string, values?: Record<string, unknown>) => t(`canvas.story.exploration.${key}`, values);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return (
    <div className="story-exploration-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside ref={panel} role="dialog" aria-modal="true" aria-label={label('title')} className="story-exploration-panel" data-wide="true"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
          if (event.key !== 'Tab') return;
          const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? []);
          const first = items[0], last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <header className="story-exploration-header"><div><h2>{label('title')}</h2><p className="story-exploration-summary">{label('counts', { done: summary.explored, total: summary.total, endings: summary.reachedEndings, totalEndings: summary.totalEndings })}</p></div>
          <button type="button" onClick={onClose} aria-label={label('close')}><X size={20} /></button>
        </header>
        <div className="story-exploration-scroll">
          <section className="story-exploration-map">
            <StoryBranchGraph nodes={nodes} exploration={exploration} currentNodeId={currentNodeId}
              selected={selected} t={t} onSelect={(id) => { setSelected(id); setError(false); }}
              onClear={() => { clear(); onClose(); }}
              onRewind={(id) => { if (rewind(id)) onClose(); else setError(true); }} />
          </section>
          {error && <p role="alert">{label('rewindError')}</p>}
        </div>
      </aside>
    </div>
  );
}
