// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneImage } from '@/api/ops';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import { createCropResultNode as createImageResultNode } from './imageCrop';
import { loadImageElement } from './imageData';

// Browser memory/canvas limits, independent of any model's reference constraints.
export const RESIZE_MAX_EDGE = 16_384;
export const RESIZE_MAX_PIXELS = 40_000_000;

export function validResizeDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height)
    && width > 0 && height > 0 && width <= RESIZE_MAX_EDGE && height <= RESIZE_MAX_EDGE
    && width * height <= RESIZE_MAX_PIXELS;
}

export function proportionalResizeDimension(value: number, from: number, to: number): number {
  return Math.max(1, Math.round(value * to / from));
}

/** Local resampling → upload → new image + source edge. No generation/billing API. */
export function resizeImage(
  sourceNodeId: string,
  imageSource: string,
  width: number,
  height: number,
  displayName: string,
): { nodeId: string; completion: Promise<void> } | null {
  const project = readUrl().project;
  if (!project || !validResizeDimensions(width, height)) return null;
  // Crop and rotate already use this same generic exportImage child shape.
  const nodeId = createImageResultNode(sourceNodeId, { displayName });
  if (!nodeId) return null;
  const store = useCanvasStore.getState();
  store.updateNodeData(nodeId, {
    previewImageUrl: null,
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationError: null,
  });
  const completion = (async () => {
    try {
      const image = await loadImageElement(imageSource);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2d context unavailable');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, width, height);
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG export failed')), 'image/png');
        });
        const uploaded = await uploadFreezoneImage(project, blob, `resize-${nodeId}-${Date.now()}.png`);
        useCanvasStore.getState().updateNodeData(nodeId, {
          imageUrl: uploaded.url,
          previewImageUrl: uploaded.url,
          imageNaturalWidth: width,
          imageNaturalHeight: height,
          aspectRatio: `${width}:${height}`,
          isGenerating: false,
          generationStartedAt: null,
          generationError: null,
          generationErrorDetails: null,
        });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useCanvasStore.getState().updateNodeData(nodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
        generationErrorDetails: message,
      });
    }
  })();
  store.requestFocusNode(nodeId);
  return { nodeId, completion };
}
