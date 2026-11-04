// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { deriveStageNavLayout } from '@/features/freezone/StoryStageNav';
import type { StoryStage, StoryStageId } from '@/features/canvas/story/storyStages';

const ids: StoryStageId[] = [
  'proposal',
  'outline',
  'script',
  'characters',
  'scenes',
  'storyboard',
  'video',
  'complete',
];

const stages: StoryStage[] = ids.map((id, index) => ({
  id,
  status: index < 5 ? 'done' : index === 5 ? 'active' : 'todo',
}));

const stageIds = (items: StoryStage[]) => items.map((stage) => stage.id);

describe('deriveStageNavLayout', () => {
  it('keeps every stage when both side panels are closed', () => {
    const layout = deriveStageNavLayout(stages, 'storyboard', 'none');

    expect(stageIds(layout.visible)).toEqual(ids);
    expect(layout.leading).toEqual([]);
    expect(layout.trailing).toEqual([]);
    expect(layout.compact).toBe(false);
  });

  it('folds the completed prefix when the left panel expands', () => {
    const layout = deriveStageNavLayout(stages, 'storyboard', 'start');

    expect(stageIds(layout.leading)).toEqual(ids.slice(0, 5));
    expect(stageIds(layout.visible)).toEqual(['storyboard', 'video', 'complete']);
    expect(layout.trailing).toEqual([]);
  });

  it('folds the distant suffix when the right panel expands', () => {
    const layout = deriveStageNavLayout(stages, 'characters', 'end');

    expect(layout.leading).toEqual([]);
    expect(stageIds(layout.visible)).toEqual(ids.slice(0, 5));
    expect(stageIds(layout.trailing)).toEqual(['storyboard', 'video', 'complete']);
  });

  it('folds the useful side instead of replacing one stage with a longer summary', () => {
    const layout = deriveStageNavLayout(stages, 'storyboard', 'both');

    expect(stageIds(layout.leading)).toEqual(ids.slice(0, 5));
    expect(stageIds(layout.visible)).toEqual(['storyboard', 'video', 'complete']);
    expect(layout.trailing).toEqual([]);
  });

  it('falls back to the opposite side when the current stage is at an edge', () => {
    const atStart = deriveStageNavLayout(stages, 'proposal', 'start');
    const atEnd = deriveStageNavLayout(stages, 'complete', 'end');

    expect(stageIds(atStart.visible)).toEqual(['proposal', 'outline']);
    expect(stageIds(atStart.trailing)).toEqual(ids.slice(2));
    expect(stageIds(atEnd.leading)).toEqual(ids.slice(0, 7));
    expect(stageIds(atEnd.visible)).toEqual(['complete']);
  });
});
