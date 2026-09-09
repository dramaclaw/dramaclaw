import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Wand2, X } from 'lucide-react';
import { toast } from 'sonner';

import { useCanvasStore } from '@/stores/canvasStore';
import { collectMissingStoryClips } from '@/features/canvas/story/batchClipPlan';
import { batchGenerateStoryClips } from '@/features/canvas/application/batchGenerateStoryClips';
/** Generate missing clips using each node’s configured settings and references. */
export const StoryBatchGenPanel = memo(function StoryBatchGenPanel({
  groupId,
  onClose,
}: {
  groupId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);

  const { generable, skipped } = useMemo(
    () => collectMissingStoryClips(nodes, groupId),
    [nodes, groupId],
  );
  const count = generable.length;

  const handleGenerate = () => {
    if (count === 0) return;
    onClose();
    toast.info(t('canvas.story.gen.starting', { count }));
    batchGenerateStoryClips(groupId)
      .then((s) => {
        if (s.noProject) {
          toast.error(t('canvas.story.gen.noProject'));
          return;
        }
        if (s.failed > 0) {
          toast.warning(t('canvas.story.gen.donePartial', { succeeded: s.succeeded, failed: s.failed }));
        } else {
          toast.success(t('canvas.story.gen.done', { succeeded: s.succeeded }));
        }
      })
      .catch(() => toast.error(t('canvas.story.gen.failed')));
  };

  return (
    <div className="absolute right-4 top-16 z-30 w-72 rounded-xl border border-white/15 bg-[#17191d]/97 p-3 text-white/90 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{t('canvas.story.gen.title')}</span>
        <button onClick={onClose} aria-label={t('common.close')} className="text-white/60 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="mb-1 text-sm text-white/80">{t('canvas.story.gen.missingCount', { count })}</p>
      {skipped.length > 0 && (
        <p className="mb-2 text-xs text-amber-300/80">
          {t('canvas.story.gen.skippedHint', { count: skipped.length })}
        </p>
      )}

      <p className="mt-2 text-xs text-white/60">{t('canvas.story.gen.nodeSettingsHint')}</p>

      <button
        onClick={handleGenerate}
        disabled={count === 0}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-white/90 px-3 py-2 text-sm font-medium text-[#15171c] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Wand2 className="h-4 w-4" />
        {count === 0 ? t('canvas.story.gen.none') : t('canvas.story.gen.generate', { count })}
      </button>
    </div>
  );
});
