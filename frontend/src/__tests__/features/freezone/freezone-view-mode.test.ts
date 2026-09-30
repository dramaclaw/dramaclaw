// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import {
  FREEZONE_VIEW_MODE_KEY,
  readStoredViewMode,
  writeStoredViewMode,
} from '@/features/freezone/useFreezoneViewMode';

describe('freezone view mode persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('默认返回 workflow', () => {
    expect(readStoredViewMode()).toBe('workflow');
  });

  it('写入 board 后能读回；写入 workflow 亦然', () => {
    writeStoredViewMode('board');
    expect(window.localStorage.getItem(FREEZONE_VIEW_MODE_KEY)).toBe('board');
    expect(readStoredViewMode()).toBe('board');
    writeStoredViewMode('workflow');
    expect(readStoredViewMode()).toBe('workflow');
  });

  it('localStorage 里是脏值时回落 workflow', () => {
    window.localStorage.setItem(FREEZONE_VIEW_MODE_KEY, 'banana');
    expect(readStoredViewMode()).toBe('workflow');
  });
});
