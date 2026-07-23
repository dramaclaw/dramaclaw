// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 蒙版导出（供视觉模型识别）：源图 + 涂抹区半透明红色高亮。
// 后端把它当作 Image 2 的编辑参考——红色只是标注区域用，模型不会把红色画进结果。
// 旧做法是「白底 + 透明孔洞」，编辑区只存在于 alpha 通道，模型 RGB 里看是整张纯白 → 定位失败。
//
// EraseOverlay / RedrawOverlay / MaskEditor 三个蒙版生产者共用这里，保证导出格式一致，
// 后端只需维护单一契约（红色高亮）。

/** 涂抹区归一后的固定颜色：均匀半透明红 rgba(255,0,0,0.6)。0.6 × 255 ≈ 153。 */
export const MASK_HIGHLIGHT_RGBA = { r: 255, g: 0, b: 0, a: 153 } as const;

/**
 * 低于此 alpha 的像素视为「未涂抹」。与 hasMask 检测保持一致（> 8 = 涂过）。
 * 笔刷本身以 alpha≈140（0.55）绘制，抗锯齿边缘从 0 爬升，这里把整个笔迹足印算作涂抹区。
 */
export const MASK_ALPHA_THRESHOLD = 8;

/**
 * 就地二值化一段 straight-alpha RGBA 缓冲：涂抹区 → 均匀半透明红，其余 → 全透明。
 *
 * 为什么必须二值化：笔刷以 alpha 0.55 叠加绘制，段接头/重叠处 alpha 爬到 ~0.80，
 * mask 通道本身深浅不均。若直接 `source-in` 一个 rgba(255,0,0,0.6)，Porter-Duff
 * "in" 会让输出 alpha = 0.6 × mask_alpha（单笔 0.33 / 叠加 0.48），不均匀原样保留。
 * 先把 mask alpha 拍平成 0/1，再写固定红，才能得到真正均匀的高亮。
 *
 * 纯函数（不碰 canvas），便于单测。
 */
export function binarizeMaskToRed(
  data: Uint8ClampedArray,
  alphaThreshold: number = MASK_ALPHA_THRESHOLD,
): void {
  const { r, g, b, a } = MASK_HIGHLIGHT_RGBA;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > alphaThreshold) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    } else {
      data[i + 3] = 0;
    }
  }
}

/**
 * 由源图 + 蒙版画布合成红色高亮蒙版 PNG。
 *
 * @param baseImage 已加载的源图（HTMLImageElement 或已绘制源图的 canvas）
 * @param maskCanvas 用户涂抹的蒙版画布（涂抹区为半透明红，尺寸即输出尺寸）
 */
export async function buildRedHighlightMaskBlob(
  baseImage: CanvasImageSource,
  maskCanvas: HTMLCanvasElement,
): Promise<Blob> {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('ctx');
  // 1) 源图打底 —— 给视觉模型真实 RGB 内容。
  ctx.drawImage(baseImage, 0, 0, w, h);
  // 2) 把涂抹区二值化成均匀半透明红，叠到源图上。
  //    只对 mask 画布做 getImageData（本地绘制、不会 taint），源图仍走 drawImage/toBlob，
  //    CORS 行为与旧代码一致。
  const overlay = document.createElement('canvas');
  overlay.width = w;
  overlay.height = h;
  const octx = overlay.getContext('2d');
  if (!octx) throw new Error('ctx');
  octx.drawImage(maskCanvas, 0, 0);
  const img = octx.getImageData(0, 0, w, h);
  binarizeMaskToRed(img.data);
  octx.putImageData(img, 0, 0);
  ctx.drawImage(overlay, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    out.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
      'image/png',
    );
  });
}
