import { createPortal } from 'react-dom';
import { StoryPublicationPanel } from '@/features/canvas/story/StoryPublicationPanel';
import { StoryOverviewPanel } from '@/components/canvas/StoryOverviewPanel';
import { memo, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, ListTree, Play, ScrollText, ShieldCheck, SlidersHorizontal, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useCanvasStore } from '@/stores/canvasStore';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import { CANVAS_NODE_TYPES, type GroupNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { compileStoryGroup } from '@/features/canvas/story/compileStoryGroup';
import { StoryCompileError } from '@/features/canvas/story/compileGraphToInk';
import { storySaveKey } from '@/features/canvas/story/storySave';
import { readUrl } from '@/lib/url-params';
import { FREEZONE_DOCK_OFFSET_ANIMATED_STYLE } from '@/features/freezone/dockOffset';

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
  const [publishing, setPublishing] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  if (!group || (mode === 'play' && !publishing)) return null;
  return <><StoryGroupActions id={group.id} data={group.data as GroupNodeData} onPublish={() => setPublishing(true)} onOverview={() => setOverviewOpen(true)} />{publishing && createPortal(<StoryPublicationPanel groupId={group.id} title={String(group.data.displayName ?? group.data.label ?? '')} onClose={() => setPublishing(false)} />, document.body)}{overviewOpen && createPortal(<StoryOverviewPanel groupId={group.id} onClose={() => setOverviewOpen(false)} />, document.body)}</>;
});

function StoryGroupActions({ id, data, onPublish, onOverview }: { id: string; data: GroupNodeData; onPublish: () => void; onOverview: () => void }) {
  const { t } = useTranslation();
  const exportingRef = useRef(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const handleExport = async () => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExportProgress('');
    try {
      const { nodes, edges } = useCanvasStore.getState();
      const compiled = compileStoryGroup(id, nodes, edges);
      const [{ Compiler }, { buildStoryZip }, { downloadBlobAsFile }, { safeFileName }] = await Promise.all([
        import('inkjs/full'),
        import('@/features/canvas/story/export/buildStoryZip'),
        import('@/lib/browserDownload'),
        import('@/features/canvas/story/export/downloadStoryHtml'),
      ]);
      const storyJson = new Compiler(compiled.ink).Compile().ToJson();
      if (!storyJson) throw new Error('story-compile-failed');
      const title = resolveNodeDisplayName(CANVAS_NODE_TYPES.group, data);
      const zip = await buildStoryZip(compiled, storyJson, title, (done, total) => setExportProgress(`${done}/${total}`));
      downloadBlobAsFile(zip, safeFileName(title).replace(/\.html$/, '.zip'));
      toast.success(t('canvas.story.htmlExport.success'));
    } catch (error) {
      toast.error(error instanceof StoryCompileError ? error.message : t('canvas.story.htmlExport.failed'));
    } finally {
      exportingRef.current = false;
      setExportProgress(null);
    }
  };
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
        <button type="button" className={ACTION_CLASS} onClick={() => handleStoryGroupPlay(id)}>
          <Play className="size-4" />{t('canvas.story.play')}
        </button>
        <button type="button" className={ACTION_CLASS} onClick={() => handleStoryGroupLive(id)}>
          <ListTree className="size-4" />{t('canvas.story.playMode.live')}
        </button>
        <button type="button" className={ACTION_CLASS} onClick={onOverview}>
          <ScrollText className="size-4" />{t('canvas.story.overview.open')}
        </button>
        <button type="button" className={ACTION_CLASS} onClick={() => useCanvasStore.getState().openStoryVariables(id)}>
          <SlidersHorizontal className="size-4" />{t('canvas.story.states')}
        </button>
        <button type="button" className={ACTION_CLASS} onClick={() => useCanvasStore.getState().openStoryLint(id)}>
          <ShieldCheck className="size-4" />{t('canvas.story.lint.open')}
        </button>
        <button type="button" className={`${ACTION_CLASS} disabled:cursor-not-allowed disabled:opacity-40`}
          disabled={exportProgress !== null} aria-busy={exportProgress !== null}
          title={t('canvas.story.htmlExport.hint')} onClick={() => void handleExport()}>
          <Download className="size-4" aria-hidden="true" />
          {exportProgress !== null ? t('canvas.story.htmlExport.progress', { progress: exportProgress }) : t('canvas.story.htmlExport.label')}
        </button>
        <button type="button" className={ACTION_CLASS} onClick={onPublish}>
          <Upload className="size-4" aria-hidden="true" />{t('storyPublication.publish')}
        </button>
      </div>
    </div>
  );
}
