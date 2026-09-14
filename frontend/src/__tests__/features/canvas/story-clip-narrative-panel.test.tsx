// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StoryClipNarrativePanel } from '@/features/canvas/nodes/StoryClipNarrativePanel';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const translations: Record<string, string> = {
  'canvas.story.segmentDetails': '剧情片段详情',
  'canvas.story.narrationLabel': '剧情内容',
  'canvas.story.narrationPlaceholder': '填写剧情',
  'canvas.story.productionNotesLabel': '制作备注',
  'canvas.story.productionNotesPlaceholder': '填写制作备注',
  'canvas.story.mediaState.missing': '待制作视频',
  'canvas.story.mediaState.ready': '视频已就绪',
  'canvas.story.reviewRequired': '需检查',
  'canvas.story.choiceLoop.label': '选择循环',
  'canvas.story.choiceLoop.freezeTail': '停在尾帧',
  'canvas.story.choiceLoop.hint': '等待选择时循环播放',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { file?: string }) =>
      key === 'canvas.story.importClipHint'
        ? `待填视频:${params?.file ?? ''}`
        : translations[key] ?? key,
  }),
}));

describe('StoryClipNarrativePanel', () => {
  it('有视频时展示剧情与制作备注，不展示冗余就绪状态', () => {
    render(
      <StoryClipNarrativePanel
        nodeId="clip"
        narration="她推开门，看见走廊尽头的灯闪了三次。"
        productionNotes="保持雨夜光线连续。"
        mediaState="ready"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('她推开门，看见走廊尽头的灯闪了三次。')).toBeInTheDocument();
    expect(screen.getByDisplayValue('保持雨夜光线连续。')).toBeInTheDocument();
    expect(screen.queryByText('视频已就绪')).not.toBeInTheDocument();
  });

  it('失焦时分别保存剧情和制作备注，不改动视频字段', () => {
    const onChange = vi.fn();
    render(
      <StoryClipNarrativePanel nodeId="clip" mediaState="missing" onChange={onChange} />,
    );

    const narration = screen.getByLabelText('剧情内容');
    fireEvent.change(narration, { target: { value: '  新剧情  ' } });
    fireEvent.blur(narration);

    const notes = screen.getByLabelText('制作备注');
    fireEvent.change(notes, { target: { value: '  连续性备注  ' } });
    fireEvent.blur(notes);

    expect(onChange).toHaveBeenNthCalledWith(1, { narration: '新剧情' });
    expect(onChange).toHaveBeenNthCalledWith(2, { storyProductionNotes: '连续性备注' });
    expect(screen.queryByText('待制作视频')).not.toBeInTheDocument();
  });

  it('保留导入故事的期望视频文件名与复核提示', () => {
    render(
      <StoryClipNarrativePanel
        nodeId="clip"
        videoHint="scene-03.mp4"
        importNeedsReview
        importReviewNote="条件结构需要复核"
        mediaState="missing"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('scene-03.mp4')).toBeInTheDocument();
    expect(screen.getByText('需检查')).toHaveAttribute('title', '条件结构需要复核');
  });

  it.each(['uploading', 'generating', 'failed'] as const)('保留需要关注的 %s 状态', (mediaState) => {
    render(<StoryClipNarrativePanel nodeId="clip" mediaState={mediaState} videoHint="clip.mp4" onChange={vi.fn()} />);
    expect(screen.getByText(`canvas.story.mediaState.${mediaState}`)).toBeInTheDocument();
  });

  it('有出向选项时可从画布视频绑定选择循环', () => {
    const previous = useCanvasStore.getState();
    const clip = {
      id: 'clip', type: CANVAS_NODE_TYPES.video, parentId: 'story', position: { x: 0, y: 0 },
      data: { videoUrl: '/main.mp4', storyChoiceLoop: { description: '轻微呼吸' } },
    } as CanvasNode;
    const loop = {
      id: 'loop', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
      data: { displayName: '窗边循环', videoUrl: '/loop.mp4', durationMs: 3200, generationTaskJobId: 'job' },
    } as CanvasNode;
    useCanvasStore.setState({
      nodes: [
        { id: 'story', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { storyGroup: true } } as CanvasNode,
        clip,
        loop,
      ],
      edges: [{ id: 'choice', source: 'clip', target: 'ending', type: 'storyChoiceEdge' } as CanvasEdge],
    });
    const onChange = vi.fn();
    try {
      render(<StoryClipNarrativePanel nodeId="clip" mediaState="ready" onChange={onChange} />);
      fireEvent.change(screen.getByLabelText('选择循环'), { target: { value: 'loop' } });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
        choiceLoopVideoUrl: '/loop.mp4',
        storyChoiceLoop: expect.objectContaining({
          media: expect.objectContaining({ source: 'generated', status: 'ready', url: '/loop.mp4' }),
        }),
      }));
    } finally {
      useCanvasStore.setState({ nodes: previous.nodes, edges: previous.edges });
    }
  });
});
