import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BarChart3, ChevronLeft, CirclePlay, Gauge, Map, Pause, PencilLine, Play, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { StoryCompileError } from '@/features/canvas/story/compileGraphToInk';
import { compileStoryGroup } from '@/features/canvas/story/compileStoryGroup';
import { storySaveKey } from '@/features/canvas/story/storySave';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import { resolveMediaUrl } from '@/lib/media-url';
import { useChoicePointMachine } from './useChoicePointMachine';
import { StoryStatsPanel } from './StoryStatsPanel';
import { StoryPathMap } from './StoryPathMap';
import { StoryPlaytestTree } from './StoryPlaytestTree';
import {
  normalizeStoryChoiceInteraction,
  type StoryChoiceInteraction,
  type StoryChoiceTransition,
  type StoryStateChange,
} from '@/features/canvas/story/storyTypes';
import {
  mediaAnchorToContainPoint,
  mediaAnchorToCoverPoint,
  type MediaRenderRect,
} from '@/features/canvas/story/objectCoverCoordinates';

/** 选择确认后给玩家阅读剧情反馈的停留时间；不会改变当前或后续视频资源。 */
export const STORY_OUTCOME_FEEDBACK_MS = 1500;

interface OutcomeFeedback {
  text?: string;
  stateChanges: StoryStateChange[];
}

const ANCHOR_STYLE_CLASS: Record<NonNullable<StoryChoiceInteraction['uiStyle']>, string> = {
  glass: 'border border-white/30 bg-black/35 text-white/95 shadow-[0_12px_30px_rgba(0,0,0,0.4)] backdrop-blur-md hover:border-white/55 hover:bg-black/50',
  // button 本身已经是 absolute；额外的 relative 会覆盖定位规则，把锚点从视频坐标系移出视口。
  tag: 'h-[52px] w-[52px] min-w-0 rounded-full border-0 bg-transparent p-0 text-transparent hover:bg-white/[0.04]',
  warning: 'border border-amber-200/45 bg-amber-950/65 text-amber-50 shadow-[0_10px_26px_rgba(120,53,15,0.42)] backdrop-blur-md hover:bg-amber-900/75',
};

const ANCHOR_MOTION_CLASS: Record<NonNullable<StoryChoiceInteraction['motion']>, string> = {
  fade: 'transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none',
  pop: 'transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none',
  pulse: 'transition-[opacity,transform] duration-300 ease-out motion-reduce:animate-none',
};

/**
 * 全屏 FMV 播放器。play 模式下接管整屏:播当前片段视频,onEnded 后淡入选项按钮,
 * 点击推进。无选项的叶子节点显示「重新开始」。运行态全部来自 storyRuntimeStore。
 *
 * 通过 createPortal 挂到 document.body:播放器原本嵌在 <ReactFlow> 内,fixed z-index
 * 被困在 ReactFlow 的层叠上下文里,导致画布底部工具栏(CanvasQuickActionBar 等)反而盖在
 * 视频之上。Portal 让它脱离该上下文,真正全屏接管整个视口。
 */
