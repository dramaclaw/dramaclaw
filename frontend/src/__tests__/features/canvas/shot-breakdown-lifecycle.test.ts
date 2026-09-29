// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

describe('shot breakdown lifecycle', () => {
  it('resets an unrecoverable in-flight flag when the canvas hydrates', () => {
    const node = {
      id: 'video-1',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: {
        displayName: 'source',
        videoUrl: '/static/source.mp4',
        isBreakingDown: true,
      },
    } as CanvasNode;

    useCanvasStore.getState().setCanvasData([node], []);

    expect(useCanvasStore.getState().nodes[0]?.data.isBreakingDown).toBe(false);
  });

  it('quotes the shared analysis feature on the button that submits the task', () => {
    const source = readFileSync(
      'src/features/canvas/ui/NodeActionToolbar.tsx',
      'utf8',
    );

    expect(source).toContain('params: { operation: "video_breakdown" }');
    expect(source).toContain('const shotBreakdownBillingRuleMissing =');
    expect(source).toContain('display={shotBreakdownCreditCostDisplay}');
    expect(source).toMatch(
      /if \((?:!hasVideo|serverOpBlocked) \|\| shotBreakdownBillingRuleMissing\) return;/,
    );
  });
});
