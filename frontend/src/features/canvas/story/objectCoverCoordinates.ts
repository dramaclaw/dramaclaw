export interface MediaSize {
  width: number;
  height: number;
}

export interface MediaPoint {
  x: number;
  y: number;
}

export interface MediaRenderRect extends MediaSize {
  left: number;
  top: number;
}

/** 计算 `object-fit: cover` 后，原始媒体在容器中的实际尺寸与裁切偏移。 */
export function objectCoverRenderRect(
  container: MediaSize,
  media: MediaSize,
): MediaRenderRect | null {
  if (
    container.width <= 0
    || container.height <= 0
    || media.width <= 0
    || media.height <= 0
  ) return null;

  const scale = Math.max(container.width / media.width, container.height / media.height);
  const width = media.width * scale;
  const height = media.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}

/** 将相对于原始视频画幅的 0–1 锚点换算到 cover 容器坐标。 */
export function mediaAnchorToCoverPoint(
  anchor: MediaPoint,
  container: MediaSize,
  media: MediaSize,
): MediaPoint | null {
  const rendered = objectCoverRenderRect(container, media);
  if (!rendered) return null;
  return {
    x: rendered.left + Math.min(1, Math.max(0, anchor.x)) * rendered.width,
    y: rendered.top + Math.min(1, Math.max(0, anchor.y)) * rendered.height,
  };
}

/** 将 cover 容器内的像素坐标反算为原始媒体画幅中的 0–1 坐标。 */
export function coverPointToMediaAnchor(
  point: MediaPoint,
  container: MediaSize,
  media: MediaSize,
): MediaPoint | null {
  const rendered = objectCoverRenderRect(container, media);
  if (!rendered) return null;
  return {
    x: Math.min(1, Math.max(0, (point.x - rendered.left) / rendered.width)),
    y: Math.min(1, Math.max(0, (point.y - rendered.top) / rendered.height)),
  };
}
