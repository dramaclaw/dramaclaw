import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, X } from 'lucide-react';

import { clearStoryStats, readStoryStats, type StoryStats } from '@/features/canvas/story/storyStats';

function pct(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

/**
 * 试玩统计面板(创作者侧):在播放器内浮出,展示「结局达成率」与「选择分布」。
 * 数据来自 localStorage(storyStats),开面板时读一次快照;清空后即时重读。
 */
export const StoryStatsPanel = memo(function StoryStatsPanel({
  statsKey,
  onClose,
}: {
  statsKey: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<StoryStats>(() => readStoryStats(statsKey));

  const endings = useMemo(
    () => Object.entries(stats.endings).sort((a, b) => b[1].count - a[1].count),
    [stats],
  );
  const points = useMemo(() => Object.entries(stats.points), [stats]);
  const empty = stats.totalRuns === 0 && points.length === 0;

  const handleClear = () => {
    clearStoryStats(statsKey);
    setStats(readStoryStats(statsKey));
  };

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-[22rem] max-w-[90vw] flex-col border-l border-white/10 bg-[#16181c]/98 text-sm text-white/90 shadow-[0_0_64px_rgba(0,0,0,0.6)] backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
        <span className="font-medium text-white/85">{t('canvas.story.stats.title')}</span>
        <button
          onClick={onClose}
          className="rounded-full p-1 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
          aria-label={t('common.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {empty ? (
          <p className="mt-8 text-center text-white/45">{t('canvas.story.stats.empty')}</p>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="text-white/70">
              {t('canvas.story.stats.totalRuns', { count: stats.totalRuns })}
            </div>

            {endings.length > 0 && (
              <section className="flex flex-col gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-white/45">
                  {t('canvas.story.stats.endings')}
                </span>
                {endings.map(([nodeId, ending]) => (
                  <div key={nodeId} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-white/85">
                        {ending.label ? `${ending.label} · ` : ''}
                        {ending.title || t('canvas.story.endingFallback')}
                      </span>
                      <span className="shrink-0 tabular-nums text-white/60">
                        {pct(ending.count, stats.totalRuns)}% · {ending.count}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-accent/70"
                        style={{ width: `${pct(ending.count, stats.totalRuns)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </section>
            )}

            {points.length > 0 && (
              <section className="flex flex-col gap-3">
                <span className="text-[11px] font-medium uppercase tracking-wide text-white/45">
                  {t('canvas.story.stats.choicePoints')}
                </span>
                {points.map(([nodeId, point]) => {
                  const opts = Object.values(point.options);
                  const sum = opts.reduce((s, o) => s + o.count, 0);
                  return (
                    <div key={nodeId} className="flex flex-col gap-1.5">
                      <span className="text-white/70">
                        {point.label || t('canvas.story.stats.choicePoint')}
                      </span>
                      {Object.entries(point.options)
                        .sort((a, b) => b[1].count - a[1].count)
                        .map(([idx, opt]) => (
                          <div key={idx} className="flex flex-col gap-1 pl-2">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="min-w-0 flex-1 truncate text-white/80">{opt.text}</span>
                              <span className="shrink-0 tabular-nums text-white/55">
                                {pct(opt.count, sum)}% · {opt.count}
                              </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                              <div
                                className="h-full rounded-full bg-white/50"
                                style={{ width: `${pct(opt.count, sum)}%` }}
                              />
                            </div>
                          </div>
                        ))}
                    </div>
                  );
                })}
              </section>
            )}
          </div>
        )}
      </div>

      {!empty && (
        <div className="border-t border-white/[0.07] px-4 py-3">
          <button
            onClick={handleClear}
            className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.1] hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('canvas.story.stats.clear')}
          </button>
        </div>
      )}
    </div>
  );
});
