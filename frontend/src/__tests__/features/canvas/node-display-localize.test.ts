// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { localizeNodeDisplayName, withAutoTitleIndex } from '@/features/canvas/domain/nodeDisplay';

/**
 * 改名要落到已有画布上：新建的合成节点把「视频合成1」这种带自动序号的默认名写进了
 * 画布 JSON，只有渲染时仍认它是默认名，产品改名后老节点才会跟着变成新名字。
 */
describe('localizeNodeDisplayName', () => {
  const t = (key: string) => (key === 'node.displayName.videoComposeNode' ? '视频合成与剪辑' : key);

  it('localizes the auto-numbered default name and keeps the index', () => {
    const data = withAutoTitleIndex(
      CANVAS_NODE_TYPES.videoCompose,
      {} as CanvasNodeData,
      [],
    );
    expect(data.displayName).toBe('视频合成1');
    expect(localizeNodeDisplayName(CANVAS_NODE_TYPES.videoCompose, data, t as never)).toBe(
      '视频合成与剪辑1',
    );
  });

  it('keeps a name the user typed', () => {
    expect(
      localizeNodeDisplayName(
        CANVAS_NODE_TYPES.videoCompose,
        { displayName: '我的成片' } as CanvasNodeData,
        t as never,
      ),
    ).toBe('我的成片');
  });

  it('localizes the bare canonical name', () => {
    expect(
      localizeNodeDisplayName(
        CANVAS_NODE_TYPES.videoCompose,
        { displayName: '视频合成' } as CanvasNodeData,
        t as never,
      ),
    ).toBe('视频合成与剪辑');
  });
});
