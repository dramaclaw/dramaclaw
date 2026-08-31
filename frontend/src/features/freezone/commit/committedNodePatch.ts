// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PushResult, PushTarget } from "@/api/push";
import type { TFn } from "@/lib/i18n-types";
import {
  isDirectorWorldSourceSlotTarget,
  nodeDataAfterDirectorWorldSourceSlotCommit,
} from "./sceneDirectorWorldCommit";

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sourceFilename(result: Pick<PushResult, "target_path" | "target_url">): string {
  const raw = stringValue(result.target_path) || stringValue(result.target_url);
  const clean = raw.split("#", 1)[0]?.split("?", 1)[0] ?? raw;
  return clean.split("/").filter(Boolean).pop() || raw;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function projectIdFromNodeData(
  nodeData: Record<string, unknown>,
  projectId?: string,
): string {
  const explicit = stringValue(projectId);
  if (explicit) return explicit;
  const contexts = Array.isArray(nodeData.mainline_context)
    ? nodeData.mainline_context
    : [];
  for (const context of contexts) {
    const record = recordValue(context);
    const value = stringValue(record?.projectId);
    if (value) return value;
  }
  const source = recordValue(nodeData.__freezone_source);
  const meta = recordValue(source?.meta);
  return (
    stringValue(source?.projectId) ||
    stringValue(meta?.projectId) ||
    stringValue(meta?.project_id)
  );
}

function mediaPatchForTarget(
  target: PushTarget,
  targetUrl: string,
): Record<string, unknown> {
  if (target.kind === "video") {
    return { videoUrl: targetUrl, previewImageUrl: targetUrl };
  }
  if (target.kind === "beat_audio") {
    return { audioUrl: targetUrl, url: targetUrl };
  }
  if (
    target.kind === "scene_3gs_master_ply" ||
    target.kind === "scene_3gs_reverse_ply" ||
    target.kind === "scene_3gs_pano_ply" ||
    target.kind === "scene_3gs_custom_scene"
  ) {
    return { fileUrl: targetUrl, modelUrl: targetUrl, plyUrl: targetUrl, url: targetUrl };
  }
  if (target.kind === "scene_director_pano_360") {
    return { imageUrl: targetUrl, previewImageUrl: targetUrl, panoUrl: targetUrl, url: targetUrl };
  }
  return { imageUrl: targetUrl, previewImageUrl: targetUrl };
}

function targetScopeMeta(target: PushTarget): Record<string, unknown> {
  if (
    target.kind === "frame" ||
    target.kind === "sketch" ||
    target.kind === "director_render" ||
    target.kind === "selected_background" ||
    target.kind === "video" ||
    target.kind === "beat_audio"
  ) {
    return { episode: target.episode, beat: target.beat };
  }
  if (
    target.kind === "identity" ||
    target.kind === "identity_costume" ||
    target.kind === "identity_portrait"
  ) {
    return { character: target.character, identity_id: target.identity_id };
  }
  if (target.kind === "portrait") {
    return { character: target.character };
  }
  if (
    target.kind === "scene_master" ||
    target.kind === "scene_reverse_master" ||
    target.kind === "scene_spatial_layout" ||
    target.kind === "scene_director_pano_360" ||
    target.kind === "scene_3gs_master_ply" ||
    target.kind === "scene_3gs_reverse_ply" ||
    target.kind === "scene_3gs_pano_ply" ||
    target.kind === "scene_3gs_custom_scene"
  ) {
    return { scene_id: target.scene_id, scene: target.scene_id };
  }
  if (target.kind === "prop_ref") {
    return { prop_id: target.prop_id, prop: target.prop_id };
  }
  return {};
}

/**
 * 提交后写回节点的标题。文案跟着界面语言走，槽位后缀查词条；
 * EP/Beat、角色名、scene_id 这些是业务标识，原样拼。
 */
function targetLabel(target: PushTarget, t: TFn): string {
  const suffix = t(`freezone.commit.nodeLabels.${target.kind}`, { defaultValue: "" });
  if (!suffix) return target.kind;
  if (
    target.kind === "frame" ||
    target.kind === "sketch" ||
    target.kind === "director_render" ||
    target.kind === "selected_background" ||
    target.kind === "video" ||
    target.kind === "beat_audio"
  ) {
    return `EP${target.episode} / Beat ${target.beat} / ${suffix}`;
  }
  if (
    target.kind === "identity" ||
    target.kind === "identity_costume" ||
    target.kind === "identity_portrait"
  ) {
    return `${target.character} / ${target.identity_id} / ${suffix}`;
  }
  if (target.kind === "portrait") return `${target.character} / ${suffix}`;
  if (target.kind === "prop_ref") return `${target.prop_id} / ${suffix}`;
  return `${(target as unknown as Record<string, unknown>).scene_id} / ${suffix}`;
}

function contextForTarget(
  target: PushTarget,
  projectId: string,
  targetUrl: string,
  label: string,
): Record<string, unknown> | null {
  if (!projectId) return null;
  if (
    target.kind === "frame" ||
    target.kind === "sketch" ||
    target.kind === "video" ||
    target.kind === "selected_background"
  ) {
    return {
      kind: target.kind,
      projectId,
      episode: target.episode,
      beat: target.beat,
      role: target.kind,
      label,
      sourceUrl: targetUrl,
    };
  }
  if (target.kind === "director_render") {
    return {
      kind: "director_combined",
      projectId,
      episode: target.episode,
      beat: target.beat,
      role: target.kind,
      label,
      sourceUrl: targetUrl,
    };
  }
  if (target.kind === "beat_audio") {
    return {
      kind: "audio",
      projectId,
      episode: target.episode,
      beat: target.beat,
      audioRole: "beat_audio",
      role: target.kind,
      label,
      sourceUrl: targetUrl,
    };
  }
  if (
    target.kind === "identity" ||
    target.kind === "identity_costume" ||
    target.kind === "identity_portrait"
  ) {
    return {
      kind: "identity",
      projectId,
      character: target.character,
      identityId: target.identity_id,
      role: target.kind,
      label,
      sourceUrl: targetUrl,
    };
  }
  if (target.kind === "portrait") {
    return {
      kind: "identity",
      projectId,
      character: target.character,
      role: target.kind,
      label,
      sourceUrl: targetUrl,
    };
  }
  if (
    target.kind === "scene_master" ||
    target.kind === "scene_reverse_master" ||
    target.kind === "scene_spatial_layout" ||
    target.kind === "scene_director_pano_360" ||
    target.kind === "scene_3gs_master_ply" ||
    target.kind === "scene_3gs_reverse_ply" ||
    target.kind === "scene_3gs_pano_ply" ||
    target.kind === "scene_3gs_custom_scene"
  ) {
    return {
      kind: "scene",
      projectId,
      sceneId: target.scene_id,
      role: target.kind,
      label,
      sourceUrl: targetUrl,
    };
  }
  if (target.kind === "prop_ref") {
    return {
      kind: "prop",
      projectId,
      propId: target.prop_id,
      role: target.kind,
      label,
      sourceUrl: targetUrl,
    };
  }
  return null;
}

export function nodeDataAfterCommittedSlot(
  nodeData: Record<string, unknown>,
  target: PushTarget,
  result: Pick<PushResult, "target_path" | "target_url">,
  projectId: string | undefined,
  t: TFn,
): Record<string, unknown> | null {
  if (target.kind === "scene_director_world") return null;
  if (isDirectorWorldSourceSlotTarget(target)) {
    return nodeDataAfterDirectorWorldSourceSlotCommit(nodeData, target, result, t, projectId);
  }
  const targetUrl = stringValue(result.target_url);
  if (!targetUrl) return null;
  const label = targetLabel(target, t);
  const isCandidate = nodeData.user_spawned === true;
  const effectiveProjectId = projectIdFromNodeData(nodeData, projectId);
  const context = contextForTarget(target, effectiveProjectId, targetUrl, label);
  const previousSource = recordValue(nodeData.__freezone_source);
  const previousMeta = recordValue(previousSource?.meta);
  const nextMeta = {
    ...previousMeta,
    ...targetScopeMeta(target),
  };

  return {
    ...nodeData,
    ...mediaPatchForTarget(target, targetUrl),
    displayName: isCandidate ? t("freezone.commit.committedNodeLabel", { label }) : label,
    sourceFileName: sourceFilename(result),
    slot_target: target,
    committed_slot_url: targetUrl,
    committed_target_label: label,
    ...(isCandidate
      ? {
          mainline_context: undefined,
          __freezone_source: previousSource ?? nodeData.__freezone_source,
        }
      : {
          __freezone_source: {
            ...previousSource,
            kind: target.kind,
            role: target.kind,
            label,
            meta: nextMeta,
            url: targetUrl,
            slot_target: target,
            pushable: true,
          },
          ...(context ? { mainline_context: [context] } : {}),
        }),
  };
}
