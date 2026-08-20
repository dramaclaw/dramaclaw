// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from 'react';

/**
 * 当前设备像素比，跨屏拖窗口时会跟着变。
 *
 * 只读一次 window.devicePixelRatio 是不够的：把窗口从内置 Retina 屏拖到外接 1x
 * 显示器（或反过来）不会重新挂载任何组件，而这个数正是「一格要多少像素」的乘数
 * ——读错的后果是整块画布要么一直糊，要么一直多解一倍的码。
 *
 * 没有 resize 之外的事件可听，标准做法是拿当前值造一条 (resolution: Ndppx) 的
 * media query：值一变这条查询就不再匹配，change 触发，再按新值重新架一条。
 */
const listeners = new Set<() => void>();
let watched: MediaQueryList | null = null;

function currentRatio(): number {
  if (typeof window === 'undefined') return 1;
  const value = window.devicePixelRatio;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function handleChange(): void {
  watch();
  for (const listener of listeners) listener();
}

function watch(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  watched?.removeEventListener('change', handleChange);
  watched = window.matchMedia(`(resolution: ${currentRatio()}dppx)`);
  watched.addEventListener('change', handleChange);
}

function unwatch(): void {
  watched?.removeEventListener('change', handleChange);
  watched = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) watch();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) unwatch();
  };
}

export function useDevicePixelRatio(): number {
  // 服务端快照固定 1：那边没有屏幕，且这个值只影响挑哪一档副本。
  return useSyncExternalStore(subscribe, currentRatio, () => 1);
}
