// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export const PIKO_WORLD_OVERLAY_TRANSITION_CLASS =
  "transition-[opacity,translate,scale] duration-[var(--duration-slow)] ease-[var(--ease-out-quint)] motion-reduce:transition-none";

export function pikoWorldOverlayVisibilityClass(open: boolean): string {
  return open
    ? "-translate-x-1.25 -translate-y-1.75 scale-100 opacity-100"
    : "pointer-events-none -translate-x-3.25 -translate-y-3.75 scale-[0.98] opacity-0";
}
