// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StoryClipNarrativePanel } from '@/features/canvas/nodes/StoryClipNarrativePanel';

const translations: Record<string, string> = {
  'canvas.story.segmentDetails': '剧情片段详情',
  'canvas.story.narrationLabel': '剧情内容',
  'canvas.story.narrationPlaceholder': '填写剧情',
  'canvas.story.productionNotesLabel': '制作备注',
  'canvas.story.productionNotesPlaceholder': '填写制作备注',
  'canvas.story.mediaState.missing': '待制作视频',
  'canvas.story.mediaState.ready': '视频已就绪',
  'canvas.story.reviewRequired': '需检查',
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
  it('有视频时同时展示剧情、制作备注和视频状态', () => {
    render(
      <StoryClipNarrativePanel
        narration="她推开门，看见走廊尽头的灯闪了三次。"
        productionNotes="保持雨夜光线连续。"
        mediaState="ready"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('她推开门，看见走廊尽头的灯闪了三次。')).toBeInTheDocument();
    expect(screen.getByDisplayValue('保持雨夜光线连续。')).toBeInTheDocument();
    expect(screen.getByText('视频已就绪')).toBeInTheDocument();
  });

  it('失焦时分别保存剧情和制作备注，不改动视频字段', () => {
    const onChange = vi.fn();
    render(
      <StoryClipNarrativePanel mediaState="missing" onChange={onChange} />,
    );

    const narration = screen.getByLabelText('剧情内容');
    fireEvent.change(narration, { target: { value: '  新剧情  ' } });
    fireEvent.blur(narration);

    const notes = screen.getByLabelText('制作备注');
    fireEvent.change(notes, { target: { value: '  连续性备注  ' } });
    fireEvent.blur(notes);

    expect(onChange).toHaveBeenNthCalledWith(1, { narration: '新剧情' });
    expect(onChange).toHaveBeenNthCalledWith(2, { storyProductionNotes: '连续性备注' });
    expect(screen.getByText('待制作视频')).toBeInTheDocument();
  });

  it('保留导入故事的期望视频文件名与复核提示', () => {
    render(
      <StoryClipNarrativePanel
        videoHint="scene-03.mp4"
        importNeedsReview
        importReviewNote="条件结构需要复核"
        mediaState="missing"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('待填视频:scene-03.mp4')).toBeInTheDocument();
    expect(screen.getByText('需检查')).toHaveAttribute('title', '条件结构需要复核');
  });
});
