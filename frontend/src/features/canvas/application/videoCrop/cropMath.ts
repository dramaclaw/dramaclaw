// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 画面裁切的几何计算。框一律用「源视频显示像素」的浮点坐标，只有交给编码器或
// 显示尺寸标签时才取偶数整像素（H.264 要求宽高为偶数）。

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 与 mediabunny 的 CropRectangle 同形，可以直接交给 Conversion。 */
export interface CropPixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const CROP_RATIO_PRESETS = ["free", "original", "1:1", "9:16", "16:9", "4:3", "3:4"] as const;
export type CropRatioId = (typeof CROP_RATIO_PRESETS)[number];

export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const CROP_ALL_HANDLES: readonly CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const CROP_CORNER_HANDLES: readonly CropHandle[] = ["nw", "ne", "se", "sw"];

export const CROP_MIN_SIZE = 64;
/** 浮点误差兜底：576 算成 575.9999999 时不能被 floor 成 574。 */
const EVEN_EPSILON = 1e-6;

/** max < min（比如源边长小于拖拽最小尺寸）时退化成返回 min，不产出负坐标。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 宽/高；「自由」返回 null 表示不锁比例。 */
export function resolveCropRatio(id: CropRatioId, sourceWidth: number, sourceHeight: number): number | null {
  if (id === "free") return null;
  if (id === "original") return sourceHeight > 0 ? sourceWidth / sourceHeight : null;
  const [width, height] = id.split(":").map(Number);
  return width / height;
}

/** object-contain 下画面在容器里的实际矩形（容器像素）。 */
export function containRect(
  containerWidth: number,
  containerHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): DisplayRect {
  if (containerWidth <= 0 || containerHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(containerWidth / sourceWidth, containerHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { left: (containerWidth - width) / 2, top: (containerHeight - height) / 2, width, height };
}

/**
 * 原始比例、宽高各 80%、居中。用 ×4/5 而不是 ×0.8，整数源尺寸能算得精确。
 * 源边长小于拖拽最小尺寸（CROP_MIN_SIZE）时，80% 会比 min(CROP_MIN_SIZE, source) 还小，
 * 这样初始框会小于自由拖拽的下限，导致一拖手柄就越界；用 max 兜底撑到拖拽下限。
 */
export function initialCropBox(sourceWidth: number, sourceHeight: number): CropBox {
  const width = Math.max((sourceWidth * 4) / 5, Math.min(CROP_MIN_SIZE, sourceWidth));
  const height = Math.max((sourceHeight * 4) / 5, Math.min(CROP_MIN_SIZE, sourceHeight));
  return { x: (sourceWidth - width) / 2, y: (sourceHeight - height) / 2, width, height };
}

/** 以当前框中心为基准，取画面内能放下的最大 ratio 框，再整体推回画面内。 */
export function fitRatioBox(box: CropBox, ratio: number, sourceWidth: number, sourceHeight: number): CropBox {
  const width = Math.min(sourceWidth, sourceHeight * ratio);
  const height = width / ratio;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return {
    x: clamp(centerX - width / 2, 0, sourceWidth - width),
    y: clamp(centerY - height / 2, 0, sourceHeight - height),
    width,
    height,
  };
}

export function moveCropBox(
  box: CropBox,
  dx: number,
  dy: number,
  sourceWidth: number,
  sourceHeight: number,
): CropBox {
  return {
    ...box,
    x: clamp(box.x + dx, 0, Math.max(0, sourceWidth - box.width)),
    y: clamp(box.y + dy, 0, Math.max(0, sourceHeight - box.height)),
  };
}

/**
 * 拖手柄。`start` 是按下瞬间的框，`dx/dy` 是从按下到现在的累计位移（源像素），
 * 这样多次 pointermove 不会累积误差。
 */
export function dragCropHandle(
  start: CropBox,
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio: number | null,
  sourceWidth: number,
  sourceHeight: number,
): CropBox {
  const minWidth = Math.min(CROP_MIN_SIZE, sourceWidth);
  const minHeight = Math.min(CROP_MIN_SIZE, sourceHeight);
  const movesWest = handle.includes("w");
  const movesEast = handle.includes("e");
  const movesNorth = handle.includes("n");
  const movesSouth = handle.includes("s");

  if (ratio === null) {
    let left = start.x;
    let right = start.x + start.width;
    let top = start.y;
    let bottom = start.y + start.height;
    if (movesWest) left = clamp(left + dx, 0, right - minWidth);
    if (movesEast) right = clamp(right + dx, left + minWidth, sourceWidth);
    if (movesNorth) top = clamp(top + dy, 0, bottom - minHeight);
    if (movesSouth) bottom = clamp(bottom + dy, top + minHeight, sourceHeight);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  // 锁比例只开放四个角；边中点手柄 UI 上不渲染，万一传进来也原样返回。
  if (!(movesWest || movesEast) || !(movesNorth || movesSouth)) return start;

  const anchorX = movesEast ? start.x : start.x + start.width;
  const anchorY = movesSouth ? start.y : start.y + start.height;
  const widthByX = start.width + (movesEast ? dx : -dx);
  const widthByY = (start.height + (movesSouth ? dy : -dy)) * ratio;
  // 哪个轴的相对变化大就听哪个轴，斜着拖也不会抖。
  const followX = Math.abs(dx) / start.width >= Math.abs(dy) / start.height;
  const maxWidth = Math.min(
    movesEast ? sourceWidth - anchorX : anchorX,
    (movesSouth ? sourceHeight - anchorY : anchorY) * ratio,
  );
  const minLockedWidth = Math.min(Math.max(minWidth, minHeight * ratio), maxWidth);
  const width = clamp(followX ? widthByX : widthByY, minLockedWidth, maxWidth);
  const height = width / ratio;
  return {
    x: movesEast ? anchorX : anchorX - width,
    y: movesSouth ? anchorY : anchorY - height,
    width,
    height,
  };
}

/** 编码器与尺寸标签用：宽高向下取偶数，原点四舍五入后夹在画面内。 */
export function toEvenSourceRect(box: CropBox, sourceWidth: number, sourceHeight: number): CropPixelRect {
  const width = Math.max(2, Math.floor(Math.min(box.width, sourceWidth) / 2 + EVEN_EPSILON) * 2);
  const height = Math.max(2, Math.floor(Math.min(box.height, sourceHeight) / 2 + EVEN_EPSILON) * 2);
  return {
    left: clamp(Math.round(box.x), 0, Math.max(0, sourceWidth - width)),
    top: clamp(Math.round(box.y), 0, Math.max(0, sourceHeight - height)),
    width,
    height,
  };
}
