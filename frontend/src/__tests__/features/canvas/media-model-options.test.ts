// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { describe, expect, it } from 'vitest';

import {
  formatResolutionLabel,
  resolveModelAspectOptions,
  resolveModelSizeOptions,
} from '@/features/canvas/domain/mediaModelOptions';

describe('媒体模型公共选项归一化', () => {
  it('把历史 adaptive 比例收敛为唯一的 auto 选项', () => {
    expect(
      resolveModelAspectOptions({ ratioOptions: ['adaptive', 'Auto', '16:9'] }),
    ).toEqual(['auto', '16:9']);
  });

  it('保留后台配置的分辨率档位顺序', () => {
    expect(resolveModelSizeOptions({ resolutionOptions: ['720p', '1080p'] })).toEqual([
      '720p',
      '1080p',
    ]);
  });

  it('分辨率只在显示层统一成小写', () => {
    expect(formatResolutionLabel('4K')).toBe('4k');
    expect(formatResolutionLabel('1080P')).toBe('1080p');
  });
});
