// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  agentSceneDigest,
  applyAgentSceneEdit,
  type PrevizAgentEditResult,
  type PrevizAgentSceneDigest,
} from './domain/agentEdit';
import { createDefaultScene, type PrevizScene } from './domain/scene';
import { buildNodeScenePatch, loadNodeScene } from './nodeScene';

let sceneReader: ((nodeId: string) => PrevizScene | undefined) | undefined;

/** The browser supplies an open editor's unsaved scene. */
export function setNodeAgentSceneReader(reader: NonNullable<typeof sceneReader>): void {
  sceneReader = reader;
}

type SceneRead = { ok: true; scene: PrevizScene } | { ok: false; error: string };

function readCurrentScene(nodeId: string, nodeData: Record<string, unknown>): SceneRead {
  const editingScene = sceneReader?.(nodeId);
  if (editingScene) return { ok: true, scene: editingScene };
  if (nodeData.scene == null) return { ok: true, scene: createDefaultScene() };
  const loaded = loadNodeScene(nodeData.scene);
  if (!loaded.ok) return { ok: false, error: 'scene was saved by a newer version and cannot be edited here' };
  return { ok: true, scene: loaded.scene };
}

/** Newer scene versions cannot be read by this editor. */
export function nodeAgentSceneDigest(
  nodeId: string,
  nodeData: Record<string, unknown>,
): PrevizAgentSceneDigest | null {
  const current = readCurrentScene(nodeId, nodeData);
  return current.ok ? agentSceneDigest(current.scene) : null;
}

/** Validate sequential edits against the previously planned scene. */
export function planNodeAgentSceneEdit(
  nodeId: string,
  nodeData: Record<string, unknown>,
  edit: unknown,
  planned?: PrevizScene,
): PrevizAgentEditResult {
  const current: SceneRead = planned ? { ok: true, scene: planned } : readCurrentScene(nodeId, nodeData);
  if (!current.ok) return current;
  const result = applyAgentSceneEdit(current.scene, edit);
  if (result.ok && !buildNodeScenePatch(result.scene).ok) {
    return { ok: false, error: 'scene would become too large to save' };
  }
  return result;
}

