// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  STORY_STAGE_ORDER,
  deriveStoryStages,
  type StoryStageEvidence,
} from '@/features/canvas/story/storyStages';
import type { PendingStoryOutline } from '@/features/canvas/story/pendingStoryOutline';

function outline(overrides: Partial<PendingStoryOutline> = {}): PendingStoryOutline {
  return {
    outline_id: 'outline-round-1',
    kind: 'story',
    title: '雨夜出租车',
    premise: 'p',
    plot_summary: 's',
    interaction_summary: '',
    endings_summary: '',
    duration_budget_sec: null,
    open_questions: [],
    status: 'pending',
    story_id: null,
    updated_at: '',
    ...overrides,
  };
}

function evidence(overrides: Partial<StoryStageEvidence> = {}): StoryStageEvidence {
  return {
    outline: null,
    hasStoryGroup: false,
    synopsisPresent: false,
    segmentCount: 0,
    scriptReadyCount: 0,
    promptReadyCount: 0,
    videoReadyCount: 0,
    lintErrorCount: 0,
    characterCount: 0,
    confirmedStages: [],
    ...overrides,
  };
}

const statusOf = (
  model: ReturnType<typeof deriveStoryStages>,
): Record<string, string> =>
  Object.fromEntries(model.stages.map((stage) => [stage.id, stage.status]));

describe('deriveStoryStages (story flow)', () => {
  it('follows the canonical eight-stage order', () => {
    const model = deriveStoryStages(evidence());
    expect(model.stages.map((stage) => stage.id)).toEqual(STORY_STAGE_ORDER);
  });

  it('empty canvas: nothing started, no fake progress', () => {
    const model = deriveStoryStages(evidence());
    expect(statusOf(model)).toMatchObject({
      proposal: 'todo',
      outline: 'todo',
      script: 'todo',
      video: 'todo',
      complete: 'manual',
    });
    expect(model.currentStageId).toBe('proposal');
  });

  it('pending outline is in progress, not done', () => {
    const model = deriveStoryStages(evidence({ outline: outline() }));
    expect(statusOf(model)).toMatchObject({ proposal: 'active', outline: 'active' });
    expect(model.stages.find((s) => s.id === 'proposal')?.status).toBe('active');
    expect(model.stages.find((s) => s.id === 'outline')?.status).toBe('active');
    expect(model.currentStageId).toBe('proposal');
  });

  it('confirmed outline lights proposal/outline; placeholder story keeps script in progress', () => {
    const model = deriveStoryStages(
      evidence({
        outline: outline({ status: 'confirmed' }),
        hasStoryGroup: true,
        synopsisPresent: true,
        segmentCount: 3,
        scriptReadyCount: 1,
        videoReadyCount: 0,
      }),
    );
    const status = statusOf(model);
    expect(status.proposal).toBe('done');
    expect(status.outline).toBe('done');
    expect(status.script).toBe('active');
    expect(status.video).toBe('todo');
    expect(model.currentStageId).toBe('script');
  });

  it('partial videos stay active; generation is never completion', () => {
    const partial = statusOf(
      deriveStoryStages(
        evidence({
          outline: outline({ status: 'linked' }),
          hasStoryGroup: true,
          synopsisPresent: true,
          segmentCount: 4,
          scriptReadyCount: 4,
          videoReadyCount: 3,
          characterCount: 2,
        }),
      ),
    );
    expect(partial.script).toBe('done');
    // storyCharacters is script metadata, not proof that character assets exist.
    expect(partial.characters).toBe('manual');
    expect(partial.video).toBe('active');

    const ready = statusOf(
      deriveStoryStages(
        evidence({
          outline: outline({ status: 'linked' }),
          hasStoryGroup: true,
          synopsisPresent: true,
          segmentCount: 4,
          scriptReadyCount: 4,
          videoReadyCount: 4,
          characterCount: 2,
        }),
      ),
    );
    expect(ready.video).toBe('done');
    // 「完成」需要试玩与交付验收：即使全部素材就绪也不自动点亮。
    expect(ready.complete).toBe('manual');
  });

  it('lint errors keep the script stage unfinished', () => {
    const status = statusOf(
      deriveStoryStages(
        evidence({
          hasStoryGroup: true,
          synopsisPresent: true,
          segmentCount: 2,
          scriptReadyCount: 2,
          lintErrorCount: 1,
        }),
      ),
    );
    expect(status.script).toBe('active');
  });

  it('stages without a stable criterion are always manual', () => {
    const model = deriveStoryStages(
      evidence({
        outline: outline({ status: 'linked' }),
        hasStoryGroup: true,
        synopsisPresent: true,
        segmentCount: 2,
        scriptReadyCount: 2,
        characterCount: 2,
      }),
    );
    const status = statusOf(model);
    expect(status.characters).toBe('manual');
    expect(status.scenes).toBe('manual');
    expect(status.storyboard).toBe('manual');
    expect(status.complete).toBe('manual');
    expect(model.currentStageId).toBe('characters');
  });

  it('advances manual stages only after explicit confirmation', () => {
    const model = deriveStoryStages(
      evidence({
        outline: outline({ status: 'linked' }),
        hasStoryGroup: true,
        synopsisPresent: true,
        segmentCount: 2,
        scriptReadyCount: 2,
        confirmedStages: ['characters', 'scenes'],
      }),
    );
    const status = statusOf(model);
    expect(status.characters).toBe('done');
    expect(status.scenes).toBe('done');
    expect(status.storyboard).toBe('manual');
    expect(model.currentStageId).toBe('storyboard');
  });

});

describe('deriveStoryStages (ad flow)', () => {
  it('shares the canonical eight-stage pipeline with the story flow', () => {
    const model = deriveStoryStages(
      evidence({ outline: outline({ kind: 'ad', status: 'confirmed' }) }),
    );
    expect(model.kind).toBe('ad');
    expect(model.stages.map((stage) => stage.id)).toEqual(STORY_STAGE_ORDER);
    expect(statusOf(model).complete).toBe('manual');
  });

  it('ad segments advance the shared script stage like a story', () => {
    const status = statusOf(
      deriveStoryStages(
        evidence({
          outline: outline({ kind: 'ad', status: 'linked' }),
          hasStoryGroup: true,
          synopsisPresent: true,
          segmentCount: 3,
          scriptReadyCount: 3,
          promptReadyCount: 2,
        }),
      ),
    );
    expect(status.script).toBe('done');
    // 角色/场景/分镜无统一自动判据：广告与影游一样停在 manual，不假装完成。
    expect(status.characters).toBe('manual');
  });
});
