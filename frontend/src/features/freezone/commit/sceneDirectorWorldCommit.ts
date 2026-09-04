// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PushResult, PushTarget } from "@/api/push";
import {
  clearSceneDirectorWorld,
  getSceneDirectorStageManifest,
  saveSceneDirectorWorld,
  saveSceneDirectorWorldSource,
} from "@/api/viewerManifests";
import { directorSourceIdentityUrl } from "@/features/canvas/domain/directorWorldSources";
import type { ThreeDSceneSnapshot } from "@/features/viewer-kit/three-d/engine/viewerApp";
import type { DirectorWorldSource } from "@/features/viewer-kit/three-d/directorManifest";
import type { TFn } from "@/lib/i18n-types";

type SceneDirectorWorldTarget = Extract<PushTarget, { kind: "scene_director_world" }>;
type DirectorWorldSourceSlotTarget = Extract<PushTarget, {
  kind:
    | "scene_director_pano_360"
    | "scene_3gs_master_ply"
    | "scene_3gs_reverse_ply"
    | "scene_3gs_pano_ply"
    | "scene_3gs_custom_scene";
}>;

interface SceneDirectorWorldCommitOptions {
  pruneStale?: boolean;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasMainlineContext(nodeData: Record<string, unknown>): boolean {
  return Array.isArray(nodeData.mainline_context) && nodeData.mainline_context.some((context) =>
    Boolean(recordValue(context)),
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sceneSnapshot(value: unknown): ThreeDSceneSnapshot | null {
  return recordValue(value) as ThreeDSceneSnapshot | null;
}

export function hasDirectorWorldSceneState(nodeData: Record<string, unknown> | null | undefined): boolean {
  if (!nodeData) return false;
  if (sceneSnapshot(nodeData.scene)) return true;
  const scenesBySourceId = recordValue(nodeData.scenesBySourceId);
  return Object.values(scenesBySourceId ?? {}).some((snapshot) => Boolean(sceneSnapshot(snapshot)));
}

function sourceUrl(source: DirectorWorldSource | undefined): string {
  return stringValue(source?.url) || stringValue(source?.ply_url) || stringValue(source?.pano_url);
}

function isCanonicalDirectorWorldUrl(url: string): boolean {
  return url.includes("/director_worlds/") && !url.includes("/freezone/");
}

function isUncommittedDirectorWorldSource(source: DirectorWorldSource | undefined): boolean {
  if (!source) return false;
  const url = sourceUrl(source);
  return !url || !isCanonicalDirectorWorldUrl(url);
}

function sourceIdFromSnapshot(snapshot: ThreeDSceneSnapshot | null): string {
  return stringValue(snapshot?.world?.activeSourceId);
}

function sourceIdForCommittedSlot(
  target: DirectorWorldSourceSlotTarget,
  targetUrl: string,
): string {
  if (target.kind === "scene_director_pano_360") {
    return `scene-pano:${target.scene_id}`;
  }
  return `legacy:${SOURCE_KIND_BY_SLOT[target.kind]}:sog:${directorSourceIdentityUrl(targetUrl)}`;
}

function canonicalSceneSourceId(sourceId: string): string {
  const trimmed = sourceId.trim();
  if (!trimmed.startsWith("legacy:")) return trimmed;
  const parts = trimmed.split(":");
  if (parts.length < 4) return trimmed;
  const [prefix, sourceKind, sourceType, ...urlParts] = parts;
  const identityUrl = directorSourceIdentityUrl(urlParts.join(":"));
  return `${prefix}:${sourceKind}:${sourceType}:${identityUrl}`;
}

function sourcePatchForCommittedSlot(
  target: DirectorWorldSourceSlotTarget,
  targetUrl: string,
  sourceId: string,
  t: TFn,
): DirectorWorldSource {
  const sourceType: DirectorWorldSource["source_type"] =
    target.kind === "scene_director_pano_360" ? "pano360" : "sog";
  return {
    id: sourceId,
    source_type: sourceType,
    source_kind: SOURCE_KIND_BY_SLOT[target.kind],
    label: sourceLabelForSlot(target.kind, t),
    url: targetUrl,
    ...(sourceType === "pano360"
      ? { pano_url: targetUrl, slot_kind: "scene_director_pano_360" as const }
      : { ply_url: targetUrl }),
    current: true,
  };
}

function sourceLabelForSlot(kind: DirectorWorldSourceSlotTarget["kind"], t: TFn): string {
  if (kind === "scene_3gs_master_ply") return t("freezone.commit.worldSource.front");
  if (kind === "scene_3gs_reverse_ply") return t("freezone.commit.worldSource.back");
  if (kind === "scene_3gs_pano_ply") return t("freezone.commit.worldSource.pano");
  if (kind === "scene_3gs_custom_scene") return t("freezone.commit.worldSource.custom");
  return t("freezone.commit.worldSource.pano360Image");
}

function sourceFilename(result: Pick<PushResult, "target_path" | "target_url">): string {
  const raw = stringValue(result.target_path) || stringValue(result.target_url);
  const clean = raw.split("#", 1)[0]?.split("?", 1)[0] ?? raw;
  return clean.split("/").filter(Boolean).pop() || raw;
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
    const project = recordValue(context);
    const value = stringValue(project?.projectId);
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

function snapshotForSourceId(
  snapshot: ThreeDSceneSnapshot,
  sourceId: string,
): ThreeDSceneSnapshot {
  return {
    ...snapshot,
    world: {
      ...snapshot.world,
      activeSourceId: sourceId,
    },
  };
}

function committedSourceSlotFromNodeData(
  nodeData: Record<string, unknown>,
): { target: DirectorWorldSourceSlotTarget; targetUrl: string; sourceId: string } | null {
  const target = recordValue(nodeData.slot_target);
  const pushTarget = target as unknown as PushTarget | null;
  if (!pushTarget || !isDirectorWorldSourceSlotTarget(pushTarget)) return null;
  const targetUrl = stringValue(nodeData.committed_slot_url);
  if (!targetUrl) return null;
  const sourceId = sourceIdForCommittedSlot(pushTarget, targetUrl);
  return { target: pushTarget, targetUrl, sourceId };
}

function mainlineSourceIdForLocalSource(
  nodeData: Record<string, unknown>,
  localSourceId: string,
): string {
  const committedSlot = committedSourceSlotFromNodeData(nodeData);
  const activeSourceId = stringValue(nodeData.activeSourceId);
  if (committedSlot && activeSourceId && localSourceId === activeSourceId) {
    return committedSlot.sourceId;
  }
  return canonicalSceneSourceId(localSourceId);
}

function sourcePayloadForMainlineCommit(
  nodeData: Record<string, unknown>,
  sources: DirectorWorldSource[],
  localSourceId: string,
  t: TFn,
): Record<string, unknown> | undefined {
  const source = sources.find((item) => item.id === localSourceId);
  const committedSlot = committedSourceSlotFromNodeData(nodeData);
  const activeSourceId = stringValue(nodeData.activeSourceId);
  if (committedSlot && activeSourceId && localSourceId === activeSourceId) {
    return {
      ...source,
      ...sourcePatchForCommittedSlot(
        committedSlot.target,
        committedSlot.targetUrl,
        committedSlot.sourceId,
        t,
      ),
      ...(source?.transform ? { transform: source.transform } : {}),
    } as Record<string, unknown>;
  }
  if (!source) return undefined;
  const sourceId = stringValue(source.id);
  return {
    ...source,
    ...(sourceId ? { id: canonicalSceneSourceId(sourceId) } : {}),
  } as Record<string, unknown>;
}

async function existingSceneDirectorWorldSourceIds(
  project: string,
  sceneId: string,
): Promise<Set<string>> {
  try {
    const manifest = await getSceneDirectorStageManifest(project, sceneId);
    const ids = new Set<string>();
    const activeSourceId = stringValue(manifest.active_source_id);
    if (activeSourceId) ids.add(activeSourceId);
    for (const source of manifest.sources ?? []) {
      const sourceId = stringValue(source.id);
      if (sourceId) ids.add(sourceId);
    }
    for (const sourceId of Object.keys(manifest.scenes_by_source_id ?? {})) {
      if (sourceId.trim()) ids.add(sourceId.trim());
    }
    return ids;
  } catch {
    return new Set();
  }
}

const SOURCE_KIND_BY_SLOT: Record<DirectorWorldSourceSlotTarget["kind"], NonNullable<DirectorWorldSource["source_kind"]>> = {
  scene_director_pano_360: "pano",
  scene_3gs_master_ply: "master",
  scene_3gs_reverse_ply: "reverse",
  scene_3gs_pano_ply: "pano",
  scene_3gs_custom_scene: "custom",
};

export function isDirectorWorldSourceSlotTarget(target: PushTarget): target is DirectorWorldSourceSlotTarget {
  return (
    target.kind === "scene_director_pano_360" ||
    target.kind === "scene_3gs_master_ply" ||
    target.kind === "scene_3gs_reverse_ply" ||
    target.kind === "scene_3gs_pano_ply" ||
    target.kind === "scene_3gs_custom_scene"
  );
}

export function nodeDataAfterDirectorWorldSourceSlotCommit(
  nodeData: Record<string, unknown>,
  target: DirectorWorldSourceSlotTarget,
  result: Pick<PushResult, "target_path" | "target_url">,
  t: TFn,
  projectId?: string,
): Record<string, unknown> {
  const targetUrl = stringValue(result.target_url);
  if (!targetUrl) return nodeData;
  const isCandidate = nodeData.user_spawned === true || !hasMainlineContext(nodeData);
  const sources = Array.isArray(nodeData.sources)
    ? nodeData.sources.filter((source): source is DirectorWorldSource =>
        Boolean(source && typeof source === "object"),
      )
    : [];
  const currentScene = sceneSnapshot(nodeData.scene);
  const previousActiveSourceId =
    stringValue(nodeData.activeSourceId) ||
    sourceIdFromSnapshot(currentScene) ||
    stringValue(sources.find((source) => source.current)?.id) ||
    stringValue(sources[0]?.id) ||
    "committed-source";
  const committedSourceId = sourceIdForCommittedSlot(target, targetUrl);
  const activeSourceId = isCandidate ? previousActiveSourceId : committedSourceId;
  const sourceType: DirectorWorldSource["source_type"] =
    target.kind === "scene_director_pano_360" ? "pano360" : "sog";
  const candidateSourcePatch: Partial<DirectorWorldSource> = {
    url: targetUrl,
    ...(sourceType === "pano360"
      ? { pano_url: targetUrl, slot_kind: "scene_director_pano_360" as const }
      : { ply_url: targetUrl }),
    current: true,
  };
  const sourcePatch = isCandidate
    ? {
        id: activeSourceId,
        source_type: sources.find((source) => source.id === activeSourceId)?.source_type ?? sourceType,
        source_kind: sources.find((source) => source.id === activeSourceId)?.source_kind ?? "custom",
        ...candidateSourcePatch,
      } satisfies DirectorWorldSource
    : sourcePatchForCommittedSlot(target, targetUrl, activeSourceId, t);
  const nextSources = isCandidate
    ? [sourcePatch]
    : sources.length > 0
      ? sources.map((source) =>
          source.id === activeSourceId
            ? { ...source, ...sourcePatch }
            : { ...source, current: false },
        )
      : [sourcePatch];
  if (!nextSources.some((source) => source.id === activeSourceId)) {
    nextSources.push(sourcePatch);
  }
  const previousScenes = recordValue(nodeData.scenesBySourceId) ?? {};
  const previousSnapshot =
    sceneSnapshot(previousScenes[previousActiveSourceId]) ??
    currentScene;
  const nextSnapshot = previousSnapshot
    ? snapshotForSourceId(previousSnapshot, activeSourceId)
    : null;
  const nextScenesBySourceId: Record<string, unknown> = isCandidate ? {} : { ...previousScenes };
  if (!isCandidate && previousActiveSourceId !== activeSourceId) {
    delete nextScenesBySourceId[previousActiveSourceId];
  }
  if (nextSnapshot) {
    nextScenesBySourceId[activeSourceId] = nextSnapshot;
  }
  const sourceLabel = sourceLabelForSlot(target.kind, t);
  const displayName = `${target.scene_id} / ${sourceLabel}`;
  const effectiveProjectId = projectIdFromNodeData(nodeData, projectId);
  const mainlineContext = effectiveProjectId
    ? [{
        kind: "scene",
        projectId: effectiveProjectId,
        sceneId: target.scene_id,
        role: target.kind,
        label: displayName,
        sourceUrl: targetUrl,
      }]
    : nodeData.mainline_context;
  const previousSource = recordValue(nodeData.__freezone_source);
  const previousMeta = recordValue(previousSource?.meta);
  const nextSourceMeta = {
    ...previousMeta,
    scene_id: target.scene_id,
    scene: target.scene_id,
    source_kind: SOURCE_KIND_BY_SLOT[target.kind],
    source_type: sourceType,
  };

  return {
    ...nodeData,
    activeSourceId,
    displayName: isCandidate
      ? t("freezone.commit.committedNodeLabel", { label: displayName })
      : displayName,
    sourceFileName: sourceFilename(result),
    slot_target: target,
    committed_slot_url: targetUrl,
    committed_source_id: committedSourceId,
    committed_target_label: displayName,
    ...(isCandidate
      ? {
          mainline_context: undefined,
          __freezone_source: previousSource ?? nodeData.__freezone_source,
        }
      : {
          __freezone_source: {
            ...previousSource,
            kind: "scene",
            role: target.kind,
            label: displayName,
            meta: nextSourceMeta,
            media_type: "file",
            url: targetUrl,
            slot_target: target,
            pushable: true,
          },
          mainline_context: mainlineContext,
        }),
    sources: nextSources,
    ...(nextSnapshot ? { scene: nextSnapshot } : {}),
    scenesBySourceId: nextScenesBySourceId,
    ...(sourceType === "pano360"
      ? { panoUrl: targetUrl, url: targetUrl, plyUrl: undefined, modelUrl: undefined, fileUrl: undefined }
      : { plyUrl: targetUrl, modelUrl: targetUrl, fileUrl: targetUrl, url: targetUrl, panoUrl: undefined }),
  };
}

export async function commitSceneDirectorWorldFromCanvasNode(
  project: string,
  target: SceneDirectorWorldTarget,
  nodeData: Record<string, unknown>,
  t: TFn,
  options: SceneDirectorWorldCommitOptions = {},
): Promise<PushResult> {
  const sources = Array.isArray(nodeData.sources)
    ? nodeData.sources.filter((item): item is DirectorWorldSource =>
        Boolean(item && typeof item === "object"),
      )
    : [];
  const activeSourceId =
    stringValue(nodeData.activeSourceId) ||
    sourceIdFromSnapshot(sceneSnapshot(nodeData.scene)) ||
    stringValue(sources.find((source) => source.current)?.id) ||
    stringValue(sources[0]?.id);

  const scenesBySourceId = recordValue(nodeData.scenesBySourceId) ?? {};
  const entries = new Map<string, ThreeDSceneSnapshot>();
  for (const [sourceId, snapshot] of Object.entries(scenesBySourceId)) {
    const trimmed = sourceId.trim();
    const scene = sceneSnapshot(snapshot);
    if (trimmed && scene) {
      entries.set(trimmed, scene);
    }
  }

  const currentScene = sceneSnapshot(nodeData.scene);
  if (currentScene) {
    const currentSourceId = activeSourceId || sourceIdFromSnapshot(currentScene);
    if (currentSourceId) {
      entries.set(currentSourceId, currentScene);
    }
  }

  if (entries.size === 0) {
    throw new Error(t("freezone.commit.errors.noDirectorWorldState"));
  }

  for (const sourceId of entries.keys()) {
    const source = sources.find((item) => item.id === sourceId);
    if (isUncommittedDirectorWorldSource(source)) {
      throw new Error(t("freezone.commit.errors.commitWorldSourceFirst"));
    }
  }

  const orderedEntries = Array.from(entries.entries());
  orderedEntries.sort(([a], [b]) => {
    if (a === activeSourceId) return 1;
    if (b === activeSourceId) return -1;
    return 0;
  });

  const saveEntries = orderedEntries.map(([localSourceId, snapshot]) => {
    const mainlineSourceId = mainlineSourceIdForLocalSource(nodeData, localSourceId);
    return {
      localSourceId,
      mainlineSourceId,
      snapshot: mainlineSourceId === localSourceId
        ? snapshot
      : snapshotForSourceId(snapshot, mainlineSourceId),
    };
  });
  const nextSourceIds = new Set(saveEntries.map((entry) => entry.mainlineSourceId));
  for (const entry of saveEntries) {
    const activeSource = sourcePayloadForMainlineCommit(nodeData, sources, entry.localSourceId, t);
    if (options.pruneStale === false) {
      await saveSceneDirectorWorldSource(project, target.scene_id, {
        source_id: entry.mainlineSourceId,
        snapshot: entry.snapshot,
        source: activeSource,
      });
    } else {
      await saveSceneDirectorWorld(project, target.scene_id, {
        active_source_id: entry.mainlineSourceId,
        snapshot: entry.snapshot,
        active_source: activeSource,
      });
    }
  }
  if (options.pruneStale ?? true) {
    const existingSourceIds = await existingSceneDirectorWorldSourceIds(project, target.scene_id);
    for (const sourceId of existingSourceIds) {
      if (!nextSourceIds.has(sourceId)) {
        await clearSceneDirectorWorld(project, target.scene_id, sourceId);
      }
    }
  }

  const finalSourceId = orderedEntries[orderedEntries.length - 1]?.[0] ?? activeSourceId;
  const finalSource = sources.find((source) => source.id === finalSourceId);
  return {
    target_path: `director_worlds/${target.scene_id}/v1/stage_manifest.json`,
    target_url: sourceUrl(finalSource),
    backup: null,
    affected_count: orderedEntries.length,
  };
}
