// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactCrop, {
  type Crop,
  type PixelCrop,
} from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { ToolSelectField } from '@/features/canvas/tools';
import type { VisualToolEditorProps } from './types';

const VIEWPORT_PADDING_PX = 20;
const VIEWPORT_MIN_WIDTH_PX = 220;
const VIEWPORT_MIN_HEIGHT_PX = 180;

function parsePresetRatio(value: string): number | null {
  if (!value.includes(':')) {
    return null;
  }

  const [rawW, rawH] = value.split(':').map((item) => Number(item));
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) {
    return null;
  }

  return rawW / rawH;
}

function parseCustomRatio(value: string): number | null {
  const input = value.trim();
  if (!input) {
    return null;
  }

  if (input.includes(':')) {
    return parsePresetRatio(input);
  }

  const numeric = Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toImageSpaceCrop(
  crop: PixelCrop,
  renderedWidth: number,
  renderedHeight: number,
  naturalWidth: number,
  naturalHeight: number
) {
  const scaleX = naturalWidth / renderedWidth;
  const scaleY = naturalHeight / renderedHeight;

  return {
    cropX: Math.round(crop.x * scaleX),
    cropY: Math.round(crop.y * scaleY),
    cropWidth: Math.round(crop.width * scaleX),
    cropHeight: Math.round(crop.height * scaleY),
  };
}

function toRenderedCrop(
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  renderedWidth: number,
  renderedHeight: number,
  naturalWidth: number,
  naturalHeight: number
): Crop {
  const scaleX = renderedWidth / naturalWidth;
  const scaleY = renderedHeight / naturalHeight;

  return {
    unit: 'px',
    x: Math.max(0, cropX * scaleX),
    y: Math.max(0, cropY * scaleY),
    width: Math.max(1, cropWidth * scaleX),
    height: Math.max(1, cropHeight * scaleY),
  };
}

function buildDefaultCrop(width: number, height: number, aspect: number | undefined): Crop {
  if (!aspect) {
    return { unit: 'px', x: 0, y: 0, width, height };
  }

  // 默认：高度吃满图片高度，宽度按 aspect 算。
  // 唯一例外：当 aspect 太横、按这个算出的宽度超出图片宽度时，clamp 回宽度吃满，
  // 高度反算 —— 否则框会溢出图的边界。
  let cropHeight = height;
  let cropWidth = cropHeight * aspect;
  if (cropWidth > width) {
    cropWidth = width;
    cropHeight = cropWidth / aspect;
  }

  const x = Math.max(0, (width - cropWidth) / 2);
  const y = Math.max(0, (height - cropHeight) / 2);

  return {
    unit: 'px',
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(cropWidth),
    height: Math.round(cropHeight),
  };
}

export function CropToolEditor({ plugin, sourceImageUrl, options, onOptionsChange }: VisualToolEditorProps) {
  const { t } = useTranslation();
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previousAspectKeyRef = useRef<string | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [customRatioInput, setCustomRatioInput] = useState(
    typeof options.customAspectRatio === 'string' ? options.customAspectRatio : ''
  );
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  const displaySourceImageUrl = useMemo(
    () => resolveImageDisplayUrl(sourceImageUrl),
    [sourceImageUrl]
  );

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateViewportSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const renderedImageSize = useMemo(() => {
    if (naturalSize.width <= 0 || naturalSize.height <= 0) {
      return null;
    }

    const maxWidth = Math.max(
      VIEWPORT_MIN_WIDTH_PX,
      viewportSize.width - VIEWPORT_PADDING_PX * 2
    );
    const maxHeight = Math.max(
      VIEWPORT_MIN_HEIGHT_PX,
      viewportSize.height - VIEWPORT_PADDING_PX * 2
    );
    const ratio = Math.min(maxWidth / naturalSize.width, maxHeight / naturalSize.height, 1);

    return {
      width: Math.max(1, Math.round(naturalSize.width * ratio)),
      height: Math.max(1, Math.round(naturalSize.height * ratio)),
    };
  }, [naturalSize.height, naturalSize.width, viewportSize.height, viewportSize.width]);

  const ratioOptions = useMemo(() => {
    const field = plugin.fields.find((item) => item.type === 'select' && item.key === 'aspectRatio');
    if (!field) {
      return [
        { labelKey: 'canvas.cropTool.ratioFree', value: 'free' },
        { label: '1:1', value: '1:1' },
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' },
        { label: '4:3', value: '4:3' },
        { label: '3:4', value: '3:4' },
        { label: '3:2', value: '3:2' },
        { label: '2:3', value: '2:3' },
        { label: '4:5', value: '4:5' },
        { label: '5:4', value: '5:4' },
        { label: '2:1', value: '2:1' },
        { label: '21:9', value: '21:9' },
        { labelKey: 'canvas.cropTool.ratioOriginal', value: 'original' },
      ];
    }

    return (field as ToolSelectField).options;
  }, [plugin.fields]);

  const aspectMode = typeof options.aspectRatio === 'string' ? options.aspectRatio : 'free';
  const resolvedAspect = useMemo(() => {
    if (aspectMode === 'free') {
      return undefined;
    }

    if (aspectMode === 'original') {
      if (naturalSize.width <= 0 || naturalSize.height <= 0) {
        return undefined;
      }
      return naturalSize.width / naturalSize.height;
    }

    if (aspectMode === 'custom') {
      return parseCustomRatio(customRatioInput) ?? undefined;
    }

    return parsePresetRatio(aspectMode) ?? undefined;
  }, [aspectMode, customRatioInput, naturalSize.height, naturalSize.width]);

  const customRatioError = useMemo(() => {
    if (aspectMode !== 'custom') {
      return null;
    }
    if (!customRatioInput.trim()) {
      return t('canvas.cropTool.ratioEmpty');
    }
    if (!parseCustomRatio(customRatioInput)) {
      return t('canvas.cropTool.ratioInvalid');
    }
    return null;
  }, [aspectMode, customRatioInput, t]);

  useEffect(() => {
    setCustomRatioInput(typeof options.customAspectRatio === 'string' ? options.customAspectRatio : '');
  }, [options.customAspectRatio]);

  const syncCropToOptions = useCallback((pixelCrop: PixelCrop) => {
    if (!renderedImageSize || naturalSize.width <= 0 || naturalSize.height <= 0) {
      return;
    }

    const imageCrop = toImageSpaceCrop(
      pixelCrop,
      renderedImageSize.width,
      renderedImageSize.height,
      naturalSize.width,
      naturalSize.height
    );

    onOptionsChange({
      ...options,
      aspectRatio: aspectMode,
      customAspectRatio: customRatioInput,
      ...imageCrop,
    });
  }, [
    aspectMode,
    customRatioInput,
    naturalSize.height,
    naturalSize.width,
    onOptionsChange,
    options,
    renderedImageSize,
  ]);

  const applyCropFromOptions = useCallback((): boolean => {
    if (!renderedImageSize || naturalSize.width <= 0 || naturalSize.height <= 0) {
      return false;
    }

    const cropX = toNumber(options.cropX);
    const cropY = toNumber(options.cropY);
    const cropWidth = toNumber(options.cropWidth);
    const cropHeight = toNumber(options.cropHeight);
    if (
      cropX === null ||
      cropY === null ||
      cropWidth === null ||
      cropHeight === null ||
      cropWidth <= 0 ||
      cropHeight <= 0
    ) {
      return false;
    }

    setCrop(
      toRenderedCrop(
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        renderedImageSize.width,
        renderedImageSize.height,
        naturalSize.width,
        naturalSize.height
      )
    );
    return true;
  }, [naturalSize.height, naturalSize.width, options.cropHeight, options.cropWidth, options.cropX, options.cropY, renderedImageSize]);

  useEffect(() => {
    if (!renderedImageSize) {
      return;
    }

    const aspectKey = `${aspectMode}:${aspectMode === 'custom' ? customRatioInput : ''}`;
    const aspectModeChanged =
      previousAspectKeyRef.current !== null
      && previousAspectKeyRef.current !== aspectKey;
    previousAspectKeyRef.current = aspectKey;

    if (!aspectModeChanged && applyCropFromOptions()) {
      return;
    }

    const next = buildDefaultCrop(
      renderedImageSize.width,
      renderedImageSize.height,
      resolvedAspect
    );
    setCrop(next);
    syncCropToOptions({
      unit: 'px',
      x: Math.round(next.x ?? 0),
      y: Math.round(next.y ?? 0),
      width: Math.round(next.width ?? renderedImageSize.width),
      height: Math.round(next.height ?? renderedImageSize.height),
    });
  }, [
    applyCropFromOptions,
    aspectMode,
    customRatioInput,
    renderedImageSize,
    resolvedAspect,
    syncCropToOptions,
  ]);

  const handleImageLoad = useCallback(() => {
    const image = imageRef.current;
    if (!image) {
      return;
    }

    setNaturalSize({
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {ratioOptions.map((item) => {
          const active = item.value === aspectMode;
          return (
            <button
              key={item.value}
              type="button"
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                active
                  ? 'border-white/[0.18] bg-white/[0.10] text-text-dark'
                  : 'border-white/[0.12] text-text-dark/55 hover:bg-white/[0.06] hover:text-text-dark'
              }`}
              onClick={() =>
                onOptionsChange({
                  ...options,
                  aspectRatio: item.value,
                })
              }
            >
              {item.labelKey ? t(item.labelKey) : item.label}
            </button>
          );
        })}

        <button
          type="button"
          className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
            aspectMode === 'custom'
              ? 'border-white/[0.18] bg-white/[0.10] text-text-dark'
              : 'border-white/[0.12] text-text-dark/55 hover:bg-white/[0.06] hover:text-text-dark'
          }`}
          onClick={() =>
            onOptionsChange({
              ...options,
              aspectRatio: 'custom',
            })
          }
        >
          {t('canvas.cropTool.ratioCustom')}
        </button>
      </div>

      {aspectMode === 'custom' && (
        <div className="flex items-center justify-center gap-2">
          <input
            type="text"
            value={customRatioInput}
            onChange={(event) => {
              const next = event.target.value;
              setCustomRatioInput(next);
              onOptionsChange({
                ...options,
                aspectRatio: 'custom',
                customAspectRatio: next,
              });
            }}
            placeholder={t('canvas.cropTool.ratioPlaceholder')}
            className="h-8 w-[220px] rounded-[8px] border border-white/[0.10] bg-bg-dark/42 px-3 text-sm text-text-dark outline-none transition-colors placeholder:text-text-dark/52 focus:border-white/[0.18]"
          />
          {customRatioError && <span className="text-xs text-red-400">{customRatioError}</span>}
        </div>
      )}

      <div
        ref={viewportRef}
        className="relative h-[min(46vh,450px)] rounded-[10px] border border-white/[0.10] bg-[#111214]/80"
      >
        <div className="flex h-full w-full items-center justify-center p-3">
          {renderedImageSize && (
            <ReactCrop
              crop={crop}
              onChange={(nextCrop) => setCrop(nextCrop)}
              onComplete={(pixelCrop) => syncCropToOptions(pixelCrop)}
              aspect={resolvedAspect}
              minWidth={24}
              minHeight={24}
              keepSelection
              ruleOfThirds
            >
              <img
                ref={imageRef}
                src={displaySourceImageUrl}
                alt="Crop Source"
                className="block select-none object-contain"
                style={{
                  width: `${renderedImageSize.width}px`,
                  height: `${renderedImageSize.height}px`,
                  maxWidth: 'none',
                  maxHeight: 'none',
                }}
                onLoad={handleImageLoad}
              />
            </ReactCrop>
          )}
          {!renderedImageSize && (
            <img
              ref={imageRef}
              src={displaySourceImageUrl}
              alt="Crop Source"
              className="hidden"
              onLoad={handleImageLoad}
            />
          )}
        </div>
      </div>
    </div>
  );
}
