// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from "react";

/**
 * 「画面裁切」在途状态的模块级登记表——不放组件 state 的原因：
 * 1. 节点被 onlyRenderVisibleElements 平移出视口、或换成 LOD shell 时会卸载
 *    重挂，useState 一律归零；裁切请求还没回来，用户对着重挂后的节点能再点
 *    一次提交，裁两份。
 * 2. 工具栏（NodeActionToolbar）切模式时要在写 isCropMode 之前先问一句「这个
 *    节点在裁吗」，它跟节点组件不共享 state，只能读模块级登记表。
 *
 * 每个在途节点绑一个 AbortController，供用户中途取消：cancelVideoCrop 只发
 * 中止信号，不摘登记表——真正摘表是提交流程 finally 里的 clearVideoCropInFlight，
 * 这样「已中止但还没跑到 finally」的这段时间里再问 isVideoCropInFlight 仍然是
 * true，不会让用户以为可以立刻再提交一次。
 */
const inFlight = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 登记失败（这个节点已经在裁）时返回 null，而不是悄悄把已有的 signal 递回去——
 * 调用方一旦把 null 当成「注册成功」用，就会对同一次裁剪抢注册两个消费者，
 * 谁的 finally 先跑谁清表，另一个还在跑的请求就会对着已经清空的登记表收尾。
 * 调用方看到 null 必须直接放弃这次提交。
 */
export function markVideoCropInFlight(nodeId: string): AbortSignal | null {
  if (inFlight.has(nodeId)) return null;
  const controller = new AbortController();
  inFlight.set(nodeId, controller);
  emit();
  return controller.signal;
}

export function cancelVideoCrop(nodeId: string): void {
  inFlight.get(nodeId)?.abort();
}

export function clearVideoCropInFlight(nodeId: string): void {
  if (!inFlight.delete(nodeId)) return;
  emit();
}

export function isVideoCropInFlight(nodeId: string): boolean {
  return inFlight.has(nodeId);
}

export function useVideoCropInFlight(nodeId: string): boolean {
  return useSyncExternalStore(subscribe, () => inFlight.has(nodeId));
}

/**
 * 「一次性抢焦点」的挂号表——只在工具栏主动进入裁剪模式时挂号，浮层看到自己
 * 挂了号才抢一次焦点，抢完立刻摘号。不用「每次挂载都抢」是因为：
 * 1. Radix 下拉菜单关闭时会把焦点收回触发它的按钮，跟浮层的挂载焦点抢一次
 *    还抢不过，得靠下拉那边 onCloseAutoFocus 让路 + 这边真正抢到。
 * 2. 节点被 onlyRenderVisibleElements 卸载重挂时浮层会重新挂载，如果每次挂载
 *    都抢焦点，用户正在别的输入框打字，光标会被这次重挂无声地薅走。
 */
const pendingFocus = new Set<string>();

export function requestVideoCropFocus(nodeId: string): void {
  pendingFocus.add(nodeId);
}

/** 消费一次性挂号；命中就摘号并返回 true，浮层据此决定要不要抢焦点。 */
export function consumeVideoCropFocus(nodeId: string): boolean {
  return pendingFocus.delete(nodeId);
}
