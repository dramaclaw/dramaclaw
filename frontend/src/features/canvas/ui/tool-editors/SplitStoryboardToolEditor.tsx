// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { UiInput } from '@/components/ui';
import type { VisualToolEditorProps } from './types';

const MIN_GRID_SIZE = 1;
const MAX_GRID_SIZE = 8;
const DEFAULT_LINE_THICKNESS_PERCENT = 0.5;
const MAX_LINE_THICKNESS_PERCENT = 20;
const LEGACY_DEFAULT_LINE_THICKNESS_PX = 6;
const SPLIT_RANGE_CLASS =
  'h-0.5 w-full cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#5b8cff] [&::-webkit-slider-thumb]:shadow-none [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[#5b8cff]';

interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SplitLayout {
  lineRects: OverlayRect[];
  cellRects: CellRect[];
  minCellWidth: number;
  maxCellWidth: number;
  minCellHeight: number;
  maxCellHeight: number;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return fallback;
}

function clampInteger(value: number, min: number, max: number, fallback = min): number {
  const safeValue = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.round(safeValue)));
}

function clampDecimal(value: number, min: number, max: number, fallback = min, precision = 2): number {
  const safeValue = Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(min, Math.min(max, safeValue));
  const factor = 10 ** precision;
  return Math.round(clamped * factor) / factor;
}

function resolveMaxLineThicknessPx(rows: number, cols: number, width: number, height: number): number {
  const maxByWidth = cols > 1 ? Math.floor((width - cols) / (cols - 1)) : Number.MAX_SAFE_INTEGER;
  const maxByHeight = rows > 1 ? Math.floor((height - rows) / (rows - 1)) : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(maxByWidth, maxByHeight));
}

function resolveLineThicknessPxFromPercent(
  lineThicknessPercent: number,
  rows: number,
  cols: number,
  width: number,
  height: number
): number {
  if (lineThicknessPercent <= 0) {
    return 0;
  }

  const basis = Math.max(1, Math.min(width, height));
  const rawPixelThickness = Math.max(1, Math.round((basis * lineThicknessPercent) / 100));
  const maxAllowed = resolveMaxLineThicknessPx(rows, cols, width, height);
  return clampInteger(rawPixelThickness, 0, maxAllowed);
}

function splitSizes(total: number, segments: number): number[] {
  const base = Math.floor(total / segments);
  const remainder = total % segments;

  return Array.from({ length: segments }, (_value, index) => base + (index < remainder ? 1 : 0));
}

function computeSplitLayout(
  imageWidth: number,
  imageHeight: number,
  rows: number,
  cols: number,
  lineThickness: number
): SplitLayout | null {
  const usableWidth = imageWidth - (cols - 1) * lineThickness;
  const usableHeight = imageHeight - (rows - 1) * lineThickness;

  if (usableWidth < cols || usableHeight < rows) {
    return null;
  }

  const colWidths = splitSizes(usableWidth, cols);
  const rowHeights = splitSizes(usableHeight, rows);

  const lineRects: OverlayRect[] = [];
  const xOffsets: number[] = [];
  const yOffsets: number[] = [];

  let cursorX = 0;
  for (let col = 0; col < cols; col += 1) {
    xOffsets.push(cursorX);
    cursorX += colWidths[col];
    if (col < cols - 1 && lineThickness > 0) {
      lineRects.push({
        x: cursorX,
        y: 0,
        width: lineThickness,
        height: imageHeight,
      });
      cursorX += lineThickness;
    }
  }

  let cursorY = 0;
  for (let row = 0; row < rows; row += 1) {
    yOffsets.push(cursorY);
    cursorY += rowHeights[row];
    if (row < rows - 1 && lineThickness > 0) {
      lineRects.push({
        x: 0,
        y: cursorY,
        width: imageWidth,
        height: lineThickness,
      });
      cursorY += lineThickness;
    }
  }

  const cellRects: CellRect[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cellRects.push({
        x: xOffsets[col],
        y: yOffsets[row],
        width: colWidths[col],
        height: rowHeights[row],
      });
    }
  }

  return {
    lineRects,
    cellRects,
    minCellWidth: Math.min(...colWidths),
    maxCellWidth: Math.max(...colWidths),
    minCellHeight: Math.min(...rowHeights),
    maxCellHeight: Math.max(...rowHeights),
  };
}

