// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { deterministicNodeOutputIssue } from './workflowQualityGate';

describe('workflowQualityGate', () => {
  it('rejects incomplete generated batches and invalid durations', () => {
    expect(deterministicNodeOutputIssue('generate_image', {
      imageUrl: '/image.png',
      count: 4,
      generationBatch: ['/1.png', '/2.png'],
    })).toContain('数量不足');
    expect(deterministicNodeOutputIssue('generate_video', {
      videoUrl: '/video.mp4',
      durationMs: 0,
    })).toContain('时长无效');
  });

  it('accepts valid output metadata', () => {
    expect(deterministicNodeOutputIssue('generate_image', {
      imageUrl: '/image.png',
      imageNaturalWidth: 2048,
      imageNaturalHeight: 2048,
    })).toBeNull();
  });
});
