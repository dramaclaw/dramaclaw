// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「找虾导打磨」——把当前产物连同该步骤该受的约束投进助手输入框并打开面板。
 *
 * 不自动发送：注入的约束可能很长，用户有权在发之前看一眼、再补一句。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, PenLine, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { writeStoryStep } from '@/api/story';
import { useAppStore } from '@/stores/app-store';
import { useAssistantDraftStore } from '@/stores/assistant-draft-store';
import { useStoryDoc } from '@/lib/queries/story';
import { buildStoryPrompt } from './askAssistant';
import { normalizeStoryBible, type StoryBible } from './storySteps';

/**
 * 两个按钮，两种用途：
 *   「AI 生成」直接调模型出稿——不需要工具、不需要多轮，一次生成最快也最省。
 *   「找虾导打磨」把内容连约束投进助手对话——需要来回商量时走这条。
 */
export function AskAssistantButton({
  project,
  stepId,
  content,
  episodeNumber,
  episodeStage,
  onWritten,
}: {
  project: string;
  stepId: string;
  content: string;
  episodeNumber?: number;
  episodeStage?: string;
  /** 模型出稿后回填；不传则只显示「找虾导打磨」。 */
  onWritten?: (text: string, title: string | null) => void;
}) {
  const { t } = useTranslation();
  const bibleDoc = useStoryDoc<StoryBible>(project, 'bible');
  const requestDraft = useAssistantDraftStore((s) => s.requestDraft);
  const setAssistantOpen = useAppStore((s) => s.setAiAssistantOpen);
  const [writing, setWriting] = useState(false);

  const prompt = () =>
    buildStoryPrompt({
      stepId,
      bible: normalizeStoryBible(bibleDoc.data?.content),
      content,
      episodeNumber,
      episodeStage,
    });

  return (
    <>
      {onWritten && (
        <Button
          size="sm"
          disabled={writing}
          onClick={async () => {
            setWriting(true);
            try {
              const result = await writeStoryStep(project, {
                step_id: stepId,
                prompt: prompt(),
                episode_number: episodeNumber,
              });
              onWritten(result.text, result.title);
              toast.success(t('story.written'));
            } catch (error) {
              toast.error(error instanceof Error ? error.message : t('story.writeFailed'));
            } finally {
              setWriting(false);
            }
          }}
        >
          {writing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PenLine className="h-3.5 w-3.5" />}
          {t('story.write')}
        </Button>
      )}
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        requestDraft(prompt());
        setAssistantOpen(true);
      }}
    >
      <Sparkles className="h-3.5 w-3.5" />
      {t('story.askAssistant')}
    </Button>
    </>
  );
}
