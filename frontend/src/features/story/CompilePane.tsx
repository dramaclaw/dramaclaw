// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 编译与交接面板。
 *
 * 这一步把分集草稿拼成一份符合导入契约的全文，并在**导入之前**给出格式判定。
 * 之所以要在这里拦一道：ingest 的拒绝信息是为「上传别人写好的剧本」设计的，
 * 对创作流程来说来得太晚——几十集写完才被打回，代价是整轮返工。
 *
 * 目前只做到「编译 + 校验 + 复制全文」。真正的一键导入要等后端把
 * compile→novel.txt 这条打通（见 short-drama-integration-design.md 第 7 节），
 * 在那之前用户可以把全文复制到虾料页导入，流程是通的。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { Copy, FileCheck2, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useStoryDoc } from '@/lib/queries/story';
import { assessScreenplay, compileScreenplay } from './screenplayFormat';
import { importCompiledScreenplay } from './importCompiled';
import { normalizeEpisodeDrafts, type EpisodeDraftDoc } from './storySteps';

export function CompilePane({ project }: { project: string }) {
  const { t } = useTranslation();
  const episodesDoc = useStoryDoc<EpisodeDraftDoc>(project, 'episodes');
  const planDoc = useStoryDoc<string>(project, 'plan');
  const charactersDoc = useStoryDoc<string>(project, 'characters');
  const [preview, setPreview] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const navigate = useNavigate();

  const drafts = useMemo(
    () => normalizeEpisodeDrafts(episodesDoc.data?.content),
    [episodesDoc.data?.content],
  );

  // 梗概段落 = 创作方案 + 角色体系。后端 extract_synopsis() 读的正是第一集之前的所有内容，
  // 把这两份放进去，创作阶段的成果就能无损带进制作阶段。
  const synopsis = useMemo(() => {
    const parts = [planDoc.data?.content, charactersDoc.data?.content]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return parts.join('\n\n');
  }, [planDoc.data?.content, charactersDoc.data?.content]);

  const compiled = useMemo(() => compileScreenplay(synopsis, drafts), [synopsis, drafts]);
  const assessment = useMemo(() => assessScreenplay(compiled), [compiled]);

  const tone =
    assessment.status === 'standard'
      ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-200'
      : assessment.status === 'repairable'
        ? 'border-amber-300/30 bg-amber-300/[0.07] text-amber-100'
        : 'border-red-400/30 bg-red-400/[0.07] text-red-200';

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div className={cn('rounded-[10px] border px-3 py-2.5 text-sm', tone)}>
        <div className="font-medium">{t(`story.compile.status.${assessment.status}`)}</div>
        <div className="mt-1 text-xs opacity-85">
          {t('story.compile.summary', {
            episodes: assessment.episodeCount,
            standard: assessment.standardScenes,
            total: assessment.sceneCount,
          })}
        </div>
      </div>

      {assessment.issues.length > 0 && (
        <div className="space-y-1 rounded-[10px] border border-white/[0.08] bg-white/[0.015] p-2.5 text-[11px] text-muted-foreground">
          {assessment.issues.slice(0, 20).map((issue, index) => (
            <div key={index}>
              {t('story.compile.issueLine', {
                line: issue.line,
                reason: t(`story.compile.issue.${issue.reason}`),
              })}
              <span className="ml-1 opacity-60">{issue.text}</span>
            </div>
          ))}
          {assessment.issues.length > 20 && (
            <div className="opacity-60">{t('story.compile.moreIssues', { count: assessment.issues.length - 20 })}</div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={importing || assessment.status === 'missing' || !compiled.trim()}
          onClick={async () => {
            setImporting(true);
            try {
              await importCompiledScreenplay(project, compiled);
              toast.success(t('story.compile.imported'));
              void navigate({ to: '/projects/$project/ingest', params: { project } });
            } catch (error) {
              toast.error(error instanceof Error ? error.message : t('story.compile.importFailed'));
            } finally {
              setImporting(false);
            }
          }}
        >
          {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {t('story.compile.import')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setPreview(preview === null ? compiled : null)}>
          <FileCheck2 className="h-3.5 w-3.5" />
          {t(preview === null ? 'story.compile.preview' : 'story.compile.hidePreview')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!compiled.trim()}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(compiled);
              toast.success(t('story.compile.copied'));
            } catch {
              toast.error(t('story.compile.copyFailed'));
            }
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          {t('story.compile.copy')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t('story.compile.importHint')}</p>

      {preview !== null && (
        <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded-[8px] border border-white/10 bg-white/[0.025] p-3 font-mono text-[12px] leading-relaxed">
          {compiled || t('story.compile.emptyPreview')}
        </pre>
      )}
    </div>
  );
}