export const StoryPlayerOverlay = memo(function StoryPlayerOverlay() {
  const { t } = useTranslation();
  const mode = useStoryRuntimeStore((s) => s.mode);
  const playKind = useStoryRuntimeStore((s) => s.playKind);
  const phase = useStoryRuntimeStore((s) => s.phase);
  const currentNodeId = useStoryRuntimeStore((s) => s.currentNodeId);
  const currentClipUrl = useStoryRuntimeStore((s) => s.currentClipUrl);
  const choiceLoopClipByNodeId = useStoryRuntimeStore((s) => s.choiceLoopClipByNodeId);
  const currentChoices = useStoryRuntimeStore((s) => s.currentChoices);
  const currentChoiceTimeSec = useStoryRuntimeStore((s) => s.currentChoiceTimeSec);
  const currentDefaultChoiceIndex = useStoryRuntimeStore((s) => s.currentDefaultChoiceIndex);
  const currentEnding = useStoryRuntimeStore((s) => s.currentEnding);
  const currentPlaceholder = useStoryRuntimeStore((s) => s.currentPlaceholder);
  const nextClipUrls = useStoryRuntimeStore((s) => s.nextClipUrls);
  const statsKey = useStoryRuntimeStore((s) => s.statsKey);
  const groupId = useStoryRuntimeStore((s) => s.groupId);
  const error = useStoryRuntimeStore((s) => s.error);
  const resumeAvailable = useStoryRuntimeStore((s) => s.resumeAvailable);
  const choose = useStoryRuntimeStore((s) => s.choose);
  const advanceAutomatic = useStoryRuntimeStore((s) => s.advanceAutomatic);
  const restart = useStoryRuntimeStore((s) => s.restart);
  const resumeSaved = useStoryRuntimeStore((s) => s.resumeSaved);
  const exitPlay = useStoryRuntimeStore((s) => s.exitPlay);
  const enterPlay = useStoryRuntimeStore((s) => s.enterPlay);
  const currentNodeLabel = useCanvasStore((state) => {
    const node = currentNodeId ? state.nodes.find((candidate) => candidate.id === currentNodeId) : null;
    return node?.type ? resolveNodeDisplayName(node.type, node.data) : '';
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoEnded, setVideoEnded] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [outcomeFeedback, setOutcomeFeedback] = useState<OutcomeFeedback | null>(null);
  const outcomeFeedbackTimerRef = useRef<number | null>(null);
  const outcomeFeedbackPendingRef = useRef(false);
  // 黑场过渡:切片段时淡出到黑,新片段可播或到结局时淡入。
  const [coverOpacity, setCoverOpacity] = useState(0);
  const [branchTransition, setBranchTransition] = useState<StoryChoiceTransition>('fade');
  const [mediaRenderRect, setMediaRenderRect] = useState<MediaRenderRect | null>(null);
  const [mediaAspectRatio, setMediaAspectRatio] = useState(16 / 9);
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [videoPaused, setVideoPaused] = useState(false);
  const [choiceLoopReady, setChoiceLoopReady] = useState(false);
  const [playbackRevision, setPlaybackRevision] = useState(0);
  const shouldAutoPlay = playKind === 'entertainment' || autoPlayEnabled;
  const fillLiveFrame = playKind === 'live' && mediaAspectRatio >= 1;

  const resolvedUrl = currentClipUrl ? resolveMediaUrl(currentClipUrl) : null;
  // 有视频的结局必须等片段真正播完；phase=ended 只表示 Ink 已到叶子，不代表媒体已结束。
  const showChoices = videoEnded || !resolvedUrl;
  const resolvedChoiceLoopUrl = currentNodeId
    ? resolveMediaUrl(choiceLoopClipByNodeId[currentNodeId] ?? '')
    : null;
  const choiceLoopActive = showChoices
    && currentChoices.length > 0
    && !!resolvedChoiceLoopUrl
    && choiceLoopReady;
  const activeVideoUrl = choiceLoopActive ? resolvedChoiceLoopUrl : resolvedUrl;
  // 不能只依赖 ended：部分浏览器/编码在最后一帧停住却不派发 ended，选择层会永久不出现。
  // 只对选择节点提前冻结可见尾帧；结局节点必须完整播放完再展示结局，避免文案提前出现。
  const revealChoicesAtTailFrame = useCallback((video: HTMLVideoElement) => {
    if (currentChoices.length === 0 || !Number.isFinite(video.duration) || video.duration <= 0.35) return;
    if (video.currentTime < Math.max(0, video.duration - 0.35)) return;
    video.pause();
    setVideoEnded(true);
  }, [currentChoices.length]);

  const measureVideoFrame = useCallback((video: HTMLVideoElement) => {
    const bounds = video.getBoundingClientRect();
    const positioningBounds = video.offsetParent instanceof HTMLElement
      ? video.offsetParent.getBoundingClientRect()
      : { left: 0, top: 0 };
    const toFramePoint = fillLiveFrame ? mediaAnchorToCoverPoint : mediaAnchorToContainPoint;
    const point = toFramePoint(
      { x: 0, y: 0 },
      { width: bounds.width, height: bounds.height },
      { width: video.videoWidth, height: video.videoHeight },
    );
    const opposite = toFramePoint(
      { x: 1, y: 1 },
      { width: bounds.width, height: bounds.height },
      { width: video.videoWidth, height: video.videoHeight },
    );
    if (!point || !opposite) {
      setMediaRenderRect(null);
      return;
    }
    const next = {
      // 锚点按钮与 video 共用定位容器；播放器嵌入工作台后要换算为容器内坐标。
      left: bounds.left - positioningBounds.left + point.x,
      top: bounds.top - positioningBounds.top + point.y,
      width: opposite.x - point.x,
      height: opposite.y - point.y,
    };
    setMediaRenderRect((previous) => (
      previous
      && Math.abs(previous.left - next.left) < 0.5
      && Math.abs(previous.top - next.top) < 0.5
      && Math.abs(previous.width - next.width) < 0.5
      && Math.abs(previous.height - next.height) < 0.5
        ? previous
        : next
    ));
  }, [fillLiveFrame]);

  // 选择后的语义反馈独立于视频：先给玩家一小段阅读时间，再沿原有节点跳转。
  const handleChoiceCommit = useCallback((index: number) => {
    if (outcomeFeedbackPendingRef.current) return;
    const selectedChoice = currentChoices.find((choice) => choice.index === index);
    const feedback = selectedChoice?.feedbackText?.trim();
    const stateChanges = selectedChoice?.stateChanges ?? [];
    const transition = normalizeStoryChoiceInteraction(selectedChoice?.interaction).transition;
    const commitChoice = () => {
      setBranchTransition(transition);
      choose(index);
    };
    if (!feedback && stateChanges.length === 0) {
      commitChoice();
      return;
    }
    outcomeFeedbackPendingRef.current = true;
    setOutcomeFeedback({ text: feedback || undefined, stateChanges });
    outcomeFeedbackTimerRef.current = window.setTimeout(() => {
      outcomeFeedbackTimerRef.current = null;
      outcomeFeedbackPendingRef.current = false;
      setOutcomeFeedback(null);
      commitChoice();
    }, STORY_OUTCOME_FEEDBACK_MS);
  }, [choose, currentChoices]);

  // 退出试玩时取消未完成的反馈，避免离开后仍推进故事。
  useEffect(() => () => {
    if (outcomeFeedbackTimerRef.current !== null) window.clearTimeout(outcomeFeedbackTimerRef.current);
  }, []);
  useEffect(() => {
    if (mode === 'play') return;
    if (outcomeFeedbackTimerRef.current !== null) window.clearTimeout(outcomeFeedbackTimerRef.current);
    outcomeFeedbackTimerRef.current = null;
    outcomeFeedbackPendingRef.current = false;
    setOutcomeFeedback(null);
    setBranchTransition('fade');
  }, [mode]);

  // 每次切片段重置「播完」状态,重新隐藏选项。
  useEffect(() => {
    setVideoEnded(false);
    setVideoPaused(false);
    setChoiceLoopReady(false);
    setMediaAspectRatio(16 / 9);
  }, [currentClipUrl, currentNodeId, playbackRevision]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = playbackRate;
  }, [activeVideoUrl, playbackRate]);

  useEffect(() => {
    if (resumeAvailable || phase !== 'playing' || currentChoices.length > 0) return;
    if (videoEnded || !resolvedUrl) advanceAutomatic();
  }, [advanceAutomatic, currentChoices.length, phase, resolvedUrl, resumeAvailable, videoEnded]);

  // 锚点属于原始视频画幅；播放器按 contain 完整展示横/竖屏时，要把留白偏移计入坐标。
  useEffect(() => {
    setMediaRenderRect(null);
    const video = videoRef.current;
    if (!video) return;
    const update = () => measureVideoFrame(video);
    update();
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(video);
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [activeVideoUrl, measureVideoFrame]);

  // 黑场过渡:有片段 → 先盖黑(遮缓冲),新视频 onCanPlay 或超时兜底再淡入;无片段(结局)直接清。
  useEffect(() => {
    if (!resolvedUrl || branchTransition === 'cut') {
      setCoverOpacity(0);
      return;
    }
    setCoverOpacity(1);
    const id = window.setTimeout(() => setCoverOpacity(0), branchTransition === 'flash' ? 260 : 600);
    return () => window.clearTimeout(id);
  }, [branchTransition, resolvedUrl]);

  // 针对性下一跳预取:选择点出现时只预取「玩家马上要二选一的后继分支」,而非全量预加载。
  // 全量预取在大故事里会让几十上百个 <video preload> 抢占并发/带宽,反拖慢当前片段;
  // 聚焦到 nextClipUrls 既消除分支切换断裂感,又能随故事规模伸缩。去重 + resolve,排除当前片段。
  const preloadUrls = useMemo(
    () =>
      Array.from(new Set([
        ...nextClipUrls,
        ...(resolvedChoiceLoopUrl ? [resolvedChoiceLoopUrl] : []),
      ]))
        .map((u) => resolveMediaUrl(u))
        .filter((u): u is string => !!u && u !== activeVideoUrl),
    [activeVideoUrl, nextClipUrls, resolvedChoiceLoopUrl],
  );
  // 只有带完整锚点的非默认呈现才脱离底部选项区；不完整配置自动回退，保证玩家永远有可点击入口。
  const anchoredChoices = useMemo(
    () => currentChoices
      .map((choice) => ({ choice, interaction: normalizeStoryChoiceInteraction(choice.interaction) }))
      .filter(({ interaction }) => interaction.presentation !== 'overlay' && !!interaction.anchor),
    [currentChoices],
  );
  const anchoredChoiceIndexes = useMemo(
    () => new Set(anchoredChoices.map(({ choice }) => choice.index)),
    [anchoredChoices],
  );
  const bottomChoices = useMemo(
    () => currentChoices.filter((choice) => !anchoredChoiceIndexes.has(choice.index)),
    [anchoredChoiceIndexes, currentChoices],
  );

  // 选择点四阶段状态机:Init(进入动画)→ Select(可交互 + 限时倒计时)→ Timeout(超时选默认)/ Hide(点选确认),
  // 停留确认后再 choose 推进。resetKey 用节点 id,连续占位卡换跳时也能正确重置。
  const choicesActive =
    mode === 'play' && phase !== 'error' && showChoices && currentChoices.length > 0;
  const { stage, selectedIndex, fraction, select } = useChoicePointMachine({
    active: choicesActive,
    resetKey: `${currentNodeId ?? currentClipUrl}:${playbackRevision}`,
    seconds: currentChoiceTimeSec,
    defaultIndex: currentDefaultChoiceIndex,
    firstIndex: currentChoices[0]?.index ?? 0,
    onCommit: handleChoiceCommit,
  });
  const choiceEntered = stage === 'select';
  const choiceExiting = stage === 'hide' || stage === 'timeout';
  const showCountdown = stage === 'select' && currentChoiceTimeSec != null;

  // 娱乐模式直接恢复剧情存档；失效存档由 runtime 清理并回到起点。
  useEffect(() => {
    if (mode !== 'play' || playKind !== 'entertainment' || !resumeAvailable) return;
    setBranchTransition('fade');
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
      setBranchTransition('cut');
      if (outcomeFeedbackTimerRef.current !== null) window.clearTimeout(outcomeFeedbackTimerRef.current);
      outcomeFeedbackTimerRef.current = null;
      outcomeFeedbackPendingRef.current = false;
      setOutcomeFeedback(null);
      setPlaybackRevision((value) => value + 1);
      enterPlay(compiled, { saveKey, groupId, playKind: kind });
    } catch (err) {
      toast.error(err instanceof StoryCompileError ? err.message : t('canvas.story.error'));
    }
  }, [enterPlay, groupId, t]);

  const handleRestart = useCallback(() => {
    setBranchTransition('fade');
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

  const toggleAutoPlay = useCallback(() => {
    const video = videoRef.current;
    setAutoPlayEnabled((enabled) => {
      const next = !enabled;
      if (next) void video?.play().catch(() => setVideoPaused(true));
      else video?.pause();
      setVideoPaused(!next);
      return next;
    });
  }, []);

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
      <header className="grid h-14 shrink-0 grid-cols-[16rem_1fr_16rem] items-center border-b border-white/[0.08] bg-[#090909] px-4">
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

      <div className="flex min-h-0 flex-1">
        {playKind === 'live' && groupId && (
          <StoryPlaytestTree
            groupId={groupId}
            selectedNodeId={currentNodeId}
            onSelectNode={(nodeId) => startPlayback('live', nodeId)}
            onAddNode={handleAddNode}
          />
        )}
        <main className={`min-w-0 flex-1 overflow-hidden ${playKind === 'live' ? 'flex flex-col bg-[#090909] p-6' : 'relative bg-black'}`}>
          {playKind === 'live' && (
            <div className="z-50 mb-4 flex h-14 shrink-0 items-center justify-between gap-4 rounded-xl border border-white/[0.08] bg-[#111218]/80 px-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[#e2e2e3]">
                  {currentNodeLabel || t('canvas.story.playMode.noSelection')}
                </p>
                <p className="truncate text-xs text-[#8f9099]">
                  {t('canvas.story.playMode.liveHint')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
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
                  className="flex h-8 items-center gap-1.5 rounded-md border border-white/[0.08] px-2.5 text-xs text-[#e2e2e3] transition-colors hover:bg-[#1a1c23] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <PencilLine className="size-3.5" />
                  {t('canvas.story.playMode.editStructure')}
                </button>
                <button
                  type="button"
                  disabled
                  title={t('canvas.story.playMode.generateFromHereComingSoon')}
                  className="flex h-9 shrink-0 cursor-not-allowed items-center gap-2 rounded-lg bg-[oklch(0.72_0.145_205)] px-4 text-sm font-semibold text-[#090909] shadow-[0_8px_24px_oklch(0.72_0.145_205/0.2)]"
                >
                  <Sparkles className="size-4" />
                  {t('canvas.story.playMode.generateFromHere')}
                </button>
              </div>
            </div>
          )}
          <div
            className={playKind === 'live'
              ? `relative overflow-hidden rounded-xl bg-black ${fillLiveFrame ? 'min-h-0 w-full flex-1' : 'my-auto max-w-full self-center'}`
              : 'absolute inset-0 overflow-hidden'}
            style={playKind === 'live' && !fillLiveFrame
              ? {
                  aspectRatio: String(mediaAspectRatio),
                  width: `min(100%, calc((100dvh - 11rem) * ${mediaAspectRatio}))`,
                }
              : undefined}
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

      {phase === 'error' && (
        <div className="max-w-md px-6 text-center text-white/90">
          <p className="mb-4">{error ?? t('canvas.story.error')}</p>
          <button onClick={exitPlay} className="rounded bg-white/10 px-4 py-2 hover:bg-white/20">
            {t('common.close')}
          </button>
        </div>
      )}

      {phase !== 'error' && activeVideoUrl && (
        <video
          ref={videoRef}
          key={`${currentNodeId}:${playbackRevision}:${activeVideoUrl}`}
          src={activeVideoUrl}
          autoPlay={shouldAutoPlay}
          playsInline
          controls={false}
          loop={choiceLoopActive}
          className={`absolute inset-0 h-full w-full ${fillLiveFrame ? 'object-cover' : 'object-contain'}`}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            video.playbackRate = playbackRate;
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              setMediaAspectRatio(video.videoWidth / video.videoHeight);
              measureVideoFrame(video);
              window.requestAnimationFrame(() => measureVideoFrame(video));
            }
          }}
          onCanPlay={(event) => {
            measureVideoFrame(event.currentTarget);
            setCoverOpacity(0);
            if (!shouldAutoPlay) {
              event.currentTarget.pause();
              setVideoPaused(true);
            }
          }}
          onPlay={() => setVideoPaused(false)}
          onPause={() => setVideoPaused(true)}
          onEnded={(event) => {
            if (choiceLoopActive) return;
            if (currentChoices.length > 0 && Number.isFinite(event.currentTarget.duration)) {
              event.currentTarget.currentTime = Math.max(0, event.currentTarget.duration - 0.35);
              event.currentTarget.pause();
            }
            setVideoEnded(true);
          }}
          onTimeUpdate={(event) => {
            if (!choiceLoopActive) revealChoicesAtTailFrame(event.currentTarget);
          }}
          onSeeked={(event) => {
            if (!choiceLoopActive) revealChoicesAtTailFrame(event.currentTarget);
          }}
        />
      )}

      {phase !== 'error' && activeVideoUrl && !shouldAutoPlay && videoPaused && !showChoices && (
        <button
          type="button"
          onClick={() => void videoRef.current?.play().catch(() => setVideoPaused(true))}
          className="absolute left-1/2 top-1/2 z-20 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white shadow-[0_10px_28px_rgba(0,0,0,0.45)] transition-colors hover:bg-black/75"
          aria-label={t('canvas.story.playMode.playCurrent')}
        >
          <Play className="ml-0.5 size-6" />
        </button>
      )}

      {/* 黑场过渡覆盖层(遮换片/缓冲);pointer-events-none 不挡选项。 */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 z-[5] transition-opacity duration-300 ease-out motion-reduce:transition-none ${
          branchTransition === 'flash' ? 'bg-white' : 'bg-black'
        }`}
        style={{ opacity: coverOpacity }}
      />

      {outcomeFeedback && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute inset-x-6 top-20 z-30 text-center sm:top-24"
        >
          <div className="flex flex-col items-center gap-1.5">
            {outcomeFeedback.stateChanges.length > 0 && (
              <div className="flex max-w-xl flex-wrap justify-center gap-1.5">
                {outcomeFeedback.stateChanges.map((change) => {
                  const isUp = change.direction === 'up';
                  const isOn = change.direction === 'on';
                  const isOff = change.direction === 'off';
                  const positive = isUp || isOn;
                  const suffix = isOn ? t('canvas.story.flagOn') : isOff ? t('canvas.story.flagOff') : isUp ? '↑' : '↓';
                  return (
                    <span
                      key={`${change.label}-${change.direction}`}
                      aria-label={`${change.label}${suffix}`}
                      className={`rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide backdrop-blur-sm ${
                        positive
                          ? 'border-cyan-200/25 bg-cyan-200/10 text-cyan-100'
                          : 'border-amber-200/25 bg-amber-200/10 text-amber-100'
                      }`}
                    >
                      {change.label} {suffix}
                    </span>
                  );
                })}
              </div>
            )}
            {outcomeFeedback.text && (
              <p className="mx-auto max-w-xl text-base font-semibold leading-6 tracking-wide text-white/80 [text-shadow:0_2px_14px_rgba(0,0,0,0.95)] sm:text-lg">
                {outcomeFeedback.text}
              </p>
            )}
          </div>
        </div>
      )}

      {/* 下一跳分支预取(隐藏、不播,仅缓冲):当前选项的后继片段先就绪,点选即切、无断裂。 */}
      <div aria-hidden className="hidden">
        {preloadUrls.map((u) => (
          <video
            key={u}
            src={u}
            preload="auto"
            muted
            onCanPlay={() => {
              if (u === resolvedChoiceLoopUrl) setChoiceLoopReady(true);
            }}
            onError={() => {
              if (u === resolvedChoiceLoopUrl) setChoiceLoopReady(false);
            }}
          />
        ))}
      </div>

      {/* 占位卡:片段未生成视频时,用旁白/显示名占位,先跑通并读懂故事结构再花钱生成视频。 */}
      {phase !== 'error' && !resumeAvailable && !resolvedUrl && currentChoices.length > 0 && currentPlaceholder && (
        <>
          <span className="pointer-events-none absolute left-6 top-5 z-[8] text-xs font-medium text-white/40">
            {t('canvas.story.placeholderBadge')}
          </span>
          {!outcomeFeedback && (
            <div data-story-placeholder className="absolute inset-x-0 top-[18%] bottom-[32%] z-[8] flex overflow-y-auto overscroll-contain px-6 sm:px-8">
              <div className="m-auto w-full max-w-xl space-y-3 text-left">
                {currentPlaceholder.label && (
                  <p className="text-sm font-medium leading-5 text-white/60">{currentPlaceholder.label}</p>
                )}
                <p className="whitespace-pre-wrap break-words text-base font-normal leading-8 text-white/90 sm:text-lg">
                  {currentPlaceholder.text.trim() || t('canvas.story.placeholderHint')}
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {phase !== 'error' && showChoices && currentChoices.length > 0 && (
        <>
          {anchoredChoices.map(({ choice, interaction }) => {
            const anchor = interaction.anchor!;
            const renderedAnchor = mediaRenderRect
              ? {
                  left: mediaRenderRect.left + anchor.x * mediaRenderRect.width,
                  top: mediaRenderRect.top + anchor.y * mediaRenderRect.height,
                  width: (anchor.width ?? 0) * mediaRenderRect.width,
                  height: (anchor.height ?? 0) * mediaRenderRect.height,
                }
              : null;
            const isBaked = interaction.presentation === 'baked-video';
            const isTechTag = interaction.uiStyle === 'tag';
            const isSelected = selectedIndex === choice.index;
            const dimmed = selectedIndex != null && !isSelected;
            const enteredTransform = 'scale-100';
            const hiddenTransform = interaction.motion === 'pop' ? 'scale-75' : 'scale-95';
            return (
              <button
                key={choice.index}
                onClick={() => select(choice.index)}
                disabled={choiceExiting}
                aria-label={choice.text}
                aria-pressed={isSelected}
                title={interaction.anchor?.objectLabel || choice.text}
                className={`group/anchor absolute z-20 -translate-x-1/2 -translate-y-1/2 cursor-pointer text-center text-sm font-semibold leading-snug outline-none focus-visible:ring-2 focus-visible:ring-white/90 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-default motion-reduce:transition-none ${
                  isBaked
                    ? 'min-h-11 min-w-11 rounded-lg border border-transparent bg-transparent p-0 text-transparent hover:border-white/25 focus-visible:border-white/60 focus-visible:bg-black/40 focus-visible:text-white/95'
                    : `${isTechTag ? '' : 'min-w-32 rounded-xl px-4 py-2'} ${ANCHOR_STYLE_CLASS[interaction.uiStyle]}`
                } ${ANCHOR_MOTION_CLASS[interaction.motion]} ${
                  choiceEntered
                    ? `${enteredTransform} opacity-100${interaction.motion === 'pulse' && !isBaked ? ' animate-pulse' : ''}`
                    : choiceExiting || dimmed
                      ? 'scale-95 opacity-0'
                      : `${hiddenTransform} opacity-0`
                } ${isSelected && !isBaked ? 'scale-105 ring-1 ring-white/65' : ''}`}
                style={{
                  left: renderedAnchor ? `${renderedAnchor.left}px` : `${anchor.x * 100}%`,
                  top: renderedAnchor ? `${renderedAnchor.top}px` : `${anchor.y * 100}%`,
                  ...(isBaked
                    ? {
                        width: renderedAnchor ? `${renderedAnchor.width}px` : `${(anchor.width ?? 0) * 100}%`,
                        height: renderedAnchor ? `${renderedAnchor.height}px` : `${(anchor.height ?? 0) * 100}%`,
                      }
                    : {}),
                }}
              >
                {isTechTag && !isBaked && (
                  <>
                    <span
                      data-tech-hit-highlight="true"
                      aria-hidden
                      className="pointer-events-none absolute left-1.5 top-1.5 z-[1] h-10 w-10 rounded-full bg-cyan-50/0 transition-[background-color,box-shadow,transform] duration-150 ease-out group-hover/anchor:scale-105 group-hover/anchor:bg-cyan-50/20 group-hover/anchor:shadow-[0_0_18px_rgba(207,250,254,0.55)] group-focus-visible/anchor:scale-105 group-focus-visible/anchor:bg-cyan-50/20 motion-reduce:transition-none"
                    />
                    <span
                      data-tech-target="true"
                      aria-hidden
                      className="pointer-events-none absolute left-1.5 top-1.5 z-[2] block h-10 w-10 rounded-full border-2 border-white/90 shadow-[0_0_0_1px_rgba(165,243,252,0.18),0_0_10px_rgba(165,243,252,0.42)] transition-[border-color,box-shadow,transform] duration-150 ease-out group-hover/anchor:scale-105 group-hover/anchor:border-white group-hover/anchor:shadow-[0_0_0_1px_rgba(207,250,254,0.32),0_0_14px_rgba(207,250,254,0.72)] group-focus-visible/anchor:scale-105 motion-reduce:transition-none"
                    >
                      <span className="absolute left-1.5 top-1.5 h-6 w-6 rounded-full border border-cyan-100/70" />
                      <span className="absolute left-3.5 top-3.5 h-2 w-2 rounded-full border-2 border-white/95 shadow-[0_0_6px_rgba(165,243,252,0.72)]" />
                    </span>
                  </>
                )}
                {!isTechTag && !isBaked ? <span>{choice.text}</span> : null}
              </button>
            );
          })}
        <div
          data-choice-stage={stage}
          className={`absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2 px-6 transition-all duration-300 ease-out motion-reduce:transition-none ${
            bottomChoices.length > 0 ? 'bg-gradient-to-t from-black/85 via-black/35 to-transparent pb-16 pt-28' : 'pointer-events-none pb-8 pt-0'
          } ${
            choiceEntered
              ? 'translate-y-0 opacity-100'
              : choiceExiting
                ? 'translate-y-1 opacity-0'
                : 'translate-y-4 opacity-0'
          }`}
        >
          {showCountdown && (
            <div
              className="mb-2 h-1 w-full max-w-xl overflow-hidden rounded-full bg-white/15"
              role="timer"
              aria-label={t('canvas.story.choiceCountdown')}
            >
              <div
                className={`h-full rounded-full ease-linear ${
                  fraction < 0.25 ? 'bg-red-500' : 'bg-white/80'
                }`}
                style={{ width: `${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%` }}
              />
            </div>
          )}
          {bottomChoices.map((choice) => {
            const isDefault = choice.index === currentDefaultChoiceIndex;
            const isSelected = selectedIndex === choice.index;
            const dimmed = selectedIndex != null && !isSelected;
            return (
              <button
                key={choice.index}
                onClick={() => select(choice.index)}
                disabled={choiceExiting}
                aria-pressed={isSelected}
                className={`w-full max-w-xl rounded-lg border px-6 py-2.5 text-center text-lg font-medium text-white/95 [text-shadow:0_1px_12px_rgba(0,0,0,0.9)] transition-all duration-200 motion-reduce:transition-none ${
                  isSelected
                    ? 'scale-[1.03] border-white/60 bg-white/15 backdrop-blur-sm [text-shadow:none]'
                    : dimmed
                      ? 'border-transparent bg-transparent opacity-30'
                      : 'border-transparent bg-transparent hover:border-white/25 hover:bg-white/10 hover:backdrop-blur-sm hover:[text-shadow:none]'
                }`}
              >
                {choice.text}
                {isDefault && (
                  <span className="ml-2 align-middle rounded-full border border-white/30 px-1.5 py-0.5 text-[11px] font-normal text-white/70 [text-shadow:none]">
                    {t('canvas.story.defaultChoice')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        </>
      )}

      {/* 结局页:叶子结局标题 + 重玩。续玩提示期间(idle)不显示。 */}
      {phase === 'ended' && !resumeAvailable && showChoices && currentChoices.length === 0 && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-black/55 px-6 text-center backdrop-blur-sm">
          {currentEnding?.label && (
            <span className="rounded-full border border-white/25 px-3 py-1 text-sm font-medium tracking-wide text-white/80">
              {t('canvas.story.endingBadge', { label: currentEnding.label })}
            </span>
          )}
          <h2 className="max-w-2xl text-3xl font-semibold text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.8)]">
            {currentEnding?.title?.trim() || t('canvas.story.endingFallback')}
          </h2>
          <button
            onClick={handleRestart}
            className="mt-2 rounded-full border border-white/30 bg-white/5 px-8 py-2.5 text-base font-medium text-white/95 backdrop-blur-sm transition-colors hover:bg-white/15"
          >
            {t('canvas.story.restart')}
          </button>
        </div>
      )}
          </div>
        </main>
      </div>
    </div>,
    document.body,
  );
});
