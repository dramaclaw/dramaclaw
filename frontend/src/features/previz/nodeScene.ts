// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { classifySceneSize, estimateSceneBytes } from './domain/limits';
import {
  PrevizSceneVersionError,
  parseScene,
  type PrevizNodeSummary,
  type PrevizScene,
} from './domain/scene';

export type NodeSceneLoad =
  | { ok: true; scene: PrevizScene }
  | { ok: false; reason: 'version'; schemaVersion: number };

/** 读 node.data.scene。版本过新是可展示的失败，不是异常，所以在这里收成返回值。 */
export function loadNodeScene(raw: unknown): NodeSceneLoad {
  try {
    return { ok: true, scene: parseScene(raw) };
  } catch (error) {
    if (error instanceof PrevizSceneVersionError) {
      return { ok: false, reason: 'version', schemaVersion: error.schemaVersion };
    }
    throw error;
  }
}

export type NodeScenePatch = { scene: PrevizScene; summary: PrevizNodeSummary };

export type NodeSceneFlush =
  | { ok: true; patch: NodeScenePatch }
  | { ok: false; reason: 'too-large'; bytes: number };

/**
 * 生成写回 node.data 的补丁。超出转存阈值时**不**返回补丁——P0 还没有场景转存
 * 管线（随 P2 的上传一起落地），这里唯一正确的行为是拒绝写入并让 UI 提示，
 * 绝不能把超限载荷放进整画布保存。
 */
export function buildNodeScenePatch(scene: PrevizScene): NodeSceneFlush {
  const bytes = estimateSceneBytes(scene);
  if (classifySceneSize(bytes) === 'offload') {
    return { ok: false, reason: 'too-large', bytes };
  }
  return {
    ok: true,
    patch: {
      scene,
      summary: { objectCount: scene.objects.length, durationFrames: scene.settings.durationFrames },
    },
  };
}
