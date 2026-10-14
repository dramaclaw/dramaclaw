import { describe, expect, it } from 'vitest';
import { canAddStoryGroups } from '@/features/canvas/domain/storyGroupLimit';

const story = { type: 'groupNode', data: { storyGroup: true } };
const ordinary = { type: 'groupNode', data: {} };

describe('story group paste limit', () => {
  it('allows pasting one story into another empty canvas', () => {
    expect(canAddStoryGroups([ordinary], [story])).toBe(true);
  });
  it('rejects a second story or a clipboard with multiple stories', () => {
    expect(canAddStoryGroups([story], [story])).toBe(false);
    expect(canAddStoryGroups([], [story, story])).toBe(false);
  });
  it('allows ordinary groups and individual clips alongside a story', () => {
    expect(canAddStoryGroups([story], [ordinary, { type: 'videoNode', data: {} }])).toBe(true);
  });
});
