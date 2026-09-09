import { memo, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, ListTree, MoreHorizontal, Play, Plus, ShieldCheck, SlidersHorizontal, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Compiler } from 'inkjs/full';
import { useCanvasStore } from '@/stores/canvasStore';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import { CANVAS_NODE_TYPES, type GroupNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { compileStoryGroup } from '@/features/canvas/story/compileStoryGroup';
import { StoryCompileError } from '@/features/canvas/story/compileGraphToInk';
import { storySaveKey } from '@/features/canvas/story/storySave';
import { downloadStoryHtml } from '@/features/canvas/story/export/downloadStoryHtml';
import { readUrl } from '@/lib/url-params';
import { FREEZONE_DOCK_OFFSET_ANIMATED_STYLE } from '@/features/freezone/dockOffset';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/shadcn/dropdown-menu';

const ACTION_CLASS = 'flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-xs text-text-dark transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

/** 右上角悬浮操作组，不占据整行画布空间。 */
export const StoryGroupToolbar = memo(function StoryGroupToolbar() {
  const group = useCanvasStore((state) => {
    const active = state.nodes.find((node) => node.id === state.selectedNodeId);
    if (!active) return null;
    const candidate = active.data.storyGroup === true
      ? active : state.nodes.find((node) => node.id === active.parentId);
    return candidate?.data.storyGroup === true ? candidate : null;
  });
  const mode = useStoryRuntimeStore((state) => state.mode);
  if (!group || mode === 'play') return null;
  return <StoryGroupActions id={group.id} data={group.data as GroupNodeData} />;
});

function StoryGroupActions({ id, data }: { id: string; data: GroupNodeData }) {
  const { t } = useTranslation();
  const handleStoryGroupPlay = useCallback((groupId: string) => {
    const { nodes, edges } = useCanvasStore.getState();
    try {
      const compiled = compileStoryGroup(groupId, nodes, edges);
      // 存档按「画布 + 故事组」隔离;有存档时自动续玩。
      const saveKey = storySaveKey(readUrl().canvas ?? 'default', groupId);
      useStoryRuntimeStore.getState().enterPlay(compiled, {
        saveKey,
        groupId,
        playKind: 'entertainment',
      });
    } catch (err) {
      toast.error(err instanceof StoryCompileError ? err.message : t('canvas.story.error'));
    }
  }, [t]);

  const handleStoryGroupLive = useCallback((groupId: string) => {
    const { nodes, edges } = useCanvasStore.getState();
    try {
      const compiled = compileStoryGroup(groupId, nodes, edges);
      useStoryRuntimeStore.getState().enterPlay(compiled, { groupId, playKind: 'live' });
    } catch (err) {
      toast.error(err instanceof StoryCompileError ? err.message : t('canvas.story.error'));
    }
  }, [t]);

  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const handleStoryGroupExport = useCallback(async (groupId: string) => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    const progressToast = toast.loading(t('canvas.story.exportPreparing'));
    const { nodes, edges } = useCanvasStore.getState();
    try {
      const compiled = compileStoryGroup(groupId, nodes, edges);
      const story = new Compiler(compiled.ink).Compile();
      const storyJson = story.ToJson();
      if (!storyJson) throw new Error(t('canvas.story.error'));
      const title = (data.displayName ?? data.label ?? '').trim();
      const { buildPlayerHtml } = await import('@/features/canvas/story/export/buildPlayerHtml');
      const html = buildPlayerHtml(compiled, storyJson, {
        title,
        labels: {
          play: t('canvas.story.playMode.playCurrent'),
          mediaError: t('canvas.story.mediaError'),
          retry: t('canvas.story.retryMedia'),
          countdown: t('canvas.story.choiceCountdown'),
          flagOn: t('canvas.story.flagOn'),
          flagOff: t('canvas.story.flagOff'),
          defaultChoice: t('canvas.story.defaultChoice'),
          endingBadge: t('canvas.story.endingBadge', { label: '' }).replace(/[ ·]+$/, '').trim() || '结局',
          endingFallback: t('canvas.story.endingFallback'),
          restart: t('canvas.story.restart'),
          loadError: t('canvas.story.error'),
          placeholderBadge: t('canvas.story.placeholderBadge'),
          placeholderHint: t('canvas.story.placeholderHint'),
        },
      });
      downloadStoryHtml(html, title);
      toast.success(t('canvas.story.exportDone'), { id: progressToast });
    } catch (err) {
      toast.error(err instanceof StoryCompileError ? err.message : t('canvas.story.exportFailed'), { id: progressToast });
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }, [t, data]);


  const title = resolveNodeDisplayName(CANVAS_NODE_TYPES.group, data);
  return (
    <div
      data-story-toolbar-region
      className="pointer-events-none absolute right-4 top-1.5 z-40 max-w-[calc(100%_-_140px_-_var(--freezone-dock-width,0px))]"
      style={FREEZONE_DOCK_OFFSET_ANIMATED_STYLE}
    >
      <div
        role="toolbar"
        aria-label={t('canvas.story.toolbar')}
        title={title}
        className="nodrag nopan nowheel pointer-events-auto flex flex-wrap items-center justify-end gap-1 rounded-[10px] bg-[#262626] p-0.5 text-text-dark shadow-lg"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <button type="button" className={ACTION_CLASS} onClick={() => useCanvasStore.getState().addStorySegment(id)}>
          <Plus className="size-4" />{t('canvas.story.addSegment')}
        </button>
        <button type="button" className={ACTION_CLASS} onClick={() => handleStoryGroupPlay(id)}>
          <Play className="size-4" />{t('canvas.story.play')}
        </button>
        <button type="button" className={ACTION_CLASS} onClick={() => handleStoryGroupLive(id)}>
          <ListTree className="size-4" />{t('canvas.story.playMode.live')}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={ACTION_CLASS}><MoreHorizontal className="size-4" />{t('canvas.story.moreActions')}</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" className="min-w-48">
            <DropdownMenuItem onSelect={() => useCanvasStore.getState().openStoryVariables(id)}><SlidersHorizontal className="mr-2 size-4" />{t('canvas.story.states')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => useCanvasStore.getState().openStoryLint(id)}><ShieldCheck className="mr-2 size-4" />{t('canvas.story.lint.open')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => useCanvasStore.getState().openStoryGen(id)}><Wand2 className="mr-2 size-4" />{t('canvas.story.gen.open')}</DropdownMenuItem>
            <DropdownMenuItem disabled={exporting} onSelect={() => void handleStoryGroupExport(id)}><Download className="mr-2 size-4" />{t('canvas.story.export')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
