// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { placeAnchoredMenu } from '@/features/canvas/nodes/shared/anchoredMenuPlacement';

const VIEWPORT = { viewportWidth: 1200, viewportHeight: 800 };

function rect(top: number, left = 400, height = 24) {
  return { top, bottom: top + height, left };
}

describe('placeAnchoredMenu', () => {
  it('下方放得下就开在下方，高度按内容给满', () => {
    const geometry = placeAnchoredMenu({
      anchorRect: rect(200),
      width: 236,
      preferredHeight: 300,
      ...VIEWPORT,
    });

    expect(geometry.placement).toBe('below');
    expect(geometry.top).toBe(228);
    expect(geometry.left).toBe(400);
    expect(geometry.maxHeight).toBe(300);
  });

  it('贴着视口下沿时翻到触发元素上方，而不是掉出屏幕', () => {
    // 操作面板贴在底边：chip 下面只剩 40px，塞不下 300px 的选单。
    const geometry = placeAnchoredMenu({
      anchorRect: rect(736),
      width: 236,
      preferredHeight: 300,
      ...VIEWPORT,
    });

    expect(geometry.placement).toBe('above');
    expect(geometry.maxHeight).toBe(300);
    // 上边缘在视口内，下边缘正好落在触发元素上方。
    expect(geometry.top).toBe(432);
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(736 - 4);
  });

  it('下方装不满但仍比上方宽裕：留在下方并收缩，不来回翻', () => {
    const geometry = placeAnchoredMenu({
      anchorRect: rect(300),
      width: 236,
      preferredHeight: 500,
      ...VIEWPORT,
    });

    expect(geometry.placement).toBe('below');
    expect(geometry.top).toBe(328);
    expect(geometry.maxHeight).toBe(464);
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(800 - 8);
  });

  it('翻到上方也放不满时收缩高度，让选单自己滚，不越出视口', () => {
    const geometry = placeAnchoredMenu({
      anchorRect: rect(200),
      width: 236,
      preferredHeight: 500,
      viewportWidth: 1200,
      viewportHeight: 400,
    });

    expect(geometry.placement).toBe('above');
    expect(geometry.maxHeight).toBe(188);
    expect(geometry.top).toBe(8);
  });

  it('上下都逼仄时留在下方，且整体压回视口内', () => {
    const geometry = placeAnchoredMenu({
      anchorRect: rect(60),
      width: 236,
      preferredHeight: 300,
      viewportWidth: 1200,
      viewportHeight: 160,
    });

    expect(geometry.placement).toBe('below');
    expect(geometry.top).toBeGreaterThanOrEqual(8);
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(160 - 8);
  });

  it('横向仍然夹在视口内', () => {
    expect(
      placeAnchoredMenu({
        anchorRect: rect(200, 1150),
        width: 236,
        preferredHeight: 100,
        ...VIEWPORT,
      }).left,
    ).toBe(1200 - 236 - 8);

    expect(
      placeAnchoredMenu({
        anchorRect: rect(200, -50),
        width: 236,
        preferredHeight: 100,
        ...VIEWPORT,
      }).left,
    ).toBe(8);
  });
});
