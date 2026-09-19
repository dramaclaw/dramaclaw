// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  CANVAS_ACTION_IDS,
  canvasActionsForNode,
  getCanvasActionDescriptor,
  resolveCanvasActionAvailability,
} from '@/features/canvas/application/canvasActionRegistry';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

describe('canvas action registry', () => {
  it('declares audio transforms and splits as spawn actions', () => {
    const ids = canvasActionsForNode(CANVAS_NODE_TYPES.audio).map((action) => action.id);
    expect(ids).toEqual([
      CANVAS_ACTION_IDS.audioTrim,
      CANVAS_ACTION_IDS.audioSpeed,
      CANVAS_ACTION_IDS.audioSmartSplit,
      CANVAS_ACTION_IDS.audioCustomSplit,
    ]);
    expect(getCanvasActionDescriptor(CANVAS_ACTION_IDS.audioTrim)?.effect).toBe('spawn');
    expect(getCanvasActionDescriptor(CANVAS_ACTION_IDS.audioSmartSplit)?.effect).toBe('spawn');
  });

  it('does not expose audio actions for video nodes', () => {
    expect(canvasActionsForNode(CANVAS_NODE_TYPES.video)).toEqual([]);
  });

  it('reports stable disabled reasons before execution', () => {
    const action = getCanvasActionDescriptor(CANVAS_ACTION_IDS.audioTrim)!;
    expect(resolveCanvasActionAvailability(action, {
      nodeType: CANVAS_NODE_TYPES.audio,
      hasMedia: false,
      mediaIsLocal: true,
    })).toEqual({ available: false, reason: 'missing-media' });
    expect(resolveCanvasActionAvailability(action, {
      nodeType: CANVAS_NODE_TYPES.audio,
      hasMedia: true,
      mediaIsLocal: false,
    })).toEqual({ available: false, reason: 'remote-media' });
    expect(resolveCanvasActionAvailability(action, {
      nodeType: CANVAS_NODE_TYPES.audio,
      hasMedia: true,
      mediaIsLocal: true,
      busy: true,
    })).toEqual({ available: false, reason: 'busy' });
  });
});