function splitSizeLabel(min: number, max: number): string {
  if (min === max) {
    return `${min}`;
  }
  return `${min} - ${max}`;
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

interface NumberStepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

function NumberStepper({ label, value, min, max, onChange }: NumberStepperProps) {
  const decreaseDisabled = value <= min;
  const increaseDisabled = value >= max;

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="h-8 w-7 text-lg font-semibold leading-none text-text-dark/68 transition-colors hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => onChange(value - 1)}
          disabled={decreaseDisabled}
        >
          -
        </button>
        <UiInput
          type="number"
          value={value}
          min={min}
          max={max}
          step={1}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-8 rounded-[8px] border-white/[0.10] bg-bg-dark/42 text-center"
        />
        <button
          type="button"
          className="h-8 w-7 text-lg font-semibold leading-none text-text-dark/68 transition-colors hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => onChange(value + 1)}
          disabled={increaseDisabled}
        >
          +
        </button>
      </div>
    </div>
  );
}

export function SplitStoryboardToolEditor({ sourceImageUrl, options, onOptionsChange }: VisualToolEditorProps) {
  const { t } = useTranslation();
  const imageRef = useRef<HTMLImageElement | null>(null);
  const previewAreaRef = useRef<HTMLDivElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [previewAreaSize, setPreviewAreaSize] = useState<{ width: number; height: number } | null>(null);
  const displaySourceImageUrl = useMemo(() => resolveImageDisplayUrl(sourceImageUrl), [sourceImageUrl]);

  useEffect(() => {
    setNaturalSize(null);
  }, [displaySourceImageUrl]);

  useEffect(() => {
    const previewArea = previewAreaRef.current;
    if (!previewArea) {
      return;
    }

    const updatePreviewAreaSize = () => {
      const rect = previewArea.getBoundingClientRect();
      setPreviewAreaSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    };

    updatePreviewAreaSize();
    const observer = new ResizeObserver(updatePreviewAreaSize);
    observer.observe(previewArea);
    return () => observer.disconnect();
  }, []);

  const rows = clampInteger(toFiniteNumber(options.rows, 3), MIN_GRID_SIZE, MAX_GRID_SIZE);
  const cols = clampInteger(toFiniteNumber(options.cols, 3), MIN_GRID_SIZE, MAX_GRID_SIZE);

  const legacyLineThicknessPx = Math.max(0, toFiniteNumber(options.lineThickness, LEGACY_DEFAULT_LINE_THICKNESS_PX));
  const maxLineThicknessPercent = useMemo(() => {
    if (!naturalSize) {
      return MAX_LINE_THICKNESS_PERCENT;
    }

    const maxLinePx = resolveMaxLineThicknessPx(rows, cols, naturalSize.width, naturalSize.height);
    const basis = Math.max(1, Math.min(naturalSize.width, naturalSize.height));
    return clampDecimal((maxLinePx / basis) * 100, 0, MAX_LINE_THICKNESS_PERCENT);
  }, [cols, naturalSize, rows]);

  const fallbackLineThicknessPercent = useMemo(() => {
    if (!naturalSize) {
      return DEFAULT_LINE_THICKNESS_PERCENT;
    }

    const basis = Math.max(1, Math.min(naturalSize.width, naturalSize.height));
    return clampDecimal(
      (legacyLineThicknessPx / basis) * 100,
      0,
      maxLineThicknessPercent,
      DEFAULT_LINE_THICKNESS_PERCENT
    );
  }, [legacyLineThicknessPx, maxLineThicknessPercent, naturalSize]);

  const rawLineThicknessPercent = Math.max(
    0,
    toFiniteNumber(options.lineThicknessPercent, fallbackLineThicknessPercent)
  );
  const lineThicknessPercent = clampDecimal(
    rawLineThicknessPercent,
    0,
    maxLineThicknessPercent,
    fallbackLineThicknessPercent
  );

  const lineThicknessPx = useMemo(() => {
    if (!naturalSize) {
      return 0;
    }

    return resolveLineThicknessPxFromPercent(
      lineThicknessPercent,
      rows,
      cols,
      naturalSize.width,
      naturalSize.height
    );
  }, [cols, lineThicknessPercent, naturalSize, rows]);

  const layout = useMemo(() => {
    if (!naturalSize) {
      return null;
    }

    return computeSplitLayout(
      naturalSize.width,
      naturalSize.height,
      rows,
      cols,
      lineThicknessPx
    );
  }, [cols, lineThicknessPx, naturalSize, rows]);

  const displaySize = useMemo(() => {
    if (!naturalSize || !previewAreaSize) {
      return null;
    }

    const scale = Math.min(
      previewAreaSize.width / naturalSize.width,
      previewAreaSize.height / naturalSize.height,
      1
    );

    return {
      width: Math.max(1, Math.round(naturalSize.width * scale)),
      height: Math.max(1, Math.round(naturalSize.height * scale)),
    };
  }, [naturalSize, previewAreaSize]);

  const toCellStyle = useCallback(
    (rect: CellRect): CSSProperties => {
      if (!naturalSize || !displaySize) {
        return {};
      }

      return {
        left: (rect.x / naturalSize.width) * displaySize.width,
        top: (rect.y / naturalSize.height) * displaySize.height,
        width: (rect.width / naturalSize.width) * displaySize.width,
        height: (rect.height / naturalSize.height) * displaySize.height,
      };
    },
    [displaySize, naturalSize]
  );

  const toLineStyle = useCallback(
    (rect: OverlayRect): CSSProperties => {
      if (!naturalSize || !displaySize) {
        return {};
      }

      const isVerticalLine = rect.height > rect.width;
      return {
        left: (rect.x / naturalSize.width) * displaySize.width,
        top: (rect.y / naturalSize.height) * displaySize.height,
        width: isVerticalLine
          ? Math.max(2, (rect.width / naturalSize.width) * displaySize.width)
          : (rect.width / naturalSize.width) * displaySize.width,
        height: isVerticalLine
          ? (rect.height / naturalSize.height) * displaySize.height
          : Math.max(2, (rect.height / naturalSize.height) * displaySize.height),
      };
    },
    [displaySize, naturalSize]
  );

  const updateOptions = useCallback(
    (patch: Partial<Record<'rows' | 'cols' | 'lineThicknessPercent', number>>) => {
      const nextRows = clampInteger(
        patch.rows ?? rows,
        MIN_GRID_SIZE,
        MAX_GRID_SIZE
      );
      const nextCols = clampInteger(
        patch.cols ?? cols,
        MIN_GRID_SIZE,
        MAX_GRID_SIZE
      );

      const unresolvedLineThicknessPercent = Math.max(
        0,
        patch.lineThicknessPercent ?? lineThicknessPercent
      );

      const nextMaxLineThicknessPercent = naturalSize
        ? clampDecimal(
            (resolveMaxLineThicknessPx(nextRows, nextCols, naturalSize.width, naturalSize.height) /
              Math.max(1, Math.min(naturalSize.width, naturalSize.height))) *
              100,
            0,
            MAX_LINE_THICKNESS_PERCENT
          )
        : MAX_LINE_THICKNESS_PERCENT;

      const nextLineThicknessPercent = clampDecimal(
        unresolvedLineThicknessPercent,
        0,
        nextMaxLineThicknessPercent
      );

      onOptionsChange({
        ...options,
        rows: nextRows,
        cols: nextCols,
        lineThicknessPercent: nextLineThicknessPercent,
      });
    },
    [cols, lineThicknessPercent, naturalSize, onOptionsChange, options, rows]
  );

  const hasLayoutError = Boolean(naturalSize && !layout);

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-h-0">
        <div
          className="relative flex h-full min-h-[420px] items-center justify-center overflow-hidden rounded-[10px] border border-white/[0.10] bg-[#111214]/80 p-3"
        >
          <div ref={previewAreaRef} className="relative flex h-full w-full items-center justify-center">
            <div
              className="relative"
              style={displaySize ? { width: displaySize.width, height: displaySize.height } : undefined}
            >
              <img
                ref={imageRef}
                src={displaySourceImageUrl}
                alt="split-preview"
                className={
                  displaySize
                    ? 'block h-full w-full rounded-lg border border-[rgba(255,255,255,0.08)] object-contain'
                    : 'block max-h-full max-w-full rounded-lg border border-[rgba(255,255,255,0.08)] object-contain'
                }
                onLoad={(event) => {
                  const target = event.currentTarget;
                  setNaturalSize({
                    width: Math.max(1, target.naturalWidth),
                    height: Math.max(1, target.naturalHeight),
                  });
                }}
              />

              {naturalSize && layout && displaySize && (
                <div
                  className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg"
                  style={{
                    width: displaySize.width,
                    height: displaySize.height,
                  }}
                >
                  {layout.lineRects.map((rect, index) => (
                    <div
                      key={`line-${index}`}
                      className="absolute bg-red-400/70"
                      style={toLineStyle(rect)}
                    />
                  ))}

                  {layout.cellRects.map((cell, index) => (
                    <div
                      key={`cell-${index}`}
                      className="absolute border border-white/55"
                      style={toCellStyle(cell)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="h-full space-y-4 rounded-[10px] border border-white/[0.10] bg-[#111214]/72 p-3.5">
        <div className="text-sm font-medium text-text-dark">{t('canvas.splitEditor.params')}</div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <NumberStepper
            label={t('canvas.splitEditor.rows')}
            value={rows}
            min={MIN_GRID_SIZE}
            max={MAX_GRID_SIZE}
            onChange={(value) => updateOptions({ rows: value })}
          />
          <NumberStepper
            label={t('canvas.splitEditor.cols')}
            value={cols}
            min={MIN_GRID_SIZE}
            max={MAX_GRID_SIZE}
            onChange={(value) => updateOptions({ cols: value })}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>{t('canvas.splitEditor.lineThickness')}</span>
            <span>
              {formatPercent(lineThicknessPercent)}
              {naturalSize ? ` (${lineThicknessPx}px)` : ''}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, maxLineThicknessPercent)}
            step={0.1}
            value={lineThicknessPercent}
            onChange={(event) => updateOptions({ lineThicknessPercent: Number(event.target.value) })}
            className={SPLIT_RANGE_CLASS}
            style={{
              background: `linear-gradient(to right, #5b8cff 0%, #5b8cff ${
                maxLineThicknessPercent > 0
                  ? (lineThicknessPercent / maxLineThicknessPercent) * 100
                  : 0
              }%, rgba(255,255,255,0.28) ${
                maxLineThicknessPercent > 0
                  ? (lineThicknessPercent / maxLineThicknessPercent) * 100
                  : 0
              }%, rgba(255,255,255,0.28) 100%)`,
            }}
          />
          <UiInput
            type="number"
            value={lineThicknessPercent}
            min={0}
            max={Math.max(0, maxLineThicknessPercent)}
            step={0.1}
            onChange={(event) => updateOptions({ lineThicknessPercent: Number(event.target.value) })}
            className="h-8 rounded-[8px] border-white/[0.10] bg-bg-dark/42"
          />
        </div>

        <div className="rounded-[8px] border border-white/[0.10] bg-bg-dark/42 px-3 py-2 text-xs text-text-muted">
          <div className="flex items-center justify-between">
            <span>{t('canvas.splitEditor.cellCount')}</span>
            <span className="font-medium text-text-dark">{rows * cols}</span>
          </div>
          {layout && (
            <>
              <div className="mt-1 flex items-center justify-between">
                <span>{t('canvas.splitEditor.cellWidth')}</span>
                <span>{splitSizeLabel(layout.minCellWidth, layout.maxCellWidth)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span>{t('canvas.splitEditor.cellHeight')}</span>
                <span>{splitSizeLabel(layout.minCellHeight, layout.maxCellHeight)}</span>
              </div>
            </>
          )}
        </div>

        {hasLayoutError && (
          <div className="rounded-[8px] border border-red-400/35 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {t('canvas.splitEditor.layoutError')}
          </div>
        )}
      </div>
    </div>
  );
}
