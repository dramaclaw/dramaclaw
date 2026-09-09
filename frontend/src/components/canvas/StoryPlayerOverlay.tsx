import { memo, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BarChart3, ChevronLeft, CirclePlay, Gauge, Map, Pause, Play, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { StoryCompileError } from '@/features/canvas/story/compileGraphToInk';
import { compileStoryGroup } from '@/features/canvas/story/compileStoryGroup';
import { storySaveKey } from '@/features/canvas/story/storySave';
import { StoryPlayer } from '@/features/canvas/story/StoryPlayer';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import { resolveMediaUrl } from '@/lib/media-url';
import { StoryStatsPanel } from './StoryStatsPanel';
import { StoryPathMap } from './StoryPathMap';
import { StoryPlaytestTree } from './StoryPlaytestTree';
export { STORY_OUTCOME_FEEDBACK_MS } from '@/features/canvas/story/StoryPlayer';

export const StoryPlayerOverlay = memo(function StoryPlayerOverlay() {
  const { t } = useTranslation();
  const mode = useStoryRuntimeStore((s) => s.mode);
  const playKind = useStoryRuntimeStore((s) => s.playKind);
  const phase = useStoryRuntimeStore((s) => s.phase);
  const currentNodeId = useStoryRuntimeStore((s) => s.currentNodeId);
  const statsKey = useStoryRuntimeStore((s) => s.statsKey);
  const groupId = useStoryRuntimeStore((s) => s.groupId);
  const resumeAvailable = useStoryRuntimeStore((s) => s.resumeAvailable);
  const restart = useStoryRuntimeStore((s) => s.restart);
  const resumeSaved = useStoryRuntimeStore((s) => s.resumeSaved);
  const exitPlay = useStoryRuntimeStore((s) => s.exitPlay);
  const enterPlay = useStoryRuntimeStore((s) => s.enterPlay);
  const currentNodeLabel = useCanvasStore((state) => {
    const node = currentNodeId ? state.nodes.find((candidate) => candidate.id === currentNodeId) : null;
    return node?.type ? resolveNodeDisplayName(node.type, node.data) : '';
  });

  const [statsOpen, setStatsOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playbackRevision, setPlaybackRevision] = useState(0);
  // 试玩模式直接恢复剧情存档；失效存档由 runtime 清理并回到起点。
  useEffect(() => {
    if (mode !== 'play' || playKind !== 'entertainment' || !resumeAvailable) return;
    if (!resumeSaved()) toast(t('canvas.story.resume.invalid'));
  }, [mode, playKind, resumeAvailable, resumeSaved, t]);
  const startPlayback = useCallback((kind: 'entertainment' | 'live', entryNodeId?: string) => {
    if (!groupId) return;
    const { nodes, edges } = useCanvasStore.getState();
    try {
      const compiled = compileStoryGroup(groupId, nodes, edges, entryNodeId ? { entryNodeId } : {});
      const saveKey = kind === 'entertainment'
        ? storySaveKey(readUrl().canvas ?? 'default', groupId)
        : undefined;
      setStatsOpen(false);
      setMapOpen(false);
      setPlaybackRevision((value) => value + 1);
      enterPlay(compiled, { saveKey, groupId, playKind: kind });
    } catch (err) {
      toast.error(err instanceof StoryCompileError ? err.message : t('canvas.story.error'));
    }
  }, [enterPlay, groupId, t]);

  const handleRestart = useCallback(() => {
    if (playKind === 'live') {
      startPlayback('live');
      return;
    }
    setPlaybackRevision((value) => value + 1);
    restart();
  }, [playKind, restart, startPlayback]);

  const handleEditCurrentNode = useCallback(() => {
    if (!currentNodeId) return;
    const canvas = useCanvasStore.getState();
    // Keep ReactFlow selection in sync, otherwise Canvas restores the old selection.
    canvas.onNodesChange(canvas.nodes.map((node) => ({
      type: 'select' as const, id: node.id, selected: node.id === currentNodeId,
    })));
    canvas.onEdgesChange(canvas.edges.filter((edge) => edge.selected).map((edge) => ({
      type: 'select' as const, id: edge.id, selected: false,
    })));
    canvas.setSelectedNode(currentNodeId);
    canvas.setStoryEditNode(currentNodeId);
    canvas.requestFocusNode(currentNodeId);
    exitPlay();
  }, [currentNodeId, exitPlay]);

  const handleAddNode = useCallback(() => {
    if (!groupId) return;
    const nodeId = useCanvasStore.getState().addStorySegment(groupId);
    if (nodeId) exitPlay();
  }, [exitPlay, groupId]);

  const toggleAutoPlay = useCallback(() => setAutoPlayEnabled((enabled) => !enabled), []);

  const cyclePlaybackRate = useCallback(() => {
    const rates = [0.5, 1, 1.5, 2];
    setPlaybackRate((current) => rates[(rates.indexOf(current) + 1) % rates.length]);
  }, []);

  const handleModeChange = useCallback((kind: 'entertainment' | 'live') => {
    if (kind === playKind) return;
    startPlayback(kind, kind === 'live' ? currentNodeId ?? undefined : undefined);
  }, [currentNodeId, playKind, startPlayback]);

  if (mode !== 'play') return null;

  return createPortal(
    <div className="fixed inset-0 z-[220] flex flex-col bg-[#090909] text-[#e2e2e3]">
      <header className="flex min-h-14 shrink-0 flex-wrap justify-between gap-2 items-center border-b border-white/[0.08] bg-[#090909] px-2 py-2 sm:px-4">
        <button
          type="button"
          onClick={exitPlay}
          className="flex h-9 w-fit items-center gap-1 rounded-lg px-3 text-sm font-medium text-[#8f9099] transition-colors hover:bg-[#1a1c23] hover:text-[#e2e2e3]"
        >
          <ChevronLeft className="size-4" />
          {t('canvas.story.playMode.backToCanvas')}
        </button>
        {groupId && (
          <div className="mx-auto flex items-center rounded-lg border border-white/[0.08] bg-[#111218] p-1">
            <button
              type="button"
              onClick={() => handleModeChange('entertainment')}
              aria-pressed={playKind === 'entertainment'}
              className={`flex h-8 items-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors ${
                playKind === 'entertainment'
                  ? 'border-white/[0.08] bg-[#1e212b] text-[#e2e2e3]'
                  : 'border-transparent text-[#8f9099] hover:text-[#e2e2e3]'
              }`}
            >
              <CirclePlay className="size-4" />
              {t('canvas.story.playMode.entertainment')}
            </button>
            <button
              type="button"
              onClick={() => handleModeChange('live')}
              aria-pressed={playKind === 'live'}
              className={`flex h-8 items-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors ${
                playKind === 'live'
                  ? 'border-[oklch(0.72_0.145_205/0.2)] bg-[oklch(0.72_0.145_205/0.1)] text-[oklch(0.72_0.145_205)]'
                  : 'border-transparent text-[#8f9099] hover:text-[#e2e2e3]'
              }`}
            >
              <Sparkles className="size-4" />
              {t('canvas.story.playMode.live')}
            </button>
          </div>
        )}
        <div aria-hidden />
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {playKind === 'live' && groupId && (
          <div className="flex min-h-0 max-h-[25dvh] shrink-0 overflow-auto sm:max-h-none [&>aside]:w-full sm:[&>aside]:w-[340px]">
          <StoryPlaytestTree
            groupId={groupId}
            selectedNodeId={currentNodeId}
            onSelectNode={(nodeId) => startPlayback('live', nodeId)}
            onAddNode={handleAddNode}
          />
          </div>
        )}
        <main className={`min-h-0 min-w-0 flex-1 overflow-hidden ${playKind === 'live' ? 'flex flex-col bg-[#090909] p-2 sm:p-6' : 'flex flex-col bg-black'}`}>
          {playKind === 'live' && (
            <div className="z-50 mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2 py-2 rounded-xl border border-white/[0.08] bg-[#111218]/80 px-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[#e2e2e3]">
                  {currentNodeLabel || t('canvas.story.playMode.noSelection')}
                </p>
                <p className="truncate text-xs text-[#8f9099]">
                  {t('canvas.story.playMode.liveHint')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={toggleAutoPlay}
                  aria-pressed={autoPlayEnabled}
                  className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors ${autoPlayEnabled
                    ? 'border-[oklch(0.72_0.145_205/0.25)] bg-[oklch(0.72_0.145_205/0.1)] text-[oklch(0.72_0.145_205)]'
                    : 'border-white/[0.08] text-[#8f9099] hover:bg-[#1a1c23] hover:text-[#e2e2e3]'}`}
                  title={t('canvas.story.playMode.autoPlay')}
                >
                  {autoPlayEnabled ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                  {t('canvas.story.playMode.autoPlayShort')}
                </button>
                <button
                  type="button"
                  onClick={cyclePlaybackRate}
                  className="flex h-8 min-w-14 items-center justify-center gap-1.5 rounded-md border border-white/[0.08] px-2 text-xs tabular-nums text-[#e2e2e3] transition-colors hover:bg-[#1a1c23]"
                  aria-label={t('canvas.story.playMode.playbackRate', { value: playbackRate })}
                  title={t('canvas.story.playMode.playbackRate', { value: playbackRate })}
                >
                  <Gauge className="size-3.5 text-[#8f9099]" />
                  {playbackRate}×
                </button>
                <button
                  type="button"
                  onClick={handleEditCurrentNode}
                  disabled={!currentNodeId}
                  title={t('canvas.story.playMode.generateFromHereHint')}
                  className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-[oklch(0.72_0.145_205)] px-4 text-sm font-semibold text-[#090909] shadow-[0_8px_24px_oklch(0.72_0.145_205/0.2)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Sparkles className="size-4" />
                  {t('canvas.story.playMode.generateFromHere')}
                </button>
              </div>
            </div>
          )}
          <StoryPlayer
            key={playbackRevision}
            t={t}
            shouldAutoPlay={playKind === 'entertainment' || autoPlayEnabled}
            playbackRate={playbackRate}
            resolveUrl={resolveMediaUrl}
            onRestart={handleRestart}
          >
      {/* 路径回顾图入口:有故事组上下文(画布试玩)时可用;叠加统计画「走了多少、还有什么没看」。 */}
      {phase !== 'error' && groupId && playKind === 'entertainment' && (
        <button
          onClick={() => {
            setMapOpen((v) => !v);
            setStatsOpen(false);
          }}
          aria-pressed={mapOpen}
          className={`absolute right-[6.75rem] top-5 z-40 rounded-full border border-white/15 bg-black/50 p-2 backdrop-blur transition-colors hover:text-white ${
            mapOpen ? 'text-white' : 'text-white/80'
          }`}
          aria-label={t('canvas.story.map.open')}
          title={t('canvas.story.map.open')}
        >
          <Map className="h-5 w-5" />
        </button>
      )}

      {/* 试玩统计入口:仅在本次试玩持久化(有 statsKey)时可用;创作者据此看选择分布/结局达成率。 */}
      {phase !== 'error' && statsKey && playKind === 'entertainment' && (
        <button
          onClick={() => {
            setStatsOpen((v) => !v);
            setMapOpen(false);
          }}
          aria-pressed={statsOpen}
          className={`absolute right-16 top-5 z-40 rounded-full border border-white/15 bg-black/50 p-2 backdrop-blur transition-colors hover:text-white ${
            statsOpen ? 'text-white' : 'text-white/80'
          }`}
          aria-label={t('canvas.story.stats.open')}
          title={t('canvas.story.stats.open')}
        >
          <BarChart3 className="h-5 w-5" />
        </button>
      )}

      {statsOpen && statsKey && (
        <StoryStatsPanel statsKey={statsKey} onClose={() => setStatsOpen(false)} />
      )}

      {mapOpen && groupId && (
        <StoryPathMap groupId={groupId} statsKey={statsKey} onClose={() => setMapOpen(false)} />
      )}

          </StoryPlayer>
        </main>
      </div>
    </div>,
    document.body,
  );
});
