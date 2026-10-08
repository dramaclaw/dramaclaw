// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 虾本 —— 创作阶段工作区。
 *
 * 它填的是主线流水线之前那一段空白：DramaClaw 的一切都从「已有一份小说或剧本」开始，
 * 而这里负责把「一个想法」变成那份剧本。产出经编译后进 novel.txt，之后完全走现有流程。
 *
 * 步骤来自 storySteps.ts 的注册表，这个组件对具体有哪些步骤是无知的——
 * 加一步只需要改注册表。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { STORY_STEPS, type StoryStep } from './storySteps';
import { StoryBiblePane } from './StoryBiblePane';
import { StoryDocPane } from './StoryDocPane';
import { EpisodeDraftPane } from './EpisodeDraftPane';
import { CompilePane } from './CompilePane';

export function StoryWorkspace({ project }: { project: string }) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string>(STORY_STEPS[0].id);
  const active = STORY_STEPS.find((step) => step.id === activeId) ?? STORY_STEPS[0];

  return (
    <div className="flex h-full min-h-0 gap-4 p-4">
      <nav className="flex w-52 shrink-0 flex-col gap-1">
        {STORY_STEPS.map((step, index) => (
          <StepButton
            key={step.id}
            step={step}
            index={index}
            active={step.id === active.id}
            onClick={() => setActiveId(step.id)}
          />
        ))}
      </nav>

      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <header>
          <h2 className="text-base font-medium text-foreground">{t(`${active.i18nKey}.title`)}</h2>
          <p className="text-xs text-muted-foreground">{t(`${active.i18nKey}.hint`)}</p>
        </header>
        <div className="min-h-0 flex-1">
          <StepPane project={project} step={active} />
        </div>
      </section>
    </div>
  );
}

function StepButton({
  step,
  index,
  active,
  onClick,
}: {
  step: StoryStep;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const Icon = step.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left text-sm transition',
        active
          ? 'border-white/20 bg-white/[0.07] text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
      )}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] tabular-nums',
          active ? 'bg-white/15 text-foreground' : 'bg-white/[0.06]',
        )}
      >
        {index + 1}
      </span>
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="truncate">{t(`${step.i18nKey}.title`)}</span>
    </button>
  );
}

function StepPane({ project, step }: { project: string; step: StoryStep }) {
  switch (step.kind) {
    case 'bible':
      return <StoryBiblePane project={project} />;
    case 'episodes':
      return <EpisodeDraftPane project={project} />;
    case 'compile':
      return <CompilePane project={project} />;
    case 'markdown':
    default:
      return (
        <StoryDocPane
          project={project}
          docId={step.docId as string}
          stepId={step.id}
          placeholderKey={`${step.i18nKey}.placeholder`}
        />
      );
  }
}
