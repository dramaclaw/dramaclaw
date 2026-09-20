// SPDX-License-Identifier: Elastic-2.0
import { renderHook } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { videoNoUpstreamResetMode } from '@/features/canvas/nodes/shared/videoModelCapabilities';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { continuityGenerationMode, useVideoContinuityMode } from '@/features/canvas/nodes/shared/useVideoContinuityMode';
import { CANVAS_NODE_TYPES, type VideoNodeData } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

function mountFmvClip() {
  useCanvasStore.getState().setCanvasData([{ id: 'clip', type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 }, data: { storySegmentId: 'segment-clip' } }], []);
}

afterEach(() => useCanvasStore.getState().setCanvasData([], []));

describe('automatic continuity generation mode', () => {
  it('settles with no captured frame when continuity and empty-input effects run together', () => {
    mountFmvClip();
    const { result, rerender } = renderHook(({ enabled }) => {
      const [data, setData] = useState<VideoNodeData>({ genMode: 'textToVideo' } as VideoNodeData);
      const mode = data.genMode ?? 'textToVideo';
      useVideoContinuityMode('clip', { ...data, continuityMode: enabled ? 'auto' : 'independent' },
        'newapi_seedance-2.0-fast', (_id, patch) => setData(current => ({ ...current, ...patch })));
      useEffect(() => {
        const next = videoNoUpstreamResetMode(mode, { images: 0, videos: 0, audios: 0 }, enabled);
        if (next) setData(current => ({ ...current, genMode: next }));
      }, [mode, enabled]);
      return mode;
    }, { initialProps: { enabled: true } });
    expect(result.current).toBe('allReference');
    rerender({ enabled: false });
    expect(result.current).toBe('textToVideo');
  });

  it('uses the model image default and preserves supported image modes', () => {
    expect(continuityGenerationMode('textToVideo', 'newapi_seedance-2.0-fast')).toBe('allReference');
    expect(continuityGenerationMode('textToVideo', 'newapi_seedance-1.0-pro-fast')).toBe('firstFrame');
    expect(continuityGenerationMode('firstFrame', 'newapi_seedance-2.0-fast')).toBe('firstFrame');
    expect(continuityGenerationMode('videoEdit', 'newapi_happyhorse-1.0')).toBe('imageToVideo');
  });

  it('repairs persisted text mode on enabling continuity and leaves independent shots alone', () => {
    mountFmvClip();
    const update = vi.fn();
    const data = { continuityMode: 'independent', genMode: 'textToVideo' } as VideoNodeData;
    const { rerender } = renderHook(({ value }) => useVideoContinuityMode('clip', value, 'newapi_seedance-2.0-fast', update), { initialProps: { value: data } });
    expect(update).not.toHaveBeenCalled();
    rerender({ value: { ...data, continuityMode: 'auto' } });
    expect(update).toHaveBeenLastCalledWith('clip', { genMode: 'allReference' });
    update.mockClear();
    rerender({ value: { ...data, continuityMode: 'auto', storyRole: 'start' } });
    expect(update).not.toHaveBeenCalled();
  });
});
