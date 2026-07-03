import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BarChart3, X } from 'lucide-react';
import { toast } from 'sonner';

import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import { resolveMediaUrl } from '@/lib/media-url';
import { useChoiceCountdown } from './useChoiceCountdown';
import { StoryStatsPanel } from './StoryStatsPanel';

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
  const phase = useStoryRuntimeStore((s) => s.phase);
  const currentClipUrl = useStoryRuntimeStore((s) => s.currentClipUrl);
  const currentChoices = useStoryRuntimeStore((s) => s.currentChoices);
  const currentVariables = useStoryRuntimeStore((s) => s.currentVariables);
  const currentChoiceTimeSec = useStoryRuntimeStore((s) => s.currentChoiceTimeSec);
  const currentDefaultChoiceIndex = useStoryRuntimeStore((s) => s.currentDefaultChoiceIndex);
  const currentEnding = useStoryRuntimeStore((s) => s.currentEnding);
  const currentPlaceholder = useStoryRuntimeStore((s) => s.currentPlaceholder);
  const nextClipUrls = useStoryRuntimeStore((s) => s.nextClipUrls);
  const statsKey = useStoryRuntimeStore((s) => s.statsKey);
  const error = useStoryRuntimeStore((s) => s.error);
  const resumeAvailable = useStoryRuntimeStore((s) => s.resumeAvailable);
  const choose = useStoryRuntimeStore((s) => s.choose);
  const restart = useStoryRuntimeStore((s) => s.restart);
  const resumeSaved = useStoryRuntimeStore((s) => s.resumeSaved);
  const startFresh = useStoryRuntimeStore((s) => s.startFresh);
  const exitPlay = useStoryRuntimeStore((s) => s.exitPlay);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoEnded, setVideoEnded] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  // 黑场过渡:切片段时淡出到黑,新片段可播或到结局时淡入。
  const [coverOpacity, setCoverOpacity] = useState(0);

  const resolvedUrl = currentClipUrl ? resolveMediaUrl(currentClipUrl) : null;
  const showChoices = videoEnded || phase === 'ended' || !resolvedUrl;

  // 每次切片段重置「播完」状态,重新隐藏选项。
  useEffect(() => {
    setVideoEnded(false);
  }, [currentClipUrl]);

  // 黑场过渡:有片段 → 先盖黑(遮缓冲),新视频 onCanPlay 或超时兜底再淡入;无片段(结局)直接清。
  useEffect(() => {
    if (!resolvedUrl) {
      setCoverOpacity(0);
      return;
    }
    setCoverOpacity(1);
    const id = window.setTimeout(() => setCoverOpacity(0), 600);
    return () => window.clearTimeout(id);
  }, [resolvedUrl]);

  // 针对性下一跳预取:选择点出现时只预取「玩家马上要二选一的后继分支」,而非全量预加载。
  // 全量预取在大故事里会让几十上百个 <video preload> 抢占并发/带宽,反拖慢当前片段;
  // 聚焦到 nextClipUrls 既消除分支切换断裂感,又能随故事规模伸缩。去重 + resolve,排除当前片段。
  const preloadUrls = useMemo(
    () =>
      Array.from(new Set(nextClipUrls))
        .map((u) => resolveMediaUrl(u))
        .filter((u): u is string => !!u && u !== resolvedUrl),
    [nextClipUrls, resolvedUrl],
  );

  // 限时选项:选项可见且本片段有时限时启动倒计时,归零自动选默认项(无默认回退第一条)。
  const countdownActive =
    mode === 'play' &&
    showChoices &&
    phase !== 'error' &&
    currentChoiceTimeSec != null &&
    currentChoices.length > 0;
  const handleTimeout = useCallback(() => {
    const idx = currentDefaultChoiceIndex ?? currentChoices[0]?.index ?? 0;
    choose(idx);
  }, [choose, currentDefaultChoiceIndex, currentChoices]);
  const { fraction } = useChoiceCountdown({
    seconds: currentChoiceTimeSec,
    active: countdownActive,
    onTimeout: handleTimeout,
  });

  // 续玩:存档失效时 resumeSaved 返回 false(已自动从头开始),提示玩家。
  const handleResume = useCallback(() => {
    if (!resumeSaved()) toast(t('canvas.story.resume.invalid'));
  }, [resumeSaved, t]);

  if (mode !== 'play') return null;

  return createPortal(
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black">
      <button
        onClick={exitPlay}
        className="absolute right-5 top-5 z-40 rounded-full border border-white/15 bg-black/50 p-2 text-white/80 backdrop-blur transition-colors hover:text-white"
        aria-label={t('common.close')}
      >
        <X className="h-5 w-5" />
      </button>

      {/* 试玩统计入口:仅在本次试玩持久化(有 statsKey)时可用;创作者据此看选择分布/结局达成率。 */}
      {phase !== 'error' && statsKey && (
        <button
          onClick={() => setStatsOpen((v) => !v)}
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

      {/* 变量 HUD:试玩时实时显示每个故事变量的当前值,方便验证效果是否生效。 */}
      {phase !== 'error' && currentVariables.length > 0 && (
        <div className="absolute left-5 top-5 z-10 flex flex-col gap-1 rounded-lg border border-white/15 bg-black/50 px-3 py-2 text-sm text-white/90 backdrop-blur">
          {currentVariables.map((v) => (
            <div key={v.name} className="flex items-center justify-between gap-3">
              <span className="text-white/70">{v.label}</span>
              <span className="font-medium tabular-nums">{v.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* 续玩提示:检测到存档,等玩家决定继续还是从头(在视频/选项之前)。 */}
      {resumeAvailable && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 bg-black/60 px-6 text-center backdrop-blur-sm">
          <h2 className="max-w-xl text-2xl font-semibold text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.8)]">
            {t('canvas.story.resume.title')}
          </h2>
          <div className="flex items-center gap-3">
            <button
              onClick={handleResume}
              className="rounded-full border border-white/30 bg-white/10 px-8 py-2.5 text-base font-medium text-white/95 backdrop-blur-sm transition-colors hover:bg-white/20"
            >
              {t('canvas.story.resume.continue')}
            </button>
            <button
              onClick={startFresh}
              className="rounded-full border border-white/25 bg-transparent px-8 py-2.5 text-base font-medium text-white/80 transition-colors hover:bg-white/10"
            >
              {t('canvas.story.resume.fresh')}
            </button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="max-w-md px-6 text-center text-white/90">
          <p className="mb-4">{error ?? t('canvas.story.error')}</p>
          <button onClick={exitPlay} className="rounded bg-white/10 px-4 py-2 hover:bg-white/20">
            {t('common.close')}
          </button>
        </div>
      )}

      {phase !== 'error' && resolvedUrl && (
        <video
          ref={videoRef}
          key={resolvedUrl}
          src={resolvedUrl}
          autoPlay
          playsInline
          controls={false}
          className="absolute inset-0 h-full w-full object-cover"
          onCanPlay={() => setCoverOpacity(0)}
          onEnded={() => setVideoEnded(true)}
        />
      )}

      {/* 黑场过渡覆盖层(遮换片/缓冲);pointer-events-none 不挡选项。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[5] bg-black transition-opacity duration-300 ease-out motion-reduce:transition-none"
        style={{ opacity: coverOpacity }}
      />

      {/* 下一跳分支预取(隐藏、不播,仅缓冲):当前选项的后继片段先就绪,点选即切、无断裂。 */}
      <div aria-hidden className="hidden">
        {preloadUrls.map((u) => (
          <video key={u} src={u} preload="auto" muted />
        ))}
      </div>

      {/* 占位卡:片段未生成视频时,用旁白/显示名占位,先跑通并读懂故事结构再花钱生成视频。 */}
      {phase !== 'error' && !resumeAvailable && !resolvedUrl && currentChoices.length > 0 && currentPlaceholder && (
        <div className="pointer-events-none absolute inset-x-0 top-0 bottom-44 z-[8] flex flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="rounded-full border border-white/25 px-3 py-1 text-xs font-medium tracking-wide text-white/70">
            {t('canvas.story.placeholderBadge')}
          </span>
          {currentPlaceholder.label && (
            <span className="text-sm font-medium tracking-wide text-white/60">{currentPlaceholder.label}</span>
          )}
          <p className="max-w-2xl text-2xl font-medium leading-relaxed text-white/90 [text-shadow:0_2px_16px_rgba(0,0,0,0.8)]">
            {currentPlaceholder.text.trim() || t('canvas.story.placeholderHint')}
          </p>
        </div>
      )}

      {phase !== 'error' && showChoices && currentChoices.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2 bg-gradient-to-t from-black/85 via-black/35 to-transparent px-6 pb-16 pt-28">
          {countdownActive && (
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
          {currentChoices.map((choice) => {
            const isDefault = choice.index === currentDefaultChoiceIndex;
            return (
              <button
                key={choice.index}
                onClick={() => choose(choice.index)}
                className="w-full max-w-xl rounded-lg border border-transparent bg-transparent px-6 py-2.5 text-center text-lg font-medium text-white/95 [text-shadow:0_1px_12px_rgba(0,0,0,0.9)] transition-all duration-200 hover:border-white/25 hover:bg-white/10 hover:backdrop-blur-sm hover:[text-shadow:none]"
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
      )}

      {/* 结局页:叶子结局,变量回顾 + 标题 + 重玩。续玩提示期间(idle)不显示。 */}
      {phase !== 'error' && !resumeAvailable && showChoices && currentChoices.length === 0 && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-black/55 px-6 text-center backdrop-blur-sm">
          {currentEnding?.label && (
            <span className="rounded-full border border-white/25 px-3 py-1 text-sm font-medium tracking-wide text-white/80">
              {t('canvas.story.endingBadge', { label: currentEnding.label })}
            </span>
          )}
          <h2 className="max-w-2xl text-3xl font-semibold text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.8)]">
            {currentEnding?.title?.trim() || t('canvas.story.endingFallback')}
          </h2>
          {currentVariables.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-sm text-white/75">
              {currentVariables.map((v) => (
                <span key={v.name} className="tabular-nums">
                  {v.label}: <span className="font-medium text-white/90">{v.value}</span>
                </span>
              ))}
            </div>
          )}
          <button
            onClick={restart}
            className="mt-2 rounded-full border border-white/30 bg-white/5 px-8 py-2.5 text-base font-medium text-white/95 backdrop-blur-sm transition-colors hover:bg-white/15"
          >
            {t('canvas.story.restart')}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
});
