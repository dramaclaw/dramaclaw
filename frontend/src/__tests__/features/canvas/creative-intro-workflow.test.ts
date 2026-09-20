import { describe, expect, it, vi } from 'vitest';

import {
  buildCreativeIntroPrompts,
  spawnCreativeIntroWorkflow,
} from '@/features/canvas/application/creativeIntroWorkflow';

describe('creative intro workflow', () => {
  it('keeps the exact title and selected styles in both prompts', () => {
    const prompts = buildCreativeIntroPrompts({
      title: '人言',
      frameSec: 1.25,
      designStyle: 'chineseCalligraphy',
      motionStyle: 'handwriting',
    });
    expect(prompts.designPrompt).toContain('"人言"');
    expect(prompts.designPrompt).toContain('Chinese calligraphy');
    expect(prompts.motionPrompt).toContain('five-second');
    expect(prompts.motionPrompt).toContain('stroke by stroke');
  });

  it('spawns a traceable source -> keyframe -> design -> motion chain', () => {
    const addNode = vi.fn()
      .mockReturnValueOnce('design-1')
      .mockReturnValueOnce('motion-1');
    const addEdge = vi.fn();
    const updateNodeData = vi.fn();
    const setSelectedNode = vi.fn();
    const requestFocusNode = vi.fn();

    const result = spawnCreativeIntroWorkflow(
      {
        addDerivedExportNode: vi.fn().mockReturnValue('keyframe-1'),
        addNode,
        addEdge,
        findNodePosition: vi.fn().mockReturnValue({ x: 100, y: 200 }),
        updateNodeData,
        setSelectedNode,
        requestFocusNode,
      },
      {
        sourceNodeId: 'video-1',
        keyframeUrl: '/static/frame.png',
        aspectRatio: '16:9',
        plan: {
          title: '人言',
          frameSec: 1.25,
          designStyle: 'minimal',
          motionStyle: 'blurFade',
        },
        labels: { keyframe: '关键帧', design: '片名设计', motion: '片头动效' },
      },
    );

    expect(result).toEqual({
      keyframeNodeId: 'keyframe-1',
      designNodeId: 'design-1',
      motionNodeId: 'motion-1',
    });
    expect(addEdge.mock.calls).toEqual([
      ['video-1', 'keyframe-1'],
      ['keyframe-1', 'design-1'],
      ['design-1', 'motion-1'],
    ]);
    expect(addNode.mock.calls[0][2]).toMatchObject({ imageUrl: null, aspectRatio: '16:9' });
    expect(addNode.mock.calls[1][2]).toMatchObject({
      videoUrl: null,
      genMode: 'imageReference',
      durationSec: 5,
    });
    expect(updateNodeData).toHaveBeenCalledWith(
      'keyframe-1',
      expect.objectContaining({ displayName: '关键帧' }),
    );
    expect(setSelectedNode).toHaveBeenCalledWith('design-1');
    expect(requestFocusNode).toHaveBeenCalledWith('design-1');
  });
});
