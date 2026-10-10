// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from "react";

/**
 * 顶栏菜单切页时的 loading 门闸。
 *
 * 换页在这里是一次**同步**的重渲染：tanstack router 的状态全走
 * useSyncExternalStore，React 会把 startTransition 里的更新降级成同步 flush，
 * 于是从「点下按钮」到「新页面 commit」是一个不可打断的长任务 —— 中间浏览器
 * 一帧都画不出来。所以光挂一个 `isLoading` 遮罩是没用的：它和新页面在同一个
 * commit 里出现又消失，用户看到的仍然是画面卡死一下然后突然换页。
 *
 * 这里的做法是主动把长任务切开：先只更新遮罩，等浏览器真的把它画上屏，再开始
 * 跳转。代价是多等两帧（约 30ms，感知不到），换来的是「点击 → loading → 新
 * 页面」而不是一帧卡顿。遮罩的淡入和转圈都只动 opacity / transform，跳转把主
 * 线程堵死的那几百毫秒里由合成器接着放，所以 loading 本身不会跟着卡住。
 *
 * 快速切换不会闪：遮罩的淡入带 150ms 延迟（见 routes/_app.tsx），页面在这之前
 * 就换好了的话，它从头到尾都是全透明的。
 */
type Phase = "idle" | "armed" | "navigating";

/** 跳转迟迟不落地时的兜底时长 —— 宁可遮罩早退，也不能把界面永远糊住。 */
const SAFETY_TIMEOUT_MS = 5000;

let phase: Phase = "idle";
const listeners = new Set<() => void>();
let firstFrame = 0;
let secondFrame = 0;
let safetyTimer = 0;

function setPhase(next: Phase): void {
  if (phase === next) return;
  phase = next;
  for (const listener of listeners) listener();
}

function clearScheduled(): void {
  if (firstFrame) {
    window.cancelAnimationFrame(firstFrame);
    firstFrame = 0;
  }
  if (secondFrame) {
    window.cancelAnimationFrame(secondFrame);
    secondFrame = 0;
  }
  if (safetyTimer) {
    window.clearTimeout(safetyTimer);
    safetyTimer = 0;
  }
}

/**
 * 先亮 loading，再跳转。`navigate` 里放实际的 router 跳转调用。
 *
 * 只该用在会换掉整页内容的导航上（顶栏「虾画 / 虾集」、虾集子页菜单）。改
 * search 参数这类原地更新别用，白等两帧还要闪一下遮罩。
 */
export function beginRouteSwitch(navigate: () => void): void {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    navigate();
    return;
  }
  clearScheduled();
  setPhase("armed");
  firstFrame = window.requestAnimationFrame(() => {
    firstFrame = 0;
    // 两层 rAF 不是保险起见：第一层的回调跑在「这一帧画出来之前」，遮罩虽然
    // 已经进了 DOM 却还没上屏，这时候跳转等于白铺垫。第二层才能确定它画过了、
    // 合成器也拿到了这一层。
    secondFrame = window.requestAnimationFrame(() => {
      secondFrame = 0;
      setPhase("navigating");
      safetyTimer = window.setTimeout(endRouteSwitch, SAFETY_TIMEOUT_MS);
      navigate();
    });
  });
}

/**
 * 新页面已经渲染出来（或跳转失败），撤掉遮罩。
 *
 * 只处理已经发车的那一次（`navigating`）。`armed` 说明有更新的一次点击正等着
 * 发车：调用方是「路由落地」这个事件，而上一次跳转落地的瞬间，用户完全可能刚
 * 点下第二个菜单还在那两帧等待里 —— 这时候把 rAF 取消掉，等于把他刚点的那下
 * 悄悄吞了，人停在上一页且没有任何反馈。
 */
export function endRouteSwitch(): void {
  if (phase !== "navigating") return;
  clearScheduled();
  setPhase("idle");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Phase {
  return phase;
}

/** 遮罩是否该显示。 */
export function useRouteSwitchPending(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) !== "idle";
}
