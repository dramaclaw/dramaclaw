// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import type { MediaModelParameterDefinition } from '@/api/ops';
import {
  filterMediaModelParamsForMode,
  userSelectableMediaModelParameters,
} from '@/features/canvas/ui/MediaModelParameterChip';

const parameters: MediaModelParameterDefinition[] = [
  {
    key: 'thinking_level',
    label: '思考等级',
    control: 'select',
    requestPath: 'thinking_level',
    options: ['low', 'medium', 'high'],
    default: 'low',
  },
  {
    key: 'style',
    label: '风格',
    control: 'select',
    requestPath: 'style',
    options: ['natural', 'vivid'],
    default: 'natural',
  },
];

describe('media model parameter visibility', () => {
  it('keeps thinking level server managed', () => {
    expect(userSelectableMediaModelParameters(parameters).map((item) => item.key)).toEqual([
      'style',
    ]);
  });

  it('does not resubmit a stored thinking level override', () => {
    expect(
      filterMediaModelParamsForMode(
        parameters,
        { thinking_level: 'high', style: 'vivid' },
        'text_to_image',
      ),
    ).toEqual({ style: 'vivid' });
  });
});
