// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export function calculateTimelineContextDelta({
  viewportHeight,
  nodeCenter,
  scrollTop,
  scrollHeight,
}: {
  viewportHeight: number;
  nodeCenter: number;
  scrollTop: number;
  scrollHeight: number;
}) {
  const edgeInset = Math.min(96, Math.max(48, viewportHeight * 0.22));
  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  if (scrollTop > 1 && nodeCenter < edgeInset) return nodeCenter - edgeInset;
  if (scrollTop < maxScrollTop - 1 && nodeCenter > viewportHeight - edgeInset) {
    return nodeCenter - (viewportHeight - edgeInset);
  }
  return 0;
}
