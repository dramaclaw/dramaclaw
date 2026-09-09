// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 贴着某个触发元素弹出的浮层（portal + fixed）的落点计算。
 *
 * 只横向夹取、纵向恒定 `rect.bottom + gap` 是个反复出现的坑：节点操作面板本来就
 * 常年贴在视口下沿，提示词栏上的 chip 离底边只有几十像素，菜单整个落到视口外面，
 * 用户看到的是「点了没反应」。CameraMovementChip 早就自己写过一版上下翻转，这里
 * 把那套策略抽出来，让「＋参考」菜单和 @ 替换选单共用同一个口径。
 *
 * 空间不够时不只翻转，还会把可用高度一并算出来：贴边的那一侧留多少就给多少，浮层
 * 自己内部滚动，而不是硬撑出视口。
 */

/** 浮层至少要露出这么高，否则翻转过去也只是换个地方看不见。 */
const MIN_VISIBLE_HEIGHT = 96;

export interface AnchoredMenuGeometry {
  top: number;
  left: number;
  /** 实际可用高度；浮层应当把它设成 maxHeight 并允许内部滚动。 */
  maxHeight: number;
  /** 最终落在触发元素的下方还是上方。 */
  placement: 'below' | 'above';
}

export interface AnchoredMenuInput {
  /** 触发元素的位置，取 getBoundingClientRect()。 */
  anchorRect: Pick<DOMRect, 'top' | 'bottom' | 'left'>;
  width: number;
  /** 内容撑满时的高度上限。空间够就按它给，不够则收缩。 */
  preferredHeight: number;
  /** 浮层与触发元素之间的间距。 */
  gap?: number;
  /** 浮层与视口边缘之间的最小留白。 */
  edgeGap?: number;
  /** 便于单测注入；缺省读 window。 */
  viewportWidth?: number;
  viewportHeight?: number;
}

export function placeAnchoredMenu({
  anchorRect,
  width,
  preferredHeight,
  gap = 4,
  edgeGap = 8,
  viewportWidth,
  viewportHeight,
}: AnchoredMenuInput): AnchoredMenuGeometry {
  const vw = viewportWidth ?? window.innerWidth;
  const vh = viewportHeight ?? window.innerHeight;
  const left = Math.max(edgeGap, Math.min(anchorRect.left, vw - width - edgeGap));

  const roomBelow = Math.max(0, vh - anchorRect.bottom - gap - edgeGap);
  const roomAbove = Math.max(0, anchorRect.top - gap - edgeGap);

  // 下方放得下就放下方；放不下时，只有当上方确实更宽裕才翻转——两边都逼仄的时候
  // 来回翻只会让菜单忽上忽下，不如稳定地留在下方。
  if (roomBelow >= preferredHeight || roomBelow >= roomAbove) {
    const maxHeight = Math.max(MIN_VISIBLE_HEIGHT, Math.min(preferredHeight, roomBelow));
    // 两边都不够时（极窄视口）宁可盖住触发元素，也不能整个掉到视口外。
    const top = Math.max(edgeGap, Math.min(anchorRect.bottom + gap, vh - edgeGap - maxHeight));
    return { top, left, maxHeight, placement: 'below' };
  }

  const maxHeight = Math.max(MIN_VISIBLE_HEIGHT, Math.min(preferredHeight, roomAbove));
  const top = Math.max(edgeGap, anchorRect.top - gap - maxHeight);
  return { top, left, maxHeight, placement: 'above' };
}
