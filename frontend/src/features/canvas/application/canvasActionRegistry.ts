// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';

/**
 * 画布动作的稳定身份与副作用声明。
 *
 * 这里刻意不放 React 回调：工具条、右键菜单和未来 Agent 都可以读取同一份能力事实，
 * 具体执行仍由应用层 command 负责。先把事实从巨型工具条里抽出来，再逐项迁移旧动作。
 */
export type CanvasActionEffect = 'preview' | 'spawn' | 'mutate' | 'paid-job';

export interface CanvasActionDescriptor {
  id: string;
  sourceTypes: readonly CanvasNodeType[];
  effect: CanvasActionEffect;
  capability?: string;
  labelKey: string;
}

export interface CanvasActionContext {
  nodeType: CanvasNodeType;
  hasMedia: boolean;
  mediaIsLocal: boolean;
  busy?: boolean;
}

export type CanvasActionAvailability =
  | { available: true }
  | { available: false; reason: 'wrong-node-type' | 'missing-media' | 'remote-media' | 'busy' };

export const CANVAS_ACTION_IDS = {
  audioTrim: 'audio.trim',
  audioSpeed: 'audio.speed',
} as const;

const ACTIONS: readonly CanvasActionDescriptor[] = [
  {
    id: CANVAS_ACTION_IDS.audioTrim,
    sourceTypes: [CANVAS_NODE_TYPES.audio],
    effect: 'spawn',
    capability: 'local.audio.transform',
    labelKey: 'nodeToolbar.audio.trim',
  },
  {
    id: CANVAS_ACTION_IDS.audioSpeed,
    sourceTypes: [CANVAS_NODE_TYPES.audio],
    effect: 'spawn',
    capability: 'local.audio.transform',
    labelKey: 'nodeToolbar.audio.speed',
  },
] as const;

const ACTION_BY_ID = new Map(ACTIONS.map((action) => [action.id, action]));

export function getCanvasActionDescriptor(id: string): CanvasActionDescriptor | null {
  return ACTION_BY_ID.get(id) ?? null;
}

export function canvasActionsForNode(nodeType: CanvasNodeType): readonly CanvasActionDescriptor[] {
  return ACTIONS.filter((action) => action.sourceTypes.includes(nodeType));
}

export function resolveCanvasActionAvailability(
  action: CanvasActionDescriptor,
  context: CanvasActionContext,
): CanvasActionAvailability {
  if (!action.sourceTypes.includes(context.nodeType)) {
    return { available: false, reason: 'wrong-node-type' };
  }
  if (!context.hasMedia) return { available: false, reason: 'missing-media' };
  if (!context.mediaIsLocal) return { available: false, reason: 'remote-media' };
  if (context.busy) return { available: false, reason: 'busy' };
  return { available: true };
}
