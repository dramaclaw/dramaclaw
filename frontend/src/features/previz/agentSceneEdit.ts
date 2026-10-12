// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 把 Agent 的 `sceneEdit` 落到一个预演台节点上。
 *
 * 与白模落地（`blockoutLanding.ts`）同一个分岔：编辑器正开着这个节点时，真相在编辑器的
 * store 里——直接写 `node.data.scene` 会被下一次自动保存原样盖回去，所以要走 store，
 * 顺带得到一步撤销。其余情形从节点数据读、改、写回。
 */
import {
  agentSceneDigest,
  applyAgentSceneEdit,
  type PrevizAgentEditResult,
  type PrevizAgentSceneDigest,
} from './domain/agentEdit';
import { createDefaultScene, type PrevizScene } from './domain/scene';
import { clipById } from './domain/timeline';
import { buildNodeScenePatch, loadNodeScene, type NodeScenePatch } from './nodeScene';
import { usePrevizStore } from './store';

type SceneRead = { ok: true; scene: PrevizScene } | { ok: false; error: string };

function readCurrentScene(nodeId: string, nodeData: Record<string, unknown>): SceneRead {
  const store = usePrevizStore.getState();
  if (store.editingNodeId === nodeId) return { ok: true, scene: store.scene };
  if (nodeData.scene == null) return { ok: true, scene: createDefaultScene() };
  const loaded = loadNodeScene(nodeData.scene);
  if (!loaded.ok) return { ok: false, error: 'scene was saved by a newer version and cannot be edited here' };
  return { ok: true, scene: loaded.scene };
}

/** 给 Agent 读的当前场景；读不了（版本过新）时为 null。 */
export function nodeAgentSceneDigest(
  nodeId: string,
  nodeData: Record<string, unknown>,
): PrevizAgentSceneDigest | null {
  const current = readCurrentScene(nodeId, nodeData);
  return current.ok ? agentSceneDigest(current.scene) : null;
}

/** 只算不写：命令校验用它在用户确认之前就把错误报回给 Agent。 */
export function planNodeAgentSceneEdit(
  nodeId: string,
  nodeData: Record<string, unknown>,
  edit: unknown,
): PrevizAgentEditResult {
  const current = readCurrentScene(nodeId, nodeData);
  if (!current.ok) return current;
  const result = applyAgentSceneEdit(current.scene, edit);
  if (result.ok && !buildNodeScenePatch(result.scene).ok) {
    return { ok: false, error: 'scene would become too large to save' };
  }
  return result;
}

/** 执行编辑并返回要写回节点的补丁；不能执行时抛错，由命令执行器记成这条命令失败。 */
export function landNodeAgentSceneEdit(
  nodeId: string,
  nodeData: Record<string, unknown>,
  edit: unknown,
): NodeScenePatch {
  const result = planNodeAgentSceneEdit(nodeId, nodeData, edit);
  if (!result.ok) throw new Error(result.error);
  const flush = buildNodeScenePatch(result.scene);
  if (!flush.ok) throw new Error('scene would become too large to save');

  const store = usePrevizStore.getState();
  if (store.editingNodeId === nodeId) {
    const removed = new Set(result.removedIds);
    store.applyScene(result.scene);
    usePrevizStore.setState({
      selectedObjectId:
        store.selectedObjectId !== null && removed.has(store.selectedObjectId) ? null : store.selectedObjectId,
      activeCameraId:
        store.activeCameraId !== null && removed.has(store.activeCameraId) ? null : store.activeCameraId,
      // 选中的片段被这次编辑删掉了：属性面板不该继续指着一条不存在的片段。
      selectedClipId:
        store.selectedClipId !== null && !clipById(result.scene, store.selectedClipId) ? null : store.selectedClipId,
    });
    // 时间轴被改短到播放头以内时把播放头拽回来，与 `setDurationFrames` 同一个理由。
    if (store.timelineFrame > result.scene.settings.durationFrames) {
      usePrevizStore.getState().setTimelineFrame(result.scene.settings.durationFrames);
    }
    usePrevizStore.getState().markSaved();
  }
  return flush.patch;
}
