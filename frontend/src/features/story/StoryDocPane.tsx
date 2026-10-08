// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 通用文档面板：创作方案 / 角色体系 / 分集目录 都用它。
 *
 * 刻意不做富文本：这几份产物的下游消费者是**模型**，不是排版。纯文本可以原样喂进
 * 提示词，富文本还要先反解一次。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useSaveStoryDoc, useStoryDoc } from '@/lib/queries/story';
import { backendErrorToastMessage } from '@/lib/api-errors';
import { AskAssistantButton } from './AskAssistantButton';

const TEXTAREA_CLASS =
  'w-full flex-1 resize-none rounded-[8px] border border-white/10 bg-white/[0.025] p-3 font-mono text-[13px] leading-relaxed shadow-none placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/8';

export function StoryDocPane({
  project,
  docId,
  stepId,
  placeholderKey,
}: {
  project: string;
  docId: string;
  stepId: string;
  placeholderKey: string;
}) {
  const { t } = useTranslation();
  const doc = useStoryDoc<string>(project, docId);
  const save = useSaveStoryDoc<string>(project, docId);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);

  // 只在「切换到另一份文档」或「本地没有未保存改动」时才跟随服务端，
  // 否则后台重取会把用户正在敲的内容冲掉。
  useEffect(() => {
    if (dirty) return;
    setDraft(typeof doc.data?.content === 'string' ? doc.data.content : '');
  }, [doc.data?.content, doc.data?.doc_id, dirty]);

  useEffect(() => {
    setDirty(false);
  }, [docId]);

  const onSave = () => {
    save.mutate(
      { content: draft, baseRevision: doc.data?.revision },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success(t('story.saved'));
        },
        onError: (error) => toast.error(backendErrorToastMessage(error, t)),
      },
    );
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <textarea
        className={TEXTAREA_CLASS}
        value={draft}
        placeholder={t(placeholderKey)}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          setDirty(true);
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <AskAssistantButton
          project={project}
          stepId={stepId}
          content={draft}
          onWritten={(text) => {
            setDraft(text);
            setDirty(true);
          }}
        />
        <div className="flex-1" />
        {dirty && <span className="text-xs text-amber-300/80">{t('story.unsaved')}</span>}
        <Button size="sm" onClick={onSave} disabled={save.isPending || !dirty}>
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {t('story.save')}
        </Button>
      </div>
    </div>
  );
}
