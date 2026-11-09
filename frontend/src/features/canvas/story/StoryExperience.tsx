import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ArrowLeft, Map, Maximize, Minimize, Undo2 } from 'lucide-react';
import { StoryPlayer } from './StoryPlayer';
import { StoryExplorationPanel } from './StoryExplorationPanel';
import { explorationSummary, previousChoiceCheckpoint } from './storyExploration';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import './storyExploration.css';

/** Public playback, author previews and playtests share this experience, including the fullscreen root. */
export function StoryExperience({ title, onExit, ...playerProps }: ComponentProps<typeof StoryPlayer> & {
  title?: string;
  onExit?: () => void;
}) {
  const { t } = playerProps;
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const nodes = useStoryRuntimeStore((s) => s.explorationNodes);
  const exploration = useStoryRuntimeStore((s) => s.exploration);
  const phase = useStoryRuntimeStore((s) => s.phase);
  const rewindPrevious = useStoryRuntimeStore((s) => s.rewindToPreviousChoice);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(true);
  const [activity, setActivity] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [rewindError, setRewindError] = useState(false);
  const summary = explorationSummary(nodes, exploration);
  const label = (key: string) => t(`canvas.story.exploration.${key}`);

  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      if (!(toolbar.current?.contains(document.activeElement) && document.activeElement?.matches(':focus-visible'))) setVisible(false);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [activity, open]);
  useEffect(() => {
    if (!immersive) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !open) setImmersive(false);
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
    };
  }, [immersive, open]);

  const reveal = () => { setVisible(true); setActivity((value) => value + 1); };
  async function toggleFullscreen() {
    setFullscreenError(false);
    if (immersive) { setImmersive(false); return; }
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else if (root.current?.requestFullscreen) await root.current.requestFullscreen({ navigationUI: 'hide' });
      else setImmersive(true);
    } catch {
      setImmersive(true);
      setFullscreenError(true);
    }
  }
  function exit() {
    if (document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => {});
    setImmersive(false);
    onExit?.();
  }
  return (
    <div ref={root} className="story-experience" data-immersive={immersive || undefined}
      onPointerMove={() => { if (!open) reveal(); }} onPointerDown={() => { if (!open) reveal(); }} onFocusCapture={() => { if (!open) reveal(); }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || open) return;
        if (document.fullscreenElement === root.current) event.stopPropagation();
        if (immersive) { event.preventDefault(); event.stopPropagation(); setImmersive(false); }
      }}>
      <div ref={toolbar} className="story-experience-toolbar" inert={open} data-visible={visible || open}>
        {onExit && <button type="button" onClick={exit} aria-label={label('back')}><ArrowLeft size={18} /><span className="story-experience-back-label">{label('back')}</span></button>}
        {title && <span className="story-experience-title">{title}</span>}
        <div className="story-experience-tools">
          {previousChoiceCheckpoint(exploration) && phase !== 'error' && <button type="button"
            className="story-experience-icon-button"
            onClick={() => setRewindError(!rewindPrevious())} aria-label={label('previousChoice')} title={label('previousChoice')}>
            <Undo2 size={18} />
          </button>}
          {nodes.length > 0 && phase !== 'error' && <button type="button" onClick={() => setOpen(true)}
            aria-label={label('open')} aria-expanded={open} aria-haspopup="dialog">
            <Map size={18} /><span className="story-experience-exploration-label">{label('title')}</span><span className="story-experience-percent">{summary.percent}%</span>
          </button>}
          <button type="button" onClick={() => void toggleFullscreen()}
            className="story-experience-icon-button"
            aria-label={label(fullscreen || immersive ? 'exitFullscreen' : 'fullscreen')} aria-pressed={fullscreen || immersive}>
            {fullscreen || immersive ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>
        </div>
      </div>
      {fullscreenError && immersive && <p role="status" className="story-experience-notice">{label('fullscreenFallback')}</p>}
      {rewindError && <p role="alert" className="story-experience-notice">{label('rewindError')}</p>}
      <div className="story-experience-playback" inert={open}><StoryPlayer {...playerProps}
        onExplore={() => { setOpen(true); reveal(); }} paused={open || playerProps.paused} /></div>
      {open && <StoryExplorationPanel t={t}
        onClose={() => { setOpen(false); reveal(); }} />}
    </div>
  );
}
