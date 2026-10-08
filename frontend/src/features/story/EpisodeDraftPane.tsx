// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 分集草稿面板。左边集列表，右边正文。
 *
 * 正文按**交接契约格式**写（`X-Y地点 日/夜 内/外` + `人物：`），不是先写 markdown
 * 再转换——转换是额外的失真面，而这个格式本身也就多两行头。每集实时给出格式判定，
 * 而不是等几十集写完在导入那一步被打回。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useSaveStoryDoc, useStoryDoc } from '@/lib/queries/story';
import { backendErrorToastMessage } from '@/lib/api-errors';
import { assessScreenplay } from './screenplayFormat';
import { AskAssistantButton } from './AskAssistantButton';
import {
  normalizeEpisodeDrafts,
  normalizeStoryBible,
  type EpisodeDraft,
  type EpisodeDraftDoc,
  type StoryBible,
} from './storySteps';

const INPUT_CLASS =
  'h-9 rounded-[8px] border-white/10 bg-white/[0.025] px-3 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/8';

export function EpisodeDraftPane({ project }: { project: string }) {
  const { t } = useTranslation();
  const doc = useStoryDoc<EpisodeDraftDoc>(project, 'episodes');
  // 阶段清单来自结构锁——分集草稿只能从已定好的阶段里挑，挑不出结构锁里没有的阶段。
  const bibleDoc = useStoryDoc<StoryBible>(project, 'bible');
  const stages = useMemo(
    () => normalizeStoryBible(bibleDoc.data?.content).structureLock.map((entry) => entry.stage).filter(Boolean),
    [bibleDoc.data?.content],
  );
  const save = useSaveStoryDoc<EpisodeDraftDoc>(project, 'episodes');
  const [drafts, setDrafts] = useState<EpisodeDraft[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    const next = normalizeEpisodeDrafts(doc.data?.content);
    setDrafts(next);
    setSelected((current) => (current != null && next.some((d) => d.number === current) ? current : next[0]?.number ?? null));
  }, [doc.data?.content, dirty]);

  const current = drafts.find((draft) => draft.number === selected) ?? null;
  const assessment = useMemo(
    () => (current ? assessScreenplay(current.body) : null),
    [current],
  );

  const mutate = (next: EpisodeDraft[]) => {
    setDrafts(next);
    setDirty(true);
  };

  const onSave = () => {
    save.mutate(
      { content: { drafts }, baseRevision: doc.data?.revision },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success(t('story.saved'));
        },
        onError: (error) => toast.error(backendErrorToastMessage(error, t)),
      },
    );
  };

  const addEpisode = () => {
    const nextNumber = drafts.reduce((max, draft) => Math.max(max, draft.number), 0) + 1;
    mutate([...drafts, { number: nextNumber, title: '', body: '' }]);
    setSelected(nextNumber);
  };

  return (
    <div className="flex h-full gap-3">
      <aside className="flex w-44 shrink-0 flex-col gap-1.5 overflow-y-auto">
        {drafts.map((draft) => {
          const status = assessScreenplay(draft.body).status;
          return (
            <button
              key={draft.number}
              type="button"
              onClick={() => setSelected(draft.number)}
              className={cn(
                'flex items-center justify-between gap-2 rounded-[8px] border px-2.5 py-2 text-left text-xs transition',
                draft.number === selected
                  ? 'border-white/20 bg-white/[0.07] text-foreground'
                  : 'border-white/[0.08] bg-white/[0.015] text-muted-foreground hover:bg-white/[0.04]',
              )}
            >
              <span className="truncate">
                {t('story.episodes.item', { number: draft.number })}
                {draft.title ? ` · ${draft.title}` : ''}
              </span>
              <StatusDot status={status} />
            </button>
          );
        })}
        <Button variant="outline" size="sm" onClick={addEpisode} className="border-dashed">
          <Plus className="h-3.5 w-3.5" />
          {t('story.episodes.add')}
        </Button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {current ? (
          <>
            <div className="flex items-center gap-2">
              <Input
                className={INPUT_CLASS}
                placeholder={t('story.episodes.title')}
                value={current.title}
                onChange={(event) =>
                  mutate(drafts.map((d) => (d.number === current.number ? { ...d, title: event.target.value } : d)))
                }
              />
              <select
                className={`${INPUT_CLASS} w-44 shrink-0`}
                value={current.stage ?? ''}
                onChange={(event) =>
                  mutate(
                    drafts.map((d) =>
                      d.number === current.number
                        ? { ...d, stage: event.target.value || undefined }
                        : d,
                    ),
                  )
                }
              >
                <option value="">{t('story.episodes.noStage')}</option>
                {stages.map((stage) => (
                  <option key={stage} value={stage}>
                    {stage}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  mutate(drafts.filter((d) => d.number !== current.number));
                  setSelected(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <textarea
              className="w-full flex-1 resize-none rounded-[8px] border border-white/10 bg-white/[0.025] p-3 font-mono text-[13px] leading-relaxed shadow-none placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/8"
              spellCheck={false}
              placeholder={t('story.episodes.bodyPlaceholder')}
              value={current.body}
              onChange={(event) =>
                mutate(drafts.map((d) => (d.number === current.number ? { ...d, body: event.target.value } : d)))
              }
            />
            {assessment && <FormatBar assessment={assessment} />}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-[10px] border border-dashed border-white/[0.12] text-sm text-muted-foreground">
            {t('story.episodes.empty')}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {current && (
            <AskAssistantButton
              project={project}
              stepId="episodes"
              content={current.body}
              episodeNumber={current.number}
              episodeStage={current.stage}
              onWritten={(text, title) =>
                mutate(
                  drafts.map((d) =>
                    d.number === current.number
                      ? { ...d, body: text, title: d.title || (title ?? '') }
                      : d,
                  ),
                )
              }
            />
          )}
          <div className="flex-1" />
          {dirty && <span className="text-xs text-amber-300/80">{t('story.unsaved')}</span>}
          <Button size="sm" onClick={onSave} disabled={save.isPending || !dirty}>
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('story.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: 'standard' | 'repairable' | 'missing' }) {
  const color =
    status === 'standard' ? 'bg-emerald-400' : status === 'repairable' ? 'bg-amber-400' : 'bg-white/25';
  return <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', color)} />;
}

function FormatBar({ assessment }: { assessment: ReturnType<typeof assessScreenplay> }) {
  const { t } = useTranslation();
  const tone =
    assessment.status === 'standard'
      ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-200'
      : assessment.status === 'repairable'
        ? 'border-amber-300/30 bg-amber-300/[0.07] text-amber-100'
        : 'border-white/[0.12] bg-white/[0.03] text-muted-foreground';
  return (
    <div className={cn('rounded-[8px] border px-2.5 py-2 text-[11px] leading-relaxed', tone)}>
      <div>
        {t(`story.compile.status.${assessment.status}`)} ·{' '}
        {t('story.compile.sceneCount', {
          standard: assessment.standardScenes,
          total: assessment.sceneCount,
        })}
      </div>
      {assessment.issues.slice(0, 3).map((issue, index) => (
        <div key={index} className="mt-0.5 opacity-80">
          {t('story.compile.issueLine', {
            line: issue.line,
            reason: t(`story.compile.issue.${issue.reason}`),
          })}
        </div>
      ))}
    </div>
  );
}
