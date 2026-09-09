import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Play } from 'lucide-react';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import { useChoicePointMachine } from '@/components/canvas/useChoicePointMachine';
import { normalizeStoryChoiceInteraction, type StoryChoiceInteraction, type StoryChoiceTransition, type StoryStateChange } from './storyTypes';
import { objectContainRenderRect, mediaAnchorToContainPoint, type MediaRenderRect } from './objectCoverCoordinates';
import './storyPlayer.css';

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

const identityUrl = (url: string) => url;

/** Shared player surface for editor playtests and the standalone HTML build. No canvas dependencies. */
export function StoryPlayer({ t, shouldAutoPlay = true, playbackRate = 1, revision = 0, resolveUrl = identityUrl, onRestart, fitToMedia = true, children }: {
  t: (key: string, values?: Record<string, unknown>) => string;
  /** Keep media and interactive overlays inside the same fitted viewport. */
  fitToMedia?: boolean;
  shouldAutoPlay?: boolean;
  playbackRate?: number;
  revision?: number;
  resolveUrl?: (url: string) => string | null;
  onRestart?: () => void;
  children?: ReactNode;
}) {
  const mode = useStoryRuntimeStore((s) => s.mode);
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
  const error = useStoryRuntimeStore((s) => s.error);
  const resumeAvailable = useStoryRuntimeStore((s) => s.resumeAvailable);
  const choose = useStoryRuntimeStore((s) => s.choose);
  const advanceAutomatic = useStoryRuntimeStore((s) => s.advanceAutomatic);
  const restart = useStoryRuntimeStore((s) => s.restart);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mediaAspectRatio, setMediaAspectRatio] = useState(16 / 9);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [previewRect, setPreviewRect] = useState<MediaRenderRect | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!fitToMedia || !viewport) return;
    const update = () => setPreviewRect(objectContainRenderRect(
      { width: viewport.clientWidth, height: viewport.clientHeight },
      { width: mediaAspectRatio, height: 1 },
    ));
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(viewport);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [fitToMedia, mediaAspectRatio]);
  const [endedPlaybackKey, setEndedPlaybackKey] = useState<string | null>(null);
  const [outcomeFeedback, setOutcomeFeedback] = useState<OutcomeFeedback | null>(null);
  const outcomeFeedbackTimerRef = useRef<number | null>(null);
  const outcomeFeedbackPendingRef = useRef(false);
  // 黑场过渡:切片段时淡出到黑,新片段可播或到结局时淡入。
  const [coverOpacity, setCoverOpacity] = useState(0);
  const [branchTransition, setBranchTransition] = useState<StoryChoiceTransition>('fade');
  const [mediaRenderRect, setMediaRenderRect] = useState<MediaRenderRect | null>(null);
  const [videoPaused, setVideoPaused] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [choiceLoopFailed, setChoiceLoopFailed] = useState(false);
  // A revisit to the same node/URL is still a new clip and choice window.
  const visit = useRef({ choices: currentChoices, revision: 0 });
  if (visit.current.choices !== currentChoices) {
    visit.current = { choices: currentChoices, revision: visit.current.revision + 1 };
  }
  const visitRevision = visit.current.revision;
  const [choiceLoopReady, setChoiceLoopReady] = useState(false);
  const [playbackRevision, setPlaybackRevision] = useState(0);
  const playbackKey = JSON.stringify([currentNodeId, currentClipUrl, playbackRevision, revision, visitRevision]);
  // Ended belongs to this visit, never to the next clip rendered before effects reset.
  const videoEnded = endedPlaybackKey === playbackKey;

  const resolvedUrl = currentClipUrl ? resolveUrl(currentClipUrl) : null;
  // 有视频的结局必须等片段真正播完；phase=ended 只表示 Ink 已到叶子，不代表媒体已结束。
  const showChoices = videoEnded || !resolvedUrl;
  const resolvedChoiceLoopUrl = currentNodeId
    ? resolveUrl(choiceLoopClipByNodeId[currentNodeId] ?? '')
    : null;
  const choiceLoopActive = showChoices
    && currentChoices.length > 0
    && !!resolvedChoiceLoopUrl
    && choiceLoopReady
    && !choiceLoopFailed;
  const activeVideoUrl = choiceLoopActive ? resolvedChoiceLoopUrl : resolvedUrl;
  // 不能只依赖 ended：部分浏览器/编码在最后一帧停住却不派发 ended，选择层会永久不出现。
  // 只对选择节点提前冻结可见尾帧；结局节点必须完整播放完再展示结局，避免文案提前出现。
  const revealChoicesAtTailFrame = useCallback((video: HTMLVideoElement) => {
    if (currentChoices.length === 0 || !Number.isFinite(video.duration) || video.duration <= 0.35) return;
    if (video.currentTime < Math.max(0, video.duration - 0.35)) return;
    video.pause();
    setEndedPlaybackKey(playbackKey);
  }, [currentChoices.length, playbackKey]);

  const measureVideoFrame = useCallback((video: HTMLVideoElement) => {
    const bounds = video.getBoundingClientRect();
    const positioningBounds = video.offsetParent instanceof HTMLElement
      ? video.offsetParent.getBoundingClientRect()
      : { left: 0, top: 0 };
    const toFramePoint = mediaAnchorToContainPoint;
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
  }, []);

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

  // 每次进入片段重置暂停、错误与循环加载状态；结束状态由 playbackKey 隔离。
  useEffect(() => {
    setVideoPaused(false);
    setMediaError(false);
    setChoiceLoopFailed(false);
    setChoiceLoopReady(false);
  }, [currentClipUrl, currentNodeId, playbackRevision, revision, visitRevision]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = playbackRate;
  }, [activeVideoUrl, playbackRate, playbackRevision, revision, visitRevision]);

  useEffect(() => {
    if (resumeAvailable || phase !== 'playing' || currentChoices.length > 0) return;
    if (!videoEnded && resolvedUrl) return;
    // A new visit must re-evaluate even when both clips have no URL. Yield between
    // placeholder hops, and cancel pending advancement when playback changes.
    const timer = window.setTimeout(advanceAutomatic, 0);
    return () => window.clearTimeout(timer);
  }, [advanceAutomatic, currentChoices.length, phase, resolvedUrl, resumeAvailable, videoEnded, playbackKey]);

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
  }, [activeVideoUrl, measureVideoFrame, playbackRevision, revision, visitRevision, mediaAspectRatio, fitToMedia, previewRect?.width, previewRect?.height]);

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
        .map((u) => resolveUrl(u))
        .filter((u): u is string => !!u && u !== activeVideoUrl),
    [activeVideoUrl, nextClipUrls, resolvedChoiceLoopUrl, resolveUrl],
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
    mode === 'play' && phase !== 'error' && !mediaError && showChoices && currentChoices.length > 0;
  const { stage, selectedIndex, fraction, select } = useChoicePointMachine({
    active: choicesActive,
    resetKey: `${currentNodeId ?? currentClipUrl}:${playbackRevision}:${revision}:${visitRevision}`,
    seconds: currentChoiceTimeSec,
    defaultIndex: currentDefaultChoiceIndex,
    firstIndex: currentChoices[0]?.index ?? 0,
    onCommit: handleChoiceCommit,
  });
  const choiceEntered = stage === 'select';
  const choiceExiting = stage === 'hide' || stage === 'timeout';
  const showCountdown = stage === 'select' && currentChoiceTimeSec != null;

  const requestPlayback = useCallback((video: HTMLVideoElement) => {
    // Catch autoplay policy rejections, including file:// on mobile browsers.
    void video.play()?.catch(() => {
      if (videoRef.current === video) setVideoPaused(true);
    });
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || (showChoices && !choiceLoopActive)) return;
    if (!shouldAutoPlay) {
      video.pause();
      setVideoPaused(true);
    } else if (video.readyState >= 2) requestPlayback(video);
  }, [activeVideoUrl, shouldAutoPlay, showChoices, choiceLoopActive, requestPlayback]);

  const handleRestart = useCallback(() => {
    setBranchTransition('fade');
    setPlaybackRevision((value) => value + 1);
    if (onRestart) onRestart();
    else restart();
  }, [onRestart, restart]);

  if (mode !== 'play') return null;
  return <div ref={viewportRef} className="story-player-viewport">
    <div data-story-player data-media-fit={fitToMedia || undefined}
      className="story-player relative min-h-0 min-w-0 overflow-hidden bg-black text-white"
      style={fitToMedia ? {
        aspectRatio: String(mediaAspectRatio),
        width: previewRect?.width,
        height: previewRect?.height,
      } : undefined}>

    {children}
      {phase === 'error' && (
        <div className="max-w-md px-6 text-center text-white/90">
          <p className="mb-4">{error ?? t('canvas.story.error')}</p>
          <button onClick={handleRestart} className="rounded bg-white/10 px-4 py-2 hover:bg-white/20">
            {t('canvas.story.restart')}
          </button>
        </div>
      )}

      {phase !== 'error' && activeVideoUrl && (
        <video
          ref={videoRef}
          key={`${currentNodeId}:${playbackRevision}:${revision}:${visitRevision}:${activeVideoUrl}`}
          src={activeVideoUrl}
          autoPlay={shouldAutoPlay}
          playsInline
          controls={false}
          loop={choiceLoopActive}
          className="absolute inset-0 h-full w-full object-contain"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            video.playbackRate = playbackRate;
            if (showChoices && !choiceLoopActive && Number.isFinite(video.duration)) {
              video.currentTime = Math.max(0, video.duration - 0.35);
              video.pause();
            }
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              if (!choiceLoopActive) setMediaAspectRatio(video.videoWidth / video.videoHeight);
              measureVideoFrame(video);
              window.requestAnimationFrame(() => measureVideoFrame(video));
            }
          }}
          onCanPlay={(event) => {
            measureVideoFrame(event.currentTarget);
            if (activeVideoUrl === resolvedChoiceLoopUrl) setChoiceLoopReady(true);
            setCoverOpacity(0);
            if (!shouldAutoPlay || (showChoices && !choiceLoopActive)) {
              event.currentTarget.pause();
              setVideoPaused(!showChoices);
            } else requestPlayback(event.currentTarget);
          }}
          onError={() => {
            setCoverOpacity(0);
            if (choiceLoopActive) {
              setChoiceLoopFailed(true);
              setChoiceLoopReady(false);
            } else setMediaError(true);
          }}
          onPlay={() => setVideoPaused(false)}
          onPause={() => setVideoPaused(true)}
          onEnded={(event) => {
            if (choiceLoopActive) return;
            if (currentChoices.length > 0 && Number.isFinite(event.currentTarget.duration)) {
              event.currentTarget.currentTime = Math.max(0, event.currentTarget.duration - 0.35);
              event.currentTarget.pause();
            }
            setEndedPlaybackKey(playbackKey);
          }}
          onTimeUpdate={(event) => {
            if (!choiceLoopActive) revealChoicesAtTailFrame(event.currentTarget);
          }}
          onSeeked={(event) => {
            if (!choiceLoopActive) revealChoicesAtTailFrame(event.currentTarget);
          }}
        />
      )}

      {phase !== 'error' && activeVideoUrl && !mediaError && videoPaused && (!showChoices || choiceLoopActive) && (
        <button
          type="button"
          onClick={() => { if (videoRef.current) requestPlayback(videoRef.current); }}
          className="absolute left-1/2 top-1/2 z-20 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white shadow-[0_10px_28px_rgba(0,0,0,0.45)] transition-colors hover:bg-black/75"
          aria-label={t('canvas.story.playMode.playCurrent')}
        >
          <Play className="ml-0.5 size-6" />
        </button>
      )}

      {mediaError && (
        <div role="alert" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black/80 p-6 text-center">
          <p>{t('canvas.story.mediaError')}</p>
          <button type="button" className="min-h-11 rounded-lg border border-white/30 px-5 py-3" onClick={() => {
            setMediaError(false);
            const video = videoRef.current;
            if (video) { video.load(); requestPlayback(video); }
          }}>{t('canvas.story.retryMedia')}</button>
        </div>
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
                className={`w-full min-h-12 max-w-xl rounded-lg border px-5 py-3 text-center text-base font-medium leading-snug text-white backdrop-blur-sm transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-default motion-reduce:transition-none ${
                  isSelected
                    ? 'border-white/70 bg-white/25'
                    : dimmed
                      ? 'border-white/15 bg-black/45 opacity-40'
                      : 'border-white/30 bg-black/45 hover:border-white/60 hover:bg-black/60 active:bg-white/20'
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
        <div data-story-ending
          className={`absolute inset-0 z-10 flex flex-col items-center gap-5 px-6 text-center ${currentClipUrl ? 'justify-end pb-10' : 'justify-center bg-black/55'}`}>
          {currentEnding?.label && (
            <span className="rounded-full border border-white/25 px-3 py-1 text-sm font-medium tracking-wide text-white/80">
              {t('canvas.story.endingBadge', { label: currentEnding.label })}
            </span>
          )}
          {(currentEnding?.title?.trim() || !currentClipUrl) && <h2 className="max-w-2xl text-3xl font-semibold text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.8)]">
            {currentEnding?.title?.trim() || t('canvas.story.endingFallback')}
          </h2>}
          <button
            onClick={handleRestart}
            className="mt-2 rounded-full border border-white/30 bg-white/5 px-8 py-2.5 text-base font-medium text-white/95 backdrop-blur-sm transition-colors hover:bg-white/15"
          >
            {t('canvas.story.restart')}
          </button>
        </div>
      )}
    </div>
  </div>;
}
