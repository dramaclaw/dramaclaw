import { describe, expect, it } from 'vitest';

import {
  coverPointToMediaAnchor,
  mediaAnchorToCoverPoint,
  mediaAnchorToContainPoint,
  objectContainRenderRect,
  objectCoverRenderRect,
} from '@/features/canvas/story/objectCoverCoordinates';

describe('objectCoverCoordinates', () => {
  it('在 cover 裁切下可把播放器坐标无损反算回原视频锚点', () => {
    const container = { width: 2000, height: 900 };
    const media = { width: 1600, height: 900 };
    const anchor = { x: 0.75, y: 0.76 };
    const point = mediaAnchorToCoverPoint(anchor, container, media)!;

    expect(point).toEqual({ x: 1500, y: 742.5 });
    expect(coverPointToMediaAnchor(point, container, media)).toEqual(anchor);
  });

  it('把裁切区外的点击位置夹在原视频画幅边界内', () => {
    const container = { width: 1000, height: 1000 };
    const media = { width: 1600, height: 900 };
    const rendered = objectCoverRenderRect(container, media)!;

    expect(rendered.left).toBeLessThan(0);
    expect(coverPointToMediaAnchor({ x: 0, y: 500 }, container, media)).toEqual({
      x: expect.any(Number),
      y: 0.5,
    });
    expect(coverPointToMediaAnchor({ x: -1000, y: 500 }, container, media)?.x).toBe(0);
  });
});

describe('objectContainCoordinates', () => {
  it('竖屏视频在横屏容器中按完整画面留白并映射锚点', () => {
    const rendered = objectContainRenderRect(
      { width: 1600, height: 900 },
      { width: 900, height: 1600 },
    )!;
    expect(rendered).toEqual({ left: 546.875, top: 0, width: 506.25, height: 900 });
    expect(mediaAnchorToContainPoint(
      { x: 0.5, y: 0.5 },
      { width: 1600, height: 900 },
      { width: 900, height: 1600 },
    )).toEqual({ x: 800, y: 450 });
  });
});
