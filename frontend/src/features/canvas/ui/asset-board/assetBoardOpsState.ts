// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from 'react';

/** 一次操作失败时，源节点工具条上红色错误文案的自动消失时长（ms）。 */
export const OP_FAILURE_AUTO_DISMISS_MS = 8000;

export interface AssetBoardOpsRegistry<Op extends string> {
  /** 读某个节点当前进行中的操作（跨组件重挂载存活）。 */
  useInFlightOp: (nodeId: string) => Op | null;
  /** 读某个节点最近一次失败文案（{@link OP_FAILURE_AUTO_DISMISS_MS} 后自动清）。 */
  useOpFailure: (nodeId: string) => string | null;
  markOpStart: (nodeId: string, op: Op) => void;
  markOpSettled: (nodeId: string) => void;
  reportOpFailure: (nodeId: string, message: string) => void;
  /** 供测试断言的只读视图（nodeId → 进行中的操作名）。 */
  inFlight: ReadonlyMap<string, Op>;
  /** 仅供测试：清空两张登记表，避免用例间靠固定 node id 串态。 */
  resetForTest: () => void;
}

/**
 * 故事板详情工具条的「进行中 / 失败反馈」登记表工厂。
 *
 * 为什么是模块级 Map 而不是组件 state：详情工具条按 `key={node.id}` 整体重挂载
 * （切到别的节点再切回来时是全新实例），若 busy 态只放组件局部 state，切走再
 * 切回会把它重置为 null —— 用户能在后台任务还没 settle 时对同一节点再提交一次，
 * 造成重复计费。做法同 nodes/shared/albumPendingTotals.ts 的叠卡画册计数：
 * 模块级 Map + useSyncExternalStore，跨组件卸载/重挂存活；不持久化到
 * localStorage——刷新页面本来就不会给任务续传，留着只会显示永远转圈的假 busy 态。
 *
 * 失败反馈同理：生成类操作的失败信息目前只写到新建的**结果节点**
 * data.generationError 上，而用户此刻停留在**源节点**的详情面板，看不到那个刚
 * 建出来、大概率还没滚动到视口里的新节点——所以在源节点工具条上补一行红色文案，
 * 到点自动消失。（不用 FreezoneShell 的 setToast / canvasEventBus：两条路径都要
 * 新增 ports.ts 事件类型 + FreezoneShell 订阅者，超出这批改动的文件范围。）
 *
 * 图片侧与视频侧各建一个实例（见 assetBoardImageOpsRegistry /
 * assetBoardVideoOpsRegistry）——一个节点不会同时是图片和视频，分开只是让各自的
 * 测试 reset 不互相牵连。
 */
export function createAssetBoardOpsRegistry<Op extends string>(): AssetBoardOpsRegistry<Op> {
  const inFlightMap = new Map<string, Op>();
  const inFlightListeners = new Set<() => void>();
  const failureMap = new Map<string, string>();
  const failureListeners = new Set<() => void>();

  const emitInFlight = () => {
    for (const listener of inFlightListeners) listener();
  };
  const emitFailure = () => {
    for (const listener of failureListeners) listener();
  };
  const subscribeInFlight = (listener: () => void) => {
    inFlightListeners.add(listener);
    return () => {
      inFlightListeners.delete(listener);
    };
  };
  const subscribeFailure = (listener: () => void) => {
    failureListeners.add(listener);
    return () => {
      failureListeners.delete(listener);
    };
  };

  return {
    useInFlightOp: (nodeId: string) =>
      useSyncExternalStore(subscribeInFlight, () => inFlightMap.get(nodeId) ?? null),
    useOpFailure: (nodeId: string) =>
      useSyncExternalStore(subscribeFailure, () => failureMap.get(nodeId) ?? null),
    markOpStart: (nodeId: string, op: Op) => {
      inFlightMap.set(nodeId, op);
      emitInFlight();
    },
    markOpSettled: (nodeId: string) => {
      if (!inFlightMap.delete(nodeId)) return;
      emitInFlight();
    },
    reportOpFailure: (nodeId: string, message: string) => {
      failureMap.set(nodeId, message);
      emitFailure();
      setTimeout(() => {
        if (failureMap.get(nodeId) === message) {
          failureMap.delete(nodeId);
          emitFailure();
        }
      }, OP_FAILURE_AUTO_DISMISS_MS);
    },
    inFlight: inFlightMap,
    resetForTest: () => {
      inFlightMap.clear();
      failureMap.clear();
      emitInFlight();
      emitFailure();
    },
  };
}
