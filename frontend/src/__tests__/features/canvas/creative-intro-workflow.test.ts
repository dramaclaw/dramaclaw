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
        labels: {
          keyframe: '关键帧',
          design: '片名设计',
          motion: '片头动效',
          clip: '片头原片',
        },
      },
    );

    expect(result).toEqual({
      keyframeNodeId: 'keyframe-1',
      designNodeId: 'design-1',
      clipNodeId: null,
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

  it('adds a visible five-second source clip and two references for blended motion', () => {
    const addNode = vi.fn()
      .mockReturnValueOnce('design-1')
      .mockReturnValueOnce('clip-1')
      .mockReturnValueOnce('motion-1');
    const addEdge = vi.fn();

    const result = spawnCreativeIntroWorkflow(
      {
        addDerivedExportNode: vi.fn().mockReturnValue('keyframe-1'),
        addNode,
        addEdge,
        findNodePosition: vi.fn().mockReturnValue({ x: 100, y: 200 }),
        updateNodeData: vi.fn(),
        setSelectedNode: vi.fn(),
        requestFocusNode: vi.fn(),
      },
      {
        sourceNodeId: 'video-1',
        keyframeUrl: '/static/frame.png',
        aspectRatio: '16:9',
        plan: {
          title: '人言',
          frameSec: 3,
          designStyle: 'minimal',
          motionStyle: 'blurFade',
        },
        blend: {
          clipUrl: '/static/source-clip.mp4',
          range: { startSec: 1, endSec: 6, keyframeOffsetSec: 2 },
          capability: {
            modelId: 'catalog-seedance-2.5',
            modelLabel: 'Seedance 2.5',
            genMode: 'allReference',
          },
        },
        labels: {
          keyframe: '关键帧',
          design: '片名设计',
          motion: '片头动效',
          clip: '片头原片',
        },
      },
    );

    expect(result).toEqual({
      keyframeNodeId: 'keyframe-1',
      designNodeId: 'design-1',
      clipNodeId: 'clip-1',
      motionNodeId: 'motion-1',
    });
    expect(addEdge.mock.calls).toEqual([
      ['video-1', 'keyframe-1'],
      ['keyframe-1', 'design-1'],
      ['video-1', 'clip-1'],
      ['design-1', 'motion-1'],
      ['clip-1', 'motion-1'],
    ]);
    expect(addNode.mock.calls[1][2]).toMatchObject({
      videoUrl: '/static/source-clip.mp4',
      durationMs: 5_000,
      referenceOnly: true,
    });
    expect(addNode.mock.calls[2][2]).toMatchObject({
      genMode: 'allReference',
      model: 'catalog-seedance-2.5',
      referenceOrder: ['design-1', 'clip-1'],
      durationSec: 5,
    });
    expect(addNode.mock.calls[2][2].prompt).toContain(
      'keyframe occurs 2.00 seconds after the source clip begins',
    );
  });
});
