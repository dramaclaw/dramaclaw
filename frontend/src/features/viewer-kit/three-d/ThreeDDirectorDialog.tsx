// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Children, forwardRef, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Camera,
  ChevronDown,
  Keyboard,
  Loader2,
  Move3D,
  Pause,
  Pipette,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";

import {
  generateAiStagingProp,
  getBeatDirectorStageOverlay,
  saveBeatDirectorControlFrame,
  saveBeatDirectorStageOverlay,
} from "@/api/viewerManifests";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { resolveMediaUrl } from "@/lib/media-url";
import { useViewerImmersiveBody } from "../useViewerImmersiveBody";
import type { ViewerPurpose } from "../viewerPurpose";
import type {
  DirectorControlFrameBundle,
  DirectorFrameMeta,
  DirectorFrameMetaPlacement,
  DirectorObjectLayer,
  DirectorStageManifest,
  DirectorStageOverlayStatus,
  DirectorStageSourceKind,
  DirectorStageSourceType,
  DirectorWorldSource,
} from "./directorManifest";
import {
  DEFAULT_DIRECTOR_WORLD_SOURCE_TRANSFORM,
  constrainSourceTransformForType,
  type DirectorWorldSourceTransform,
} from "./sourceTransform";
import { ThreeDStageCanvas } from "./ThreeDStageCanvas";
import {
  POSES,
  POSE_LABEL_KEYS,
  requirePoseName,
  SHAPE_HINT_NAMES,
  type PoseName,
  type ShapeHintName,
} from "./engine/viewerApp";
import type {
  MarkerCounts,
  SelectionState,
  ThreeDSceneSnapshot,
  ViewerApp,
} from "./engine/viewerApp";
import { dataUrlToBlob as decodeDataUrl } from "@/features/canvas/application/imageData";

type FrameAspect = "16:9" | "2:3" | "9:16" | "1:1" | "4:3";
type ToolMode = "actor" | "prop" | "staging";
type CaptureKind = "combined" | "env_only";
type CaptureDestination = "download" | "selected_background" | "canvas_screenshot_node" | "director_combined";
const DIRECTOR_CONTROL_FRAME_MAX_LONG_EDGE = 1280;
const SOURCE_CALIBRATION_RANGES = {
  default: {
    offsetMin: -10,
    offsetMax: 10,
    offsetStep: 0.1,
    scaleMin: 0.2,
    scaleMax: 3,
    scaleStep: 0.05,
  },
  pano360: {
    offsetMin: -240,
    offsetMax: 240,
    offsetStep: 1,
    scaleMin: 0.1,
    scaleMax: 8,
    scaleStep: 0.05,
  },
} as const;
type DirectorSourceOption = NonNullable<DirectorStageManifest["source_options"]>[number];
type NormalizedDirectorSource = {
  id: string;
  kind: Exclude<DirectorStageSourceKind, "active">;
  source_kind: Exclude<DirectorStageSourceKind, "active">;
  label: string;
  source_type: DirectorStageSourceType;
  ply_url?: string;
  url?: string;
  pano_url?: string;
  pano_fs?: string;
  collision_glb_url?: string;
  slot_kind?: "scene_director_pano_360" | "scene_360_candidate";
  fs?: string;
  current?: boolean;
  transform?: DirectorWorldSourceTransform;
  isManifestSourceFallback?: boolean;
};

interface ThreeDDirectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest: DirectorStageManifest | null;
  title?: string;
  description?: string;
  viewerPurpose?: ViewerPurpose;
  autoCommitDirectorCombined?: boolean;
  onCaptureSelectedBackground?: (blob: Blob, meta: ThreeDDirectorCaptureMeta) => void | Promise<void>;
  onCaptureCanvasNode?: (blob: Blob, meta: ThreeDDirectorCaptureMeta) => void | Promise<void>;
  onSubmitDirectorCombined?: (blob: Blob, meta: ThreeDDirectorCaptureMeta) => void | Promise<void>;
  /** 来源 3D 世界节点的「已保存场景快照」;打开时恢复 actor/prop/staging/相机。 */
  initialScene?: ThreeDSceneSnapshot | null;
  /** Per-source saved snapshots; source switching restores from this map. */
  initialScenesBySourceId?: Record<string, ThreeDSceneSnapshot | null | undefined> | null;
  /** 「保存 3D 世界」:导出当前编辑快照写回来源节点(下次打开自动恢复)。 */
  onSaveScene?: (snapshot: ThreeDSceneSnapshot, activeSourceId?: string) => void | Promise<void>;
  registerSaveSceneHandler?: (handler: (() => Promise<void>) | null) => void;
  /** 「清空保存」:清掉来源节点已存快照。 */
  onClearScene?: (activeSourceId?: string) => void | Promise<void>;
}

export interface ThreeDDirectorCaptureMeta {
  kind: CaptureKind;
  snapshot: ThreeDSceneSnapshot;
  source: DirectorStageManifest["source"];
  controlFrameUrl?: string;
  controlFrameRelPath?: string;
  controlFrameBundle?: DirectorControlFrameBundle;
  captureBundle?: {
    combined: Blob;
    env_only: Blob;
    frame_meta: DirectorFrameMeta;
  };
}

const FRAME_ASPECTS: FrameAspect[] = ["16:9", "2:3", "9:16", "1:1", "4:3"];

const ANONYMOUS_FALLBACK_COLOR = "#9ca3af";
const KEY_MOVE_STEP = 0.1;
const EMPTY_DIRECTOR_WORLD_SOURCE_ID = "__empty_director_world__";

function blankDirectorWorldManifest(displayName: string): DirectorStageManifest {
  return {
    viewer_kind: "three_d_director",
    mode: "scene",
    project: "",
    scene_id: "",
    display_name: displayName,
    source: {
      source_type: "sog",
      source_kind: "custom",
    },
    sources: [],
    active_source_id: EMPTY_DIRECTOR_WORLD_SOURCE_ID,
    palette: {
      actors: [],
      props: [],
      anonymous_colors: [],
      anonymous_prop_colors: [],
    },
    allowed_destinations: ["view"],
  };
}

function colorFromCreationPalette(palette: readonly string[], index: number): string {
  return palette[index] ?? ANONYMOUS_FALLBACK_COLOR;
}

function sourceTypeOf(source: { source_type?: DirectorStageSourceType }): DirectorStageSourceType {
  return source.source_type ?? "sog";
}

function sourceUrlOf(source: {
  source_type?: DirectorStageSourceType;
  ply_url?: string;
  url?: string;
  pano_url?: string;
}): string | null {
  return sourceTypeOf(source) === "pano360"
    ? source.pano_url ?? source.url ?? source.ply_url ?? null
    : source.ply_url ?? source.url ?? source.pano_url ?? null;
}

function sourceIdentityUrlOf(source: {
  source_type?: DirectorStageSourceType;
  ply_url?: string;
  url?: string;
  pano_url?: string;
}): string {
  const url = sourceUrlOf(source)?.trim() ?? "";
  if (!url) return "";
  const withoutHash = url.split("#", 1)[0] ?? "";
  return withoutHash.split("?", 1)[0] ?? "";
}

function supportedSourceTypeOf(source: {
  source_type?: DirectorWorldSource["source_type"];
}): DirectorStageSourceType | null {
  const sourceType = source.source_type ?? "sog";
  return sourceType === "sog" || sourceType === "pano360" ? sourceType : null;
}

function nonActiveSourceKind(
  kind: DirectorStageSourceKind | undefined,
): Exclude<DirectorStageSourceKind, "active"> {
  return kind && kind !== "active" ? kind : "custom";
}

function isDefaultSourceLabel(label: string, kind: Exclude<DirectorStageSourceKind, "active">): boolean {
  return label.trim().toLowerCase() === kind;
}

function uniqueSourceId(id: string, seen: Map<string, number>): string {
  const count = seen.get(id) ?? 0;
  seen.set(id, count + 1);
  return count === 0 ? id : `${id}:${count + 1}`;
}

function normalizeDirectorSource(
  source: Omit<DirectorWorldSource, "source_type"> & { source_type?: DirectorWorldSource["source_type"] },
  fallbackId: string,
  seen: Map<string, number>,
): NormalizedDirectorSource | null {
  const sourceType = supportedSourceTypeOf(source);
  if (!sourceType) return null;
  const url = sourceUrlOf({ ...source, source_type: sourceType });
  if (!url) return null;
  const kind = nonActiveSourceKind(source.source_kind);
  return {
    id: uniqueSourceId(source.id ?? fallbackId, seen),
    kind,
    source_kind: kind,
    label: source.label ?? kind,
    source_type: sourceType,
    ply_url: source.ply_url,
    url: source.url,
    pano_url: source.pano_url,
    pano_fs: source.pano_fs,
    collision_glb_url: source.collision_glb_url,
    slot_kind: source.slot_kind,
    fs: source.fs,
    current: source.current,
    transform: source.transform,
  };
}

function normalizeLegacySourceOption(
  source: DirectorSourceOption,
  fallbackId: string,
  seen: Map<string, number>,
): NormalizedDirectorSource | null {
  if (source.kind === "active") return null;
  return normalizeDirectorSource(
    {
      ...source,
      source_kind: source.kind,
      id: fallbackId,
    },
    fallbackId,
    seen,
  );
}

function normalizeManifestSource(
  source: DirectorStageManifest["source"],
  seen: Map<string, number>,
): NormalizedDirectorSource | null {
  const sourceType = sourceTypeOf(source);
  const normalized = normalizeDirectorSource(
    {
      ...source,
      id: `source:${source.source_kind}:${sourceType}:${sourceIdentityUrlOf({ ...source, source_type: sourceType })}`,
      source_type: sourceType,
      source_kind: source.source_kind,
      label: source.source_kind,
      current: true,
    },
    "source",
    seen,
  );
  return normalized ? { ...normalized, isManifestSourceFallback: true } : null;
}

function dedupeDirectorSources(sources: NormalizedDirectorSource[]): NormalizedDirectorSource[] {
  const byKey = new Map<string, NormalizedDirectorSource>();
  const order: string[] = [];
  for (const source of sources) {
    const url = sourceUrlOf(source);
    const key = `${source.source_type}:${url ?? source.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, source);
      order.push(key);
      continue;
    }
    if (source.current && !existing.current) {
      byKey.set(key, { ...existing, current: true });
    }
  }
  return order.map((key) => byKey.get(key)).filter((source): source is NormalizedDirectorSource => Boolean(source));
}

function directorSourcesFromManifest(manifest: DirectorStageManifest): NormalizedDirectorSource[] {
  const seen = new Map<string, number>();
  if (manifest.sources?.length) {
    return dedupeDirectorSources(manifest.sources
      .map((source, index) => normalizeDirectorSource(source, `source:${index + 1}`, seen))
      .filter((source): source is NormalizedDirectorSource => source !== null));
  }
  if (manifest.source_options?.length) {
    const legacySources = manifest.source_options
      .map((source) => {
        const sourceType = supportedSourceTypeOf(source) ?? "sog";
        const identityUrl = sourceIdentityUrlOf({ ...source, source_type: sourceType });
        const fallbackId =
          manifest.mode === "scene" &&
          sourceType === "pano360" &&
          source.slot_kind === "scene_director_pano_360"
            ? `scene-pano:${manifest.scene_id}`
            : `legacy:${source.kind}:${sourceType}:${identityUrl}`;
        return normalizeLegacySourceOption(
          source,
          fallbackId,
          seen,
        );
      })
      .filter((source): source is NormalizedDirectorSource => source !== null);
    if (legacySources.length > 0) return dedupeDirectorSources(legacySources);
  }
  const source = normalizeManifestSource(manifest.source, seen);
  return source ? [source] : [];
}

function numberTuple3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const next = value.slice(0, 3).map((item) => Number(item));
  return next.every((item) => Number.isFinite(item))
    ? [next[0], next[1], next[2]]
    : fallback;
}

type MarkerSnapshot = ThreeDSceneSnapshot["actors"][number];

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function shapeHintFromOverlayItem(
  data: Record<string, unknown>,
  fallback: ShapeHintName,
): ShapeHintName {
  const value = typeof data.shapeHint === "string"
    ? data.shapeHint
    : typeof data.shape_hint === "string"
      ? data.shape_hint
      : "";
  return (SHAPE_HINT_NAMES as string[]).includes(value) ? value as ShapeHintName : fallback;
}

function markerSnapshotFromOverlayItem(item: unknown, fallbackColor: string): MarkerSnapshot {
  const data = objectRecord(item);
  const yaw = Number(data.yaw ?? data.yawDeg ?? 0);
  const scaleValue = data.scale;
  const uniformScale = typeof scaleValue === "number" && Number.isFinite(scaleValue)
    ? scaleValue
    : 1;
  return {
    label: String(data.label ?? data.name ?? data.identity_id ?? data.prop_id ?? "marker"),
    color: String(data.color ?? data.marker_color ?? fallbackColor),
    position: numberTuple3(data.position, [0, 0, 0]),
    yawDeg: Number.isFinite(yaw) ? yaw : 0,
    scale: numberTuple3(scaleValue, [uniformScale, uniformScale, uniformScale]),
  };
}

function actorSnapshotFromOverlayItem(item: unknown, fallbackColor: string): MarkerSnapshot {
  const data = objectRecord(item);
  const base = markerSnapshotFromOverlayItem(item, fallbackColor);
  const pose = requirePoseName(
    data.state ?? data.pose ?? "standing",
    `overlay state for "${String(data.label ?? data.name ?? "actor")}"`,
  );
  const actionPlaying = typeof data.actionPlaying === "boolean"
    ? data.actionPlaying
    : typeof data.action_playing === "boolean"
      ? data.action_playing
      : undefined;
  return {
    ...base,
    pose,
    ...(typeof actionPlaying === "boolean" ? { actionPlaying } : {}),
  };
}

function propSnapshotFromOverlayItem(item: unknown, fallbackColor: string): MarkerSnapshot {
  const data = objectRecord(item);
  return {
    ...markerSnapshotFromOverlayItem(item, fallbackColor),
    shapeHint: shapeHintFromOverlayItem(data, "box"),
  };
}

function stagingSnapshotFromOverlayItem(item: unknown, fallbackColor: string): MarkerSnapshot {
  const data = objectRecord(item);
  return {
    ...markerSnapshotFromOverlayItem(item, fallbackColor),
    shapeHint: shapeHintFromOverlayItem(data, "generic_large"),
  };
}

function snapshotFromOverlay(
  overlay: DirectorStageOverlayStatus["overlay"],
): ThreeDSceneSnapshot | null {
  if (!overlay) return null;
  const overlaySourceId =
    overlay.source?.source_id ??
    overlay.frame_meta?.source?.source_id ??
    overlay.frame_meta?.layer?.source_id;
  if (overlay.snapshot && typeof overlay.snapshot === "object") {
    const snapshot = overlay.snapshot as unknown as ThreeDSceneSnapshot;
    return overlaySourceId
      ? sceneSnapshotForPersistence(snapshot, overlaySourceId)
      : snapshot;
  }
  const actors = Array.isArray(overlay.actors) ? overlay.actors : [];
  const props = Array.isArray(overlay.props) ? overlay.props : [];
  const stagings = Array.isArray(overlay.stagings) ? overlay.stagings : [];
  if (!actors.length && !props.length && !stagings.length) {
    return null;
  }
  const isStagingItem = (item: unknown) => {
    const type = item && typeof item === "object"
      ? String((item as Record<string, unknown>).type ?? "")
      : "";
    const category = item && typeof item === "object"
      ? String((item as Record<string, unknown>).category ?? "")
      : "";
    return type === "prop_staging" || category === "staging";
  };
  const itemKey = (item: unknown, index: number, prefix: string) => {
    const data = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return String(data.id ?? data.prop_id ?? data.identity_id ?? data.name ?? data.label ?? `${prefix}_${index}`);
  };
  const propItems = props.filter((item) => !isStagingItem(item));
  const stagingItems = [
    ...stagings,
    ...props.filter((item) => isStagingItem(item)),
  ].filter((item, index, list) => {
    const key = itemKey(item, index, "staging");
    return list.findIndex((candidate, candidateIndex) => (
      itemKey(candidate, candidateIndex, "staging") === key
    )) === index;
  });
  return {
    schemaVersion: 1,
    savedAt: Date.now(),
    actors: actors.map((item) => actorSnapshotFromOverlayItem(item, "#ff3344")),
    props: propItems.map((item) => propSnapshotFromOverlayItem(item, "#ffd34d")),
    stagings: stagingItems.map((item) => stagingSnapshotFromOverlayItem(item, "#4587ff")),
    camera: overlay.camera as ThreeDSceneSnapshot["camera"],
    world: overlaySourceId ? { activeSourceId: overlaySourceId } : undefined,
  };
}

function overlayItemId(label: string, index: number, prefix: string) {
  return `${prefix}_${label.toLowerCase().replace(/[^a-z0-9_\-\u4e00-\u9fff]+/gi, "_") || index + 1}`;
}

function snapshotToDirectorObjectLayer(
  activeSourceId: string,
  snapshot: ThreeDSceneSnapshot,
): DirectorObjectLayer {
  const markerPlacement = (item: MarkerSnapshot): DirectorFrameMetaPlacement => {
    if (item.placement?.space === "pano_view") {
      return {
        space: "pano_view",
        yaw_deg: item.placement.yawDeg,
        pitch_deg: item.placement.pitchDeg,
        distance: item.placement.distance,
      };
    }
    if (item.placement?.space === "world") {
      return {
        space: "world",
        position: item.placement.position,
        yaw_deg: item.placement.yawDeg,
      };
    }
    return {
      space: "world",
      position: item.position,
      yaw_deg: item.yawDeg,
    };
  };
  return {
    source_id: activeSourceId,
    actors: snapshot.actors.map((item, index) => ({
      id: overlayItemId(item.label, index, "actor"),
      kind: "actor",
      label: item.label,
      color: item.color,
      scale: item.scale,
      placement: markerPlacement(item),
      ...(item.pose ? { pose: item.pose } : {}),
      ...(typeof item.actionPlaying === "boolean" ? { action_playing: item.actionPlaying } : {}),
    })),
    props: snapshot.props.map((item, index) => ({
      id: overlayItemId(item.label, index, "prop"),
      kind: "prop",
      label: item.label,
      color: item.color,
      scale: item.scale,
      placement: markerPlacement(item),
    })),
    stagings: snapshot.stagings.map((item, index) => ({
      id: overlayItemId(item.label, index, "staging"),
      kind: "staging",
      name: item.label,
      label: item.label,
      color: item.color,
      marker_color: item.color,
      semantic_label: item.label,
      scale: item.scale,
      placement: markerPlacement(item),
      ...(item.shapeHint ? { shape_hint: item.shapeHint } : {}),
    })),
  };
}

function frameMetaFromSnapshot({
  source,
  frameAspect,
  snapshot,
  beatContext,
  cameraMode = "sog",
}: {
  source: DirectorFrameMeta["source"];
  frameAspect: FrameAspect;
  snapshot: ThreeDSceneSnapshot;
  beatContext?: DirectorStageManifest["beat_context"];
  cameraMode?: DirectorFrameMeta["camera"]["mode"];
}): DirectorFrameMeta {
  const layer = snapshotToDirectorObjectLayer(source.source_id, snapshot);
  const actors = layer.actors.map((item) => ({
    id: item.id,
    identity_id: item.label,
    name: item.label,
    label: item.label,
    ...(item.pose ? { state: item.pose } : {}),
    ...(typeof item.action_playing === "boolean" ? { action_playing: item.action_playing } : {}),
    marker_color: item.color,
  }));
  const props = layer.props.map((item) => ({
    id: item.id,
    prop_id: item.label,
    name: item.label,
    label: item.label,
    type: "prop_hero" as const,
    category: "hero" as const,
    marker_color: item.color,
    semantic_label: item.label,
  }));
  const stagings = layer.stagings.map((item) => ({
    id: item.id,
    prop_id: item.id,
    name: item.label,
    label: item.label,
    type: "prop_staging" as const,
    category: "staging" as const,
    marker_color: item.color,
    semantic_label: item.label,
    ...(item.shape_hint ? { shape_hint: item.shape_hint } : {}),
  }));
  return {
    schema_version: "director_frame_meta_v1",
    source,
    camera: {
      mode: cameraMode,
      frame_aspect: frameAspect,
      state: snapshot.camera ? { ...snapshot.camera } : {},
    },
    layer,
    actors,
    props: [...props, ...stagings],
    stagings,
    ...(beatContext ? { beat_context: beatContext } : {}),
  };
}

function richOverlayFromSnapshot(
  snapshot: ThreeDSceneSnapshot,
  manifest: DirectorStageManifest,
) {
  const actors = snapshot.actors.map((item, index) => {
    const paletteItem = manifest.palette.actors.find(
      (actor) => actor.identity_id === item.label || actor.label === item.label || actor.color === item.color,
    );
    const label = paletteItem?.label ?? item.label ?? `actor_${index + 1}`;
    const identityId = paletteItem?.identity_id ?? item.label ?? `anonymous_actor_${index + 1}`;
    return {
      id: overlayItemId(identityId, index, "actor"),
      identity_id: identityId,
      name: label,
      label,
      state: item.pose ?? "standing",
      action_playing: item.actionPlaying ?? true,
      marker_color: item.color,
      position: item.position,
      yaw: item.yawDeg,
      scale: item.scale,
    };
  });
  const props = snapshot.props.map((item, index) => {
    const paletteItem = manifest.palette.props.find(
      (prop) => prop.prop_id === item.label || prop.label === item.label || prop.color === item.color,
    );
    const label = paletteItem?.label ?? item.label ?? `prop_${index + 1}`;
    const propId = paletteItem?.prop_id ?? item.label ?? `prop_${index + 1}`;
    return {
      id: overlayItemId(propId, index, "prop"),
      prop_id: propId,
      name: label,
      label,
      type: "prop_hero",
      category: "hero",
      marker_color: item.color,
      semantic_label: label,
      position: item.position,
      yaw: item.yawDeg,
      scale: item.scale,
      tracking: "tracked_marker",
      asset_scope: "scene",
    };
  });
  const stagings = snapshot.stagings.map((item, index) => {
    const label = item.label ?? `staging_${index + 1}`;
    return {
      id: overlayItemId(label, index, "staging"),
      prop_id: overlayItemId(label, index, "staging"),
      name: label,
      label,
      type: "prop_staging",
      category: "staging",
      marker_color: item.color,
      semantic_label: label,
      shape_hint: item.shapeHint ?? "generic_large",
      position: item.position,
      yaw: item.yawDeg,
      scale: item.scale,
      attached_to: "staging",
      tracking: "scene_placeholder",
      asset_scope: "scene",
      is_global_asset: false,
    };
  });
  return {
    camera: snapshot.camera ?? {},
    actors,
    props,
    stagings,
  };
}

function sceneSnapshotForPersistence(
  snapshot: ThreeDSceneSnapshot,
  activeSourceId?: string,
): ThreeDSceneSnapshot {
  return activeSourceId
    ? {
        ...snapshot,
        world: {
          ...snapshot.world,
          activeSourceId,
        },
      }
    : snapshot;
}

function savedSceneMapFromInitial(
  initialScene: ThreeDSceneSnapshot | null | undefined,
  initialScenesBySourceId: Record<string, ThreeDSceneSnapshot | null | undefined> | null | undefined,
  fallbackSourceId?: string | null,
): Record<string, ThreeDSceneSnapshot> {
  const next: Record<string, ThreeDSceneSnapshot> = {};
  for (const [sourceId, snapshot] of Object.entries(initialScenesBySourceId ?? {})) {
    if (snapshot?.schemaVersion === 1) next[sourceId] = snapshot;
  }
  if (initialScene?.schemaVersion === 1) {
    const snapshotSourceId = typeof initialScene.world?.activeSourceId === "string"
      ? initialScene.world.activeSourceId
      : fallbackSourceId ?? undefined;
    if (snapshotSourceId) next[snapshotSourceId] = initialScene;
    if (fallbackSourceId) next[fallbackSourceId] = initialScene;
  }
  return next;
}

function triggerDownload(dataUrl: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function dataUrlToBlob(dataUrl: string) {
  // CSP `connect-src 'self'` blocks fetching data: URLs in production, so decode
  // them directly; other (same-origin) URLs still go through fetch.
  if (dataUrl.startsWith("data:")) {
    return decodeDataUrl(dataUrl);
  }
  return fetch(dataUrl).then((response) => response.blob());
}

function aspectToWh(aspect: FrameAspect): [number, number] {
  switch (aspect) {
    case "16:9":
      return [16, 9];
    case "2:3":
      return [2, 3];
    case "9:16":
      return [9, 16];
    case "1:1":
      return [1, 1];
    case "4:3":
      return [4, 3];
  }
}

function captureFilename(manifest: DirectorStageManifest, kind: CaptureKind) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${manifest.scene_id}_${kind}_${timestamp}.png`;
}

export function ThreeDDirectorDialog({
  open,
  onOpenChange,
  manifest,
  title,
  description,
  autoCommitDirectorCombined = false,
  onCaptureSelectedBackground,
  onCaptureCanvasNode,
  onSubmitDirectorCombined,
  initialScene,
  initialScenesBySourceId,
  onSaveScene,
  registerSaveSceneHandler,
  onClearScene,
}: ThreeDDirectorDialogProps) {
  const { t } = useTranslation();
  const dialogTitle = title ?? t("viewer.threeD.title");
  const dialogDescription = description ?? t("viewer.threeD.description");
  const effectiveManifest = useMemo(
    () => manifest ?? blankDirectorWorldManifest(dialogTitle),
    [dialogTitle, manifest],
  );
  useViewerImmersiveBody(open);
  const handleOpenChange = useCallback(
    (nextOpen: boolean, details?: { reason?: string }) => {
      if (manifest && !nextOpen && details?.reason === "escape-key") return;
      onOpenChange(nextOpen);
    },
    [manifest, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="inset-0 left-0 top-0 h-dvh w-dvw max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 p-0 ring-0 data-open:zoom-in-100 data-closed:zoom-out-100 sm:max-w-none"
        overlayClassName="bg-black/55 supports-backdrop-filter:backdrop-blur-none"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>
        <ThreeDDirectorSurface
          manifest={effectiveManifest}
          onCaptureSelectedBackground={onCaptureSelectedBackground}
          onCaptureCanvasNode={onCaptureCanvasNode}
          onSubmitDirectorCombined={onSubmitDirectorCombined}
          autoCommitDirectorCombined={autoCommitDirectorCombined}
          initialScene={initialScene}
          initialScenesBySourceId={initialScenesBySourceId}
          onSaveScene={onSaveScene}
          registerSaveSceneHandler={registerSaveSceneHandler}
          onClearScene={onClearScene}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ThreeDDirectorSurface({
  manifest,
  onCaptureSelectedBackground,
  onCaptureCanvasNode,
  onSubmitDirectorCombined,
  autoCommitDirectorCombined,
  initialScene,
  initialScenesBySourceId,
  onSaveScene,
  registerSaveSceneHandler,
  onClearScene,
  onClose,
}: {
  manifest: DirectorStageManifest;
  onCaptureSelectedBackground?: (blob: Blob, meta: ThreeDDirectorCaptureMeta) => void | Promise<void>;
  onCaptureCanvasNode?: (blob: Blob, meta: ThreeDDirectorCaptureMeta) => void | Promise<void>;
  onSubmitDirectorCombined?: (blob: Blob, meta: ThreeDDirectorCaptureMeta) => void | Promise<void>;
  autoCommitDirectorCombined?: boolean;
  initialScene?: ThreeDSceneSnapshot | null;
  initialScenesBySourceId?: Record<string, ThreeDSceneSnapshot | null | undefined> | null;
  onSaveScene?: (snapshot: ThreeDSceneSnapshot, activeSourceId?: string) => void | Promise<void>;
  registerSaveSceneHandler?: (handler: (() => Promise<void>) | null) => void;
  onClearScene?: (activeSourceId?: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const viewerRef = useRef<ViewerApp | null>(null);
  const exportControlFramesRef = useRef<(() => void) | null>(null);
  const saveDirectorStateRef = useRef<(() => void) | null>(null);
  const canWriteDirectorBundle = Boolean(
    autoCommitDirectorCombined && onSubmitDirectorCombined && manifest.mode === "beat" && manifest.beat_context,
  );
  const [viewer, setViewer] = useState<ViewerApp | null>(null);
  const [status, setStatus] = useState(() => t("viewer.threeD.initializing"));
  const [error, setError] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState(false);
  const [sceneStatus, setSceneStatus] = useState<string | null>(
    initialScene ? "已恢复上次保存的场景" : null,
  );
  const lastRestoredSourceIdRef = useRef<string | null>(null);
  const initialSceneRef = useRef(initialScene);
  initialSceneRef.current = initialScene;
  const [toolMode, setToolMode] = useState<ToolMode>("actor");
  const [frameAspect, setFrameAspect] = useState<FrameAspect>("16:9");
  const [panelHidden, setPanelHidden] = useState(false);
  const [stageActive, setStageActive] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [sourceCalibrationAdvancedOpen, setSourceCalibrationAdvancedOpen] = useState(false);
  const [counts, setCounts] = useState<MarkerCounts>({ actor: 0, prop: 0, staging: 0 });
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [captureBusy, setCaptureBusy] = useState<CaptureKind | null>(null);
  const [exportStatus, setExportStatus] = useState("");
  const [overlayStatus, setOverlayStatus] = useState<DirectorStageOverlayStatus | null>(null);
  const [overlayBusy, setOverlayBusy] = useState(false);
  const [sourceReadyRevision, setSourceReadyRevision] = useState(0);
  const overlayAppliedAfterSplatReadyRef = useRef(0);
  const frameGuideRef = useRef<HTMLDivElement | null>(null);
  const [aiStagingBusy, setAiStagingBusy] = useState(false);
  const [commandLog, setCommandLog] = useState<Array<Record<string, unknown>>>([]);
  const [anonymousSequence, setAnonymousSequence] = useState({ actor: 0, prop: 0 });
  const [selectedOverlayBeat, setSelectedOverlayBeat] = useState(
    String(manifest.beat_context?.beat ?? ""),
  );
  const selectableSourceItems = useMemo(
    () => [
      ...directorSourcesFromManifest(manifest),
      {
        id: EMPTY_DIRECTOR_WORLD_SOURCE_ID,
        kind: "custom" as const,
        source_kind: "custom" as const,
        label: t("viewer.threeD.emptySource"),
        source_type: "sog" as const,
      },
    ],
    [manifest, t],
  );
  const [activeSourceId, setActiveSourceId] = useState(
    manifest.active_source_id && selectableSourceItems.some((item) => item.id === manifest.active_source_id)
      ? manifest.active_source_id
      : selectableSourceItems[0]?.id ?? "",
  );
  const activeSourceIdRef = useRef(activeSourceId);
  activeSourceIdRef.current = activeSourceId;
  const savedScenesBySourceRef = useRef<Record<string, ThreeDSceneSnapshot>>(
    savedSceneMapFromInitial(
      initialScene,
      initialScenesBySourceId,
      activeSourceId || manifest.active_source_id,
    ),
  );
  useEffect(() => {
    const next = savedSceneMapFromInitial(
      initialScene,
      initialScenesBySourceId,
      activeSourceId || manifest.active_source_id,
    );
    savedScenesBySourceRef.current = {
      ...next,
      ...savedScenesBySourceRef.current,
    };
  }, [activeSourceId, initialScene, initialScenesBySourceId, manifest.active_source_id]);
  useEffect(() => {
    lastRestoredSourceIdRef.current = null;
  }, [activeSourceId]);
  const [orientationMode, setOrientationMode] = useState(
    manifest.source_orientation_mode ?? "supersplat_auto",
  );

  const actorChoices = useMemo(() => {
    if (manifest.palette.actors.length > 0) return manifest.palette.actors;
    return [];
  }, [manifest.palette.actors]);
  const propChoices = useMemo(() => {
    if (manifest.palette.props.length > 0) return manifest.palette.props;
    return [];
  }, [manifest.palette.props]);
  const anonymousActorColors = manifest.palette.anonymous_colors ?? [];
  const anonymousPropColors = manifest.palette.anonymous_prop_colors ?? [];
  const anonymousActorPalette = useMemo(
    () => anonymousActorColors.length > 0
      ? anonymousActorColors
      : [],
    [anonymousActorColors],
  );
  const anonymousPropPalette = useMemo(
    () => anonymousPropColors.length > 0
      ? anonymousPropColors
      : [],
    [anonymousPropColors],
  );
  const nextPropLikeColor = colorFromCreationPalette(anonymousPropPalette, anonymousSequence.prop);
  const nextAnonymousActor = useMemo(() => {
    const nextNumber = anonymousSequence.actor + 1;
    return {
      identity_id: `anonymous_actor_${nextNumber}`,
      label: t("viewer.threeD.anonymousActor", { n: nextNumber }),
      color: colorFromCreationPalette(anonymousActorPalette, anonymousSequence.actor),
    };
  }, [anonymousActorPalette, anonymousSequence.actor, t]);
  const nextAnonymousProp = useMemo(() => {
    const nextNumber = anonymousSequence.prop + 1;
    return {
      prop_id: `anonymous_prop_${nextNumber}`,
      label: t("viewer.threeD.anonymousProp", { n: nextNumber }),
      color: nextPropLikeColor,
    };
  }, [anonymousSequence.prop, nextPropLikeColor, t]);

  const [actorId, setActorId] = useState(actorChoices[0]?.identity_id ?? "");
  const [propId, setPropId] = useState(propChoices[0]?.prop_id ?? "");
  const [actorScale, setActorScale] = useState(1);
  // 匿名/场景模式下人物颜色可自由选择(默认跟随所选身份的预设色)。
  const [actorColor, setActorColor] = useState<string>(ANONYMOUS_FALLBACK_COLOR);
  const [stagingName, setStagingName] = useState("");
  const [propLikeColor, setPropLikeColor] = useState<string>(ANONYMOUS_FALLBACK_COLOR);

  useEffect(() => {
    const current =
      manifest.active_source_id
        ? selectableSourceItems.find((item) => item.id === manifest.active_source_id)
        : undefined;
    setActiveSourceId(
      current?.id ??
      selectableSourceItems.find((item) => item.current)?.id ??
      selectableSourceItems.find((item) => item.kind === manifest.source.source_kind)?.id ??
      selectableSourceItems[0]?.id ??
      "",
    );
  }, [manifest.active_source_id, manifest.source.source_kind, selectableSourceItems]);

  useEffect(() => {
    setOrientationMode(manifest.source_orientation_mode ?? "supersplat_auto");
  }, [manifest.source_orientation_mode]);

  useEffect(() => {
    setSelectedOverlayBeat(String(manifest.beat_context?.beat ?? ""));
  }, [manifest.beat_context?.beat]);

  useEffect(() => {
    setActorId(actorChoices[0]?.identity_id ?? "");
  }, [actorChoices]);

  useEffect(() => {
    setPropId(propChoices[0]?.prop_id ?? "");
  }, [propChoices]);

  const activeActor = manifest.mode === "beat"
    ? actorChoices.find((item) => item.identity_id === actorId) ?? actorChoices[0]
    : nextAnonymousActor;
  const activeProp = manifest.mode === "beat"
    ? propChoices.find((item) => item.prop_id === propId) ?? propChoices[0]
    : nextAnonymousProp;
  const trimmedStagingName = stagingName.trim();

  // 选不同(匿名)身份时,把颜色默认值同步成该身份预设色;用户随后可自由改。
  useEffect(() => {
    if (activeActor) setActorColor(activeActor.color);
  }, [activeActor]);
  useEffect(() => {
    if (activeProp) setPropLikeColor(activeProp.color);
  }, [activeProp]);
  useEffect(() => {
    if (!activeProp && propLikeColor === ANONYMOUS_FALLBACK_COLOR && anonymousPropPalette.length > 0) {
      setPropLikeColor(nextPropLikeColor);
    }
  }, [activeProp, anonymousPropPalette.length, nextPropLikeColor, propLikeColor]);
  const activeSourceItem =
    selectableSourceItems.find((item) => item.id === activeSourceId) ??
    selectableSourceItems[0];
  const activeSource = activeSourceItem;
  const activeSourceType = activeSource ? sourceTypeOf(activeSource) : sourceTypeOf(manifest.source);
  const activeSourceUrl = activeSource ? sourceUrlOf(activeSource) : sourceUrlOf(manifest.source);
  const activeSplatUrl = activeSourceType === "sog" ? activeSourceUrl : null;
  const activePanoUrl = activeSourceType === "pano360" ? activeSourceUrl : null;
  const activeCollisionUrl =
    activeSource?.collision_glb_url ??
    (activeSource?.isManifestSourceFallback ? manifest.source.collision_glb_url ?? null : null);
  const sourceCalibrationRanges = activeSourceType === "pano360"
    ? SOURCE_CALIBRATION_RANGES.pano360
    : SOURCE_CALIBRATION_RANGES.default;
  const activeSceneSourceId = activeSource?.id || activeSourceId || manifest.active_source_id || "";
  const activeSourceKind = activeSource?.kind ?? nonActiveSourceKind(manifest.source.source_kind);
  const activeFrameSource: DirectorFrameMeta["source"] = {
    source_id: activeSceneSourceId || "source",
    source_type: activeSourceType,
    source_kind: activeSourceKind,
    label: activeSource?.label,
    ply_url: activeSplatUrl ?? undefined,
    url: activeSourceUrl ?? undefined,
    pano_url: activeSourceType === "pano360" ? activeSourceUrl ?? undefined : activeSource?.pano_url,
    pano_fs: activeSource?.pano_fs,
    collision_glb_url: activeCollisionUrl ?? undefined,
    slot_kind: activeSource?.slot_kind,
    fs: activeSource?.fs,
  };
  const savedSceneForActiveSource =
    (activeSceneSourceId && savedScenesBySourceRef.current[activeSceneSourceId]) ||
    (
      initialScene?.schemaVersion === 1 &&
      (!initialScene.world?.activeSourceId || initialScene.world.activeSourceId === activeSceneSourceId)
        ? initialScene
        : null
    );
  const activeSourceInitialTransform = useMemo(
    () => constrainSourceTransformForType(
      activeSource?.transform ?? savedSceneForActiveSource?.world?.sourceTransform,
      activeSourceType,
    ),
    [activeSource?.transform, activeSourceType, savedSceneForActiveSource],
  );
  const [sourceTransformState, setSourceTransformState] = useState<DirectorWorldSourceTransform>(
    DEFAULT_DIRECTOR_WORLD_SOURCE_TRANSFORM,
  );
  const sourceTransformStateRef = useRef<DirectorWorldSourceTransform>(
    DEFAULT_DIRECTOR_WORLD_SOURCE_TRANSFORM,
  );
  const syncSourceTransformState = useCallback((next: DirectorWorldSourceTransform) => {
    sourceTransformStateRef.current = next;
    setSourceTransformState(next);
  }, []);
  useEffect(() => {
    syncSourceTransformState(activeSourceInitialTransform);
  }, [activeSceneSourceId, activeSourceInitialTransform, syncSourceTransformState]);
  const hasSavedSceneForActiveSource = Boolean(
    savedSceneForActiveSource,
  );

  const cycleActorChoice = useCallback(() => {
    setToolMode("actor");
    if (manifest.mode !== "beat") {
      setStatus(t("viewer.threeD.statusMessages.actorPreset", { label: nextAnonymousActor.label }));
      return true;
    }
    if (actorChoices.length === 0) {
      setStatus(t("viewer.threeD.statusMessages.noActorPreset"));
      return false;
    }
    const currentIndex = actorChoices.findIndex((item) => item.identity_id === actorId);
    const next = actorChoices[(currentIndex + 1 + actorChoices.length) % actorChoices.length]
      ?? actorChoices[0];
    setActorId(next.identity_id);
    setStatus(t("viewer.threeD.statusMessages.actorPreset", { label: next.label }));
    return true;
  }, [actorChoices, actorId, manifest.mode, nextAnonymousActor.label, t]);

  const cyclePropChoice = useCallback(() => {
    setToolMode("prop");
    if (manifest.mode !== "beat") {
      setStatus(t("viewer.threeD.statusMessages.propPreset", { label: nextAnonymousProp.label }));
      return true;
    }
    if (propChoices.length === 0) {
      setStatus(t("viewer.threeD.statusMessages.noPropPreset"));
      return false;
    }
    const currentIndex = propChoices.findIndex((item) => item.prop_id === propId);
    const next = propChoices[(currentIndex + 1 + propChoices.length) % propChoices.length]
      ?? propChoices[0];
    setPropId(next.prop_id);
    setStatus(t("viewer.threeD.statusMessages.propPreset", { label: next.label }));
    return true;
  }, [manifest.mode, nextAnonymousProp.label, propChoices, propId, t]);

  const handleReady = useCallback((next: ViewerApp) => {
    viewerRef.current = next;
    setViewer(next);
  }, []);

  const handleSourceReady = useCallback(() => {
    setSourceReadyRevision((prev) => prev + 1);
    const viewerApp = viewerRef.current;
    const sourceId = activeSourceId || activeSource?.id || "";
    const snapshot =
      (sourceId ? savedScenesBySourceRef.current[sourceId] : undefined) ??
      (
        initialSceneRef.current?.schemaVersion === 1 &&
        (!initialSceneRef.current.world?.activeSourceId || initialSceneRef.current.world.activeSourceId === sourceId)
          ? initialSceneRef.current
          : null
      );
    if (viewerApp && sourceId && snapshot && lastRestoredSourceIdRef.current !== sourceId) {
      try {
        viewerApp.loadSceneSnapshot(snapshot);
        lastRestoredSourceIdRef.current = sourceId;
      } catch (restoreError) {
        console.warn("[3d-director] loadSceneSnapshot failed", restoreError);
      }
    }
    if (viewerApp) {
      syncSourceTransformState(constrainSourceTransformForType(
        viewerApp.getSourceTransform(),
        activeSourceType,
      ));
    }
  }, [activeSource?.id, activeSourceId, activeSourceType, syncSourceTransformState]);

  const recordCommand = useCallback((kind: string, payload: Record<string, unknown> = {}) => {
    setCommandLog((prev) => [
      ...prev,
      { kind, at: new Date().toISOString(), ...payload },
    ]);
  }, []);

  // 「保存 3D 世界」:把导演台里摆好的 actor/prop/staging/相机导出成快照写回来源节点。
  const handleSaveScene = useCallback(async () => {
    const viewerApp = viewerRef.current;
    if (!viewerApp || !onSaveScene) return;
    setSceneBusy(true);
    try {
      const sourceId = activeSourceId || activeSource?.id;
      const snapshot = sceneSnapshotForPersistence(viewerApp.exportSceneSnapshot(), sourceId);
      if (sourceId) {
        savedScenesBySourceRef.current = {
          ...savedScenesBySourceRef.current,
          [sourceId]: snapshot,
        };
        lastRestoredSourceIdRef.current = sourceId;
      }
      await onSaveScene(snapshot, sourceId);
      const savedMessage = t("viewer.threeD.statusMessages.sceneSaved");
      setSceneStatus(savedMessage);
      toast.success(savedMessage);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSceneBusy(false);
    }
  }, [activeSource?.id, activeSourceId, onSaveScene, t]);

  useEffect(() => {
    if (!registerSaveSceneHandler || !onSaveScene || manifest.mode === "beat") return;
    registerSaveSceneHandler(handleSaveScene);
    return () => registerSaveSceneHandler(null);
  }, [handleSaveScene, manifest.mode, onSaveScene, registerSaveSceneHandler]);

  const handleClearScene = useCallback(async () => {
    if (!onClearScene) return;
    setSceneBusy(true);
    try {
      const sourceId = activeSourceId || activeSource?.id;
      if (sourceId) {
        const remaining = { ...savedScenesBySourceRef.current };
        delete remaining[sourceId];
        savedScenesBySourceRef.current = remaining;
        lastRestoredSourceIdRef.current = null;
      } else {
        savedScenesBySourceRef.current = {};
      }
      viewerRef.current?.clearMarkers();
      await onClearScene(sourceId);
      setSceneStatus(t("viewer.threeD.statusMessages.sceneCleared"));
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    } finally {
      setSceneBusy(false);
    }
  }, [activeSource?.id, activeSourceId, onClearScene, t]);

  useEffect(() => {
    if (!viewer) return undefined;
    return viewer.onMarkersChange(setCounts);
  }, [viewer]);

  useEffect(() => {
    if (!viewer) return undefined;
    return viewer.onSelectionChange(setSelection);
  }, [viewer]);

  const applyOverlayStatus = useCallback((next: DirectorStageOverlayStatus, requestedBeat?: number) => {
    setOverlayStatus(next);
    const overlay = next.overlay;
    if (overlay?.frame_aspect && FRAME_ASPECTS.includes(overlay.frame_aspect as FrameAspect)) {
      setFrameAspect(overlay.frame_aspect as FrameAspect);
    }
    const snapshot = snapshotFromOverlay(overlay);
    const snapshotSourceId = typeof snapshot?.world?.activeSourceId === "string"
      ? snapshot.world.activeSourceId
      : "";
    const canSelectSnapshotSource = Boolean(
      snapshotSourceId && selectableSourceItems.some((item) => item.id === snapshotSourceId),
    );
    if (snapshot) {
      if (snapshotSourceId) {
        savedScenesBySourceRef.current = {
          ...savedScenesBySourceRef.current,
          [snapshotSourceId]: snapshot,
        };
      }
      if (canSelectSnapshotSource && snapshotSourceId !== activeSourceIdRef.current) {
        setActiveSourceId(snapshotSourceId);
        lastRestoredSourceIdRef.current = null;
      } else {
        const viewerApp = viewerRef.current;
        viewerApp?.loadSceneSnapshot(snapshot);
        if (viewerApp) {
          syncSourceTransformState(constrainSourceTransformForType(
            viewerApp.getSourceTransform(),
            sourceTypeOf(selectableSourceItems.find((item) => item.id === snapshotSourceId) ?? { source_type: activeSourceType }),
          ));
        }
      }
    }
    if (requestedBeat) {
      setSelectedOverlayBeat(String(requestedBeat));
    } else if (overlay?.beat) {
      setSelectedOverlayBeat(String(overlay.beat));
    } else if (next.same_scene_beats.length > 0) {
      setSelectedOverlayBeat(String(next.same_scene_beats[0].beat));
    }
  }, [activeSourceType, selectableSourceItems, syncSourceTransformState]);

  const loadOverlay = useCallback(
    async (beatNumber = manifest.beat_context?.beat) => {
      if (manifest.mode !== "beat" || !beatNumber) return null;
      setOverlayBusy(true);
      try {
        const next = await getBeatDirectorStageOverlay(
          manifest.project,
          manifest.beat_context?.episode ?? 0,
          beatNumber,
        );
        applyOverlayStatus(next, beatNumber);
        return next;
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        return null;
      } finally {
        setOverlayBusy(false);
      }
    },
    [
      applyOverlayStatus,
      manifest.beat_context?.beat,
      manifest.beat_context?.episode,
      manifest.mode,
      manifest.project,
    ],
  );

  useEffect(() => {
    if (!viewer || manifest.mode !== "beat") return;
    void loadOverlay();
  }, [loadOverlay, manifest.mode, viewer]);

  useEffect(() => {
    if (!viewer || sourceReadyRevision === 0 || !overlayStatus?.overlay) return;
    if (overlayAppliedAfterSplatReadyRef.current === sourceReadyRevision) return;
    const snapshot = snapshotFromOverlay(overlayStatus.overlay);
    if (!snapshot) return;
    viewer.loadSceneSnapshot(snapshot);
    syncSourceTransformState(constrainSourceTransformForType(
      viewer.getSourceTransform(),
      activeSourceType,
    ));
    overlayAppliedAfterSplatReadyRef.current = sourceReadyRevision;
  }, [activeSourceType, overlayStatus?.overlay, sourceReadyRevision, syncSourceTransformState, viewer]);

  useEffect(() => {
    viewer?.axesGrid.setVisible(true);
    viewer?.setCollisionVisible(false);
  }, [viewer]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }
      const viewerApp = viewerRef.current;
      if (!viewerApp) return;
      if (!stageActive) return;
      const key = event.key.toLowerCase();
      switch (event.code) {
        case "Slash":
          if (event.shiftKey || event.key === "?") {
            setShortcutsOpen((prev) => !prev);
            break;
          }
          return;
        case "Digit1":
        case "Numpad1":
          cycleActorChoice();
          break;
        case "Digit2":
        case "Numpad2":
          cyclePropChoice();
          break;
        case "Digit3":
        case "Numpad3":
          setToolMode("staging");
          if (viewerApp.cycleSelection("staging")) setStatus(t("viewer.threeD.statusMessages.aiStagingSelected"));
          break;
        case "Digit4":
        case "Numpad4":
          if (!canWriteDirectorBundle) return;
          exportControlFramesRef.current?.();
          break;
        case "KeyP":
          saveDirectorStateRef.current?.();
          break;
        case "Escape":
          if (shortcutsOpen) {
            setShortcutsOpen(false);
            break;
          }
          setStageActive(false);
          viewerApp.clearSelection();
          break;
        case "KeyC":
          viewerApp.selectAtCrosshair();
          break;
        case "KeyF":
          viewerApp.moveSelectedToCrosshair();
          break;
        case "KeyM":
          if (viewerApp.isSelectedMounted()) viewerApp.unmountSelected();
          else viewerApp.mountSelectedAtCrosshair();
          break;
        case "KeyG":
          viewerApp.groundSelected();
          break;
        case "KeyI":
        case "ArrowUp":
          viewerApp.nudgeSelected(0, 0, -KEY_MOVE_STEP);
          break;
        case "KeyK":
        case "ArrowDown":
          viewerApp.nudgeSelected(0, 0, KEY_MOVE_STEP);
          break;
        case "KeyJ":
        case "ArrowLeft":
          viewerApp.nudgeSelected(-KEY_MOVE_STEP, 0, 0);
          break;
        case "KeyL":
        case "ArrowRight":
          viewerApp.nudgeSelected(KEY_MOVE_STEP, 0, 0);
          break;
        case "KeyH":
          setPanelHidden((prev) => !prev);
          break;
        case "Tab":
          setPanelHidden((prev) => !prev);
          break;
        case "KeyU":
          if (!event.shiftKey) {
            viewerApp.nudgeSelected(0, KEY_MOVE_STEP, 0);
          }
          break;
        case "KeyO":
          if (!event.shiftKey) {
            viewerApp.nudgeSelected(0, -KEY_MOVE_STEP, 0);
          }
          break;
        case "KeyB":
          viewerApp.cameraBehindSelected();
          break;
        case "KeyN":
          viewerApp.cameraFaceSelected();
          break;
        case "KeyV":
          viewerApp.lookAtSelected();
          break;
        case "Minus":
          viewerApp.scaleSelected(1 / 1.08);
          break;
        case "Equal":
          viewerApp.scaleSelected(1.08);
          break;
        case "Comma":
          viewerApp.scaleSelected(0.9);
          break;
        case "Period":
          viewerApp.scaleSelected(1.1);
          break;
        case "BracketLeft":
          viewerApp.cycleSelectedPose(-1);
          break;
        case "BracketRight":
          viewerApp.cycleSelectedPose(1);
          break;
        case "KeyR":
          viewerApp.rotateSelected(-15);
          break;
        case "KeyT":
          viewerApp.rotateSelected(15);
          break;
        case "Backspace":
        case "Delete":
        case "KeyX":
          if (event.shiftKey) {
            viewerApp.deleteSelected();
          } else {
            setStatus(t("viewer.threeD.statusMessages.deleteNeedsShift"));
          }
          break;
        default:
          if (key === "1") {
            cycleActorChoice();
            break;
          }
          if (key === "2") {
            cyclePropChoice();
            break;
          }
          if (key === "3") {
            setToolMode("staging");
            if (viewerApp.cycleSelection("staging")) setStatus(t("viewer.threeD.statusMessages.aiStagingSelected"));
            break;
          }
          if (key === "4") {
            if (!canWriteDirectorBundle) return;
            exportControlFramesRef.current?.();
            break;
          }
          if (key === "p") {
            saveDirectorStateRef.current?.();
            break;
          }
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [activeSourceType, canWriteDirectorBundle, cycleActorChoice, cyclePropChoice, shortcutsOpen, stageActive, t]);

  const placeActor = useCallback(() => {
    if (!activeActor) return;
    // beat 模式颜色与身份绑定(截图按色回收 identity),保持 palette 色;
    // 匿名/场景模式用用户选的 actorColor。
    const color = manifest.mode === "beat" ? activeActor.color : actorColor;
    const placed = viewerRef.current?.placeMarker("actor", {
      color,
      label: activeActor.label,
      scale: actorScale,
    }) ?? false;
    if (placed && manifest.mode !== "beat") {
      setAnonymousSequence((prev) => ({ ...prev, actor: prev.actor + 1 }));
    }
    recordCommand("place_actor", { label: activeActor.label });
  }, [activeActor, actorColor, actorScale, manifest.mode, recordCommand]);

  const placeProp = useCallback(() => {
    if (!activeProp) return;
    const color = manifest.mode === "beat" ? activeProp.color : propLikeColor;
    const placed = viewerRef.current?.placeMarker("prop", {
      color,
      label: activeProp.label,
    }) ?? false;
    if (placed && manifest.mode !== "beat") {
      setAnonymousSequence((prev) => ({ ...prev, prop: prev.prop + 1 }));
    }
    recordCommand("place_prop", { label: activeProp.label });
  }, [activeProp, manifest.mode, propLikeColor, recordCommand]);

  const placeStaging = useCallback(() => {
    const label = trimmedStagingName;
    if (!label) return;
    const placed = viewerRef.current?.placeMarker("staging", {
      color: propLikeColor,
      label,
    }) ?? false;
    if (placed) {
      setAnonymousSequence((prev) => ({ ...prev, prop: prev.prop + 1 }));
    }
    recordCommand("place_staging");
  }, [propLikeColor, recordCommand, trimmedStagingName]);

  const createAiStaging = useCallback(async () => {
    const viewerApp = viewerRef.current;
    if (!viewerApp || aiStagingBusy) return;
    const hint = trimmedStagingName;
    if (!hint) return;
    setAiStagingBusy(true);
    setError(null);
    try {
      let payload: Record<string, unknown> | null = null;
      try {
        const generated = await generateAiStagingProp(manifest.project, {
          scene_id: manifest.scene_id,
          display_name: manifest.display_name,
          user_hint: hint,
          beat_context: manifest.beat_context ?? null,
          crosshair_target: viewerApp.getCrosshairTarget(),
          state: sceneSnapshotForPersistence(viewerApp.exportSceneSnapshot(), activeSceneSourceId),
          renderer_backend: "playcanvas_3gs",
        });
        payload = (generated.prop ?? null) as Record<string, unknown> | null;
      } catch (aiError) {
        setError(aiError instanceof Error ? aiError.message : String(aiError));
        return;
      }
      const name = String(payload?.name ?? payload?.prop_id ?? hint);
      const color = propLikeColor;
      const shapeHint = typeof payload?.shape_hint === "string"
        ? payload.shape_hint
        : typeof payload?.shapeHint === "string"
          ? payload.shapeHint
          : undefined;
      const normalizedShapeHint = shapeHint && (SHAPE_HINT_NAMES as string[]).includes(shapeHint)
        ? shapeHint as ShapeHintName
        : undefined;
      const scaleValue = payload?.scale;
      const scale = Array.isArray(scaleValue)
        ? numberTuple3(scaleValue, [1, 0.6, 1])
        : typeof scaleValue === "number" && Number.isFinite(scaleValue)
          ? scaleValue
          : 1;
      const position = Array.isArray(payload?.position)
        ? numberTuple3(payload.position, [0, 0, 0])
        : undefined;
      const placed = viewerApp.placeMarker("staging", {
        color,
        label: name,
        scale,
        ...(normalizedShapeHint ? { shapeHint: normalizedShapeHint } : {}),
        ...(position ? { position } : {}),
      });
      if (placed) {
        setAnonymousSequence((prev) => ({ ...prev, prop: prev.prop + 1 }));
        setToolMode("staging");
        setStagingName(name);
        recordCommand("ai_staging", {
          hint: hint.trim(),
          name,
          source: payload ? "buildergpt_ai_staging" : "local_fallback",
        });
      }
    } finally {
      setAiStagingBusy(false);
    }
  }, [
    aiStagingBusy,
    activeSceneSourceId,
    manifest.beat_context,
    manifest.display_name,
    manifest.scene_id,
    propLikeColor,
    trimmedStagingName,
    recordCommand,
    t,
  ]);

  const placeCurrentTool = useCallback(() => {
    if (toolMode === "actor") placeActor();
    else if (toolMode === "prop") placeProp();
    else void createAiStaging();
  }, [createAiStaging, placeActor, placeProp, toolMode]);

  const captureFrameOptions = useCallback((options?: { directorBundle?: boolean }) => ({
    frameAspect,
    frameRectCss: frameGuideRef.current?.getBoundingClientRect(),
    ...(options?.directorBundle ? { maxLongEdge: DIRECTOR_CONTROL_FRAME_MAX_LONG_EDGE } : {}),
  }), [frameAspect]);

  const capture = useCallback(
    async (kind: CaptureKind, destination: CaptureDestination) => {
      const viewerApp = viewerRef.current;
      if (!viewerApp) return;
      setCaptureBusy(kind);
      try {
        const directorBundleCapture = destination === "director_combined";
        const dataUrl = viewerApp.captureScreenshot({
          renderMode: kind,
          ...captureFrameOptions({ directorBundle: directorBundleCapture }),
        });
        if (!dataUrl) {
          setError(t("viewer.threeD.captureFailed"));
          return;
        }
        if (destination === "download") {
          triggerDownload(dataUrl, captureFilename(manifest, kind));
          recordCommand("download_render", { render_mode: kind });
          return;
        }
        const blob = await dataUrlToBlob(dataUrl);
        const snapshot = sceneSnapshotForPersistence(viewerApp.exportSceneSnapshot(), activeSceneSourceId);
        const captureSource: ThreeDDirectorCaptureMeta["source"] = {
          ...manifest.source,
          source_type: activeSourceType,
          ply_url: activeSplatUrl ?? undefined,
          url: activeSourceUrl ?? undefined,
          pano_url: activeSourceType === "pano360" ? activeSourceUrl ?? undefined : manifest.source.pano_url,
          source_kind: activeSourceKind,
        };
        const meta: ThreeDDirectorCaptureMeta = {
          kind,
          snapshot,
          source: captureSource,
        };
        if (destination === "selected_background") {
          if (manifest.mode === "beat" && manifest.beat_context) {
            const frameMeta = frameMetaFromSnapshot({
              source: activeFrameSource,
              frameAspect,
              snapshot,
              beatContext: manifest.beat_context,
              cameraMode: activeSourceType === "pano360" ? "pano" : "sog",
            });
            const richOverlay = richOverlayFromSnapshot(snapshot, manifest);
            const overlayStatus = await saveBeatDirectorStageOverlay(
              manifest.project,
              manifest.beat_context.episode,
              manifest.beat_context.beat,
              {
                frame_aspect: frameAspect,
                source: activeFrameSource,
                frame_meta: frameMeta,
                snapshot,
                ...richOverlay,
                command_log: [
                  ...commandLog,
                  {
                    kind: "capture_selected_background",
                    at: new Date().toISOString(),
                    source: "react_three_d_director_dialog",
                  },
                ],
                deleted_keys: [],
              },
            );
            applyOverlayStatus(overlayStatus);
          }
          if (!onCaptureSelectedBackground) return;
          await onCaptureSelectedBackground(blob, meta);
          return;
        }
        const combinedDataUrl = kind === "combined"
          ? dataUrl
          : viewerApp.captureScreenshot({
              renderMode: "combined",
              ...captureFrameOptions({ directorBundle: directorBundleCapture }),
            });
        const envOnlyDataUrl = kind === "env_only"
          ? dataUrl
          : viewerApp.captureScreenshot({
              renderMode: "env_only",
              ...captureFrameOptions({ directorBundle: directorBundleCapture }),
            });
        if (!combinedDataUrl || !envOnlyDataUrl) {
          setError(t("viewer.threeD.captureFailed"));
          return;
        }
        const combinedBlob = kind === "combined" ? blob : await dataUrlToBlob(combinedDataUrl);
        const envOnlyBlob = kind === "env_only" ? blob : await dataUrlToBlob(envOnlyDataUrl);
        meta.captureBundle = {
          combined: combinedBlob,
          env_only: envOnlyBlob,
          frame_meta: frameMetaFromSnapshot({
            source: activeFrameSource,
            frameAspect,
            snapshot,
            beatContext: manifest.beat_context,
            cameraMode: activeSourceType === "pano360" ? "pano" : "sog",
          }),
        };
        if (destination === "director_combined" && manifest.mode === "beat" && manifest.beat_context && canWriteDirectorBundle) {
          const richOverlay = richOverlayFromSnapshot(snapshot, manifest);
          const overlayStatus = await saveBeatDirectorStageOverlay(
            manifest.project,
            manifest.beat_context.episode,
            manifest.beat_context.beat,
            {
              frame_aspect: frameAspect,
              source: activeFrameSource,
              frame_meta: meta.captureBundle.frame_meta,
              snapshot,
              ...richOverlay,
              command_log: [
                ...commandLog,
                {
                    kind: "submit_director_combined",
                  at: new Date().toISOString(),
                  source: "react_three_d_director_dialog",
                },
              ],
              deleted_keys: [],
            },
          );
          applyOverlayStatus(overlayStatus);
          const result = await saveBeatDirectorControlFrame(
            manifest.project,
            manifest.beat_context.episode,
            manifest.beat_context.beat,
            {
              frame_aspect: frameAspect,
              source: activeFrameSource,
              frame_meta: meta.captureBundle.frame_meta,
              images: {
                combined: combinedDataUrl,
                env_only: envOnlyDataUrl,
              },
              snapshot,
              ...richOverlay,
            },
          );
          meta.controlFrameUrl = result.urls?.combined;
          meta.controlFrameRelPath = result.rel_paths.combined;
          meta.controlFrameBundle = {
            schema_version: "director_control_bundle_v1",
            dir: result.dir,
            paths: result.paths,
            rel_paths: result.rel_paths,
            urls: result.urls,
            source: activeFrameSource,
            frame_meta: meta.captureBundle.frame_meta,
          };
        }
        if (destination === "director_combined") {
          if (!onSubmitDirectorCombined) return;
          await onSubmitDirectorCombined(combinedBlob, meta);
          return;
        }
        if (!onCaptureCanvasNode) return;
        await onCaptureCanvasNode(combinedBlob, meta);
      } catch (captureError) {
        setError(captureError instanceof Error ? captureError.message : String(captureError));
      } finally {
        setCaptureBusy(null);
      }
    },
    [
      activeFrameSource,
      activeSceneSourceId,
      activeSourceKind,
      activeSourceType,
      activeSourceUrl,
      activeSplatUrl,
      applyOverlayStatus,
      canWriteDirectorBundle,
      commandLog,
      captureFrameOptions,
      frameAspect,
      manifest,
      onCaptureCanvasNode,
      onCaptureSelectedBackground,
      onSubmitDirectorCombined,
      recordCommand,
      t,
    ],
  );

  const exportControlFrames = useCallback(async () => {
    if (!canWriteDirectorBundle) return;
    if (manifest.mode !== "beat" || !manifest.beat_context) return;
    const viewerApp = viewerRef.current;
    if (!viewerApp) return;
    setCaptureBusy("combined");
    setExportStatus(t("viewer.threeD.exportControlFrameStarting"));
    try {
      const combined = viewerApp.captureScreenshot({
        renderMode: "combined",
        ...captureFrameOptions({ directorBundle: true }),
      });
      const envOnly = viewerApp.captureScreenshot({
        renderMode: "env_only",
        ...captureFrameOptions({ directorBundle: true }),
      });
      if (!combined || !envOnly) {
        setError(t("viewer.threeD.captureFailed"));
        return;
      }
      const snapshot = sceneSnapshotForPersistence(viewerApp.exportSceneSnapshot(), activeSceneSourceId);
      const richOverlay = richOverlayFromSnapshot(snapshot, manifest);
      const frameMeta = frameMetaFromSnapshot({
        source: activeFrameSource,
        frameAspect,
        snapshot,
        beatContext: manifest.beat_context,
        cameraMode: activeSourceType === "pano360" ? "pano" : "sog",
      });
      const overlayStatus = await saveBeatDirectorStageOverlay(
        manifest.project,
        manifest.beat_context.episode,
        manifest.beat_context.beat,
        {
          frame_aspect: frameAspect,
          source: activeFrameSource,
          frame_meta: frameMeta,
          snapshot,
          ...richOverlay,
          command_log: [
            ...commandLog,
            {
              kind: "export_control_frames",
              at: new Date().toISOString(),
              source: "react_three_d_director_dialog",
            },
          ],
          deleted_keys: [],
        },
      );
      applyOverlayStatus(overlayStatus);
      const result = await saveBeatDirectorControlFrame(
        manifest.project,
        manifest.beat_context.episode,
        manifest.beat_context.beat,
        {
          frame_aspect: frameAspect,
          source: activeFrameSource,
          frame_meta: frameMeta,
          images: {
            combined,
            env_only: envOnly,
          },
          snapshot,
          ...richOverlay,
        },
      );
      setExportStatus(t("viewer.threeD.exportControlFrameSuccess", {
        path: result.rel_paths.combined ?? result.dir,
      }));
      recordCommand("export_control_frames", { dir: result.dir });
      if (onSubmitDirectorCombined) {
        const combinedBlob = await dataUrlToBlob(combined);
        const envOnlyBlob = await dataUrlToBlob(envOnly);
        await onSubmitDirectorCombined(combinedBlob, {
          kind: "combined",
          snapshot,
          source: {
            ...manifest.source,
            source_type: activeSourceType,
            ply_url: activeSplatUrl ?? undefined,
            url: activeSourceUrl ?? undefined,
            pano_url: activeSourceType === "pano360" ? activeSourceUrl ?? undefined : manifest.source.pano_url,
            source_kind: activeSourceKind,
          },
          controlFrameUrl: result.urls?.combined,
          controlFrameRelPath: result.rel_paths.combined,
          controlFrameBundle: {
            schema_version: "director_control_bundle_v1",
            dir: result.dir,
            paths: result.paths,
            rel_paths: result.rel_paths,
            urls: result.urls,
            source: activeFrameSource,
            frame_meta: frameMeta,
          },
          captureBundle: {
            combined: combinedBlob,
            env_only: envOnlyBlob,
            frame_meta: frameMeta,
          },
        });
      }
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setCaptureBusy(null);
    }
  }, [activeFrameSource, activeSceneSourceId, activeSourceKind, activeSourceType, activeSourceUrl, activeSplatUrl, applyOverlayStatus, canWriteDirectorBundle, captureFrameOptions, commandLog, frameAspect, manifest, onSubmitDirectorCombined, recordCommand, t]);

  useEffect(() => {
    exportControlFramesRef.current = () => {
      void exportControlFrames();
    };
    return () => {
      exportControlFramesRef.current = null;
    };
  }, [exportControlFrames]);

  const selectedKind = selection?.kind ?? null;
  const selectedKindLabel = selectedKind
    ? t(`viewer.threeD.markerKinds.${selectedKind}`, { defaultValue: selectedKind })
    : null;
  const selectedPoseLabel = selection?.pose ? t(POSE_LABEL_KEYS[selection.pose]) : "";
  const selectedPositionLabel = selection
    ? `(${selection.position.map((value) => value.toFixed(2)).join(", ")})`
    : "";
  const sourceOptionLabel = useCallback((item: NormalizedDirectorSource) => {
    const rawLabel = item.label.trim();
    const kindLabel = t(`viewer.threeD.sourceKinds.${item.kind}`, { defaultValue: item.kind });
    const baseLabel = rawLabel && !isDefaultSourceLabel(rawLabel, item.kind) ? rawLabel : kindLabel;
    return `${baseLabel}${sourceTypeOf(item) === "pano360" ? ` · ${t("viewer.threeD.panoSuffix")}` : ""}`;
  }, [t]);
  const resetCamera = useCallback(() => {
    const viewerApp = viewerRef.current;
    if (!viewerApp) {
      return;
    }
    viewerApp.resetCamera();
    setStatus(t("viewer.threeD.resetCamera"));
  }, [t]);
  const updateSourceTransform = useCallback((patch: Partial<DirectorWorldSourceTransform>) => {
    const next = constrainSourceTransformForType(
      {
        ...sourceTransformStateRef.current,
        ...patch,
      },
      activeSourceType,
    );
    syncSourceTransformState(next);
    viewerRef.current?.setSourceTransform(next);
  }, [activeSourceType, syncSourceTransformState]);
  const resetSourceTransform = useCallback(() => {
    const next = constrainSourceTransformForType(
      DEFAULT_DIRECTOR_WORLD_SOURCE_TRANSFORM,
      activeSourceType,
    );
    syncSourceTransformState(next);
    viewerRef.current?.setSourceTransform(next);
    setStatus(t("viewer.threeD.sourceCalibration.resetStatus"));
  }, [activeSourceType, syncSourceTransformState, t]);

  const saveOverlay = useCallback(async () => {
    if (manifest.mode !== "beat" || !manifest.beat_context) return;
    const viewerApp = viewerRef.current;
    if (!viewerApp) return;
    setOverlayBusy(true);
    try {
      const snapshot = sceneSnapshotForPersistence(viewerApp.exportSceneSnapshot(), activeSceneSourceId);
      const richOverlay = richOverlayFromSnapshot(snapshot, manifest);
      const frameMeta = frameMetaFromSnapshot({
        source: activeFrameSource,
        frameAspect,
        snapshot,
        beatContext: manifest.beat_context,
        cameraMode: activeSourceType === "pano360" ? "pano" : "sog",
      });
      const next = await saveBeatDirectorStageOverlay(
        manifest.project,
        manifest.beat_context.episode,
        manifest.beat_context.beat,
        {
          frame_aspect: frameAspect,
          source: activeFrameSource,
          frame_meta: frameMeta,
          snapshot,
          ...richOverlay,
          command_log: [
            ...commandLog,
            {
              kind: "save_overlay",
              at: new Date().toISOString(),
              source: "react_three_d_director_dialog",
            },
          ],
          deleted_keys: [],
        },
      );
      recordCommand("save_overlay");
      applyOverlayStatus(next);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setOverlayBusy(false);
    }
  }, [activeFrameSource, activeSceneSourceId, activeSourceType, applyOverlayStatus, commandLog, frameAspect, manifest, recordCommand]);

  useEffect(() => {
    saveDirectorStateRef.current = () => {
      if (manifest.mode === "beat") {
        void saveOverlay();
        return;
      }
      void handleSaveScene();
    };
    return () => {
      saveDirectorStateRef.current = null;
    };
  }, [handleSaveScene, manifest.mode, saveOverlay]);

  const copySelectedOverlay = useCallback(async () => {
    if (!manifest.beat_context) return;
    const sourceBeatNumber = Number(selectedOverlayBeat);
    const targetBeatNumber = manifest.beat_context.beat;
    if (!Number.isFinite(sourceBeatNumber) || !Number.isFinite(targetBeatNumber)) return;
    setOverlayBusy(true);
    try {
      const loaded = await getBeatDirectorStageOverlay(
        manifest.project,
        manifest.beat_context.episode,
        sourceBeatNumber,
      );
      const snapshot = snapshotFromOverlay(loaded?.overlay ?? null);
      if (!snapshot) return;
      const nextSnapshot = sceneSnapshotForPersistence(
        snapshot,
        snapshot.world?.activeSourceId ?? activeSceneSourceId,
      );
      const copiedSource = objectRecord(loaded?.overlay?.source);
      const overlaySource = typeof copiedSource.source_id === "string"
        ? copiedSource as unknown as DirectorFrameMeta["source"]
        : activeFrameSource;
      const copiedFrameAspect = FRAME_ASPECTS.includes(loaded?.overlay?.frame_aspect as FrameAspect)
        ? loaded?.overlay?.frame_aspect as FrameAspect
        : frameAspect;
      const richOverlay = richOverlayFromSnapshot(nextSnapshot, manifest);
      const frameMeta = frameMetaFromSnapshot({
        source: overlaySource,
        frameAspect: copiedFrameAspect,
        snapshot: nextSnapshot,
        beatContext: manifest.beat_context,
        cameraMode: overlaySource.source_type === "pano360" ? "pano" : "sog",
      });
      const next = await saveBeatDirectorStageOverlay(
        manifest.project,
        manifest.beat_context.episode,
        targetBeatNumber,
        {
          episode: manifest.beat_context.episode,
          beat: targetBeatNumber,
          frame_aspect: copiedFrameAspect,
          source: overlaySource,
          frame_meta: frameMeta,
          snapshot: nextSnapshot,
          ...richOverlay,
          command_log: [
            ...commandLog,
            {
              kind: "copy_overlay",
              source_beat: sourceBeatNumber,
              target_beat: targetBeatNumber,
              at: new Date().toISOString(),
              source: "react_three_d_director_dialog",
            },
          ],
          deleted_keys: [],
        },
      );
      recordCommand("copy_overlay", {
        source_beat: sourceBeatNumber,
        target_beat: targetBeatNumber,
      });
      applyOverlayStatus(next, targetBeatNumber);
      setStatus(t("viewer.threeD.beatOverlay.copySelectedSuccess", {
        sourceBeat: sourceBeatNumber,
        targetBeat: targetBeatNumber,
      }));
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError));
    } finally {
      setOverlayBusy(false);
    }
  }, [
    applyOverlayStatus,
    activeFrameSource,
    activeSceneSourceId,
    commandLog,
    frameAspect,
    manifest.beat_context,
    manifest.project,
    manifest,
    recordCommand,
    selectedOverlayBeat,
    t,
  ]);

  const stageToolbarGlassButtonClass =
    "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-[8px] bg-black/45 px-2.5 text-[12px] font-normal text-white/64 backdrop-blur-md transition-colors hover:bg-black/62 hover:text-white";

  return (
    <div
      className={cn(
        "grid h-full min-h-0 bg-transparent text-[#f4f4f5]",
        panelHidden ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[320px_minmax(0,1fr)]",
      )}
    >
      {!panelHidden && (
        <aside className="min-h-0 overflow-y-auto border-r border-white/[0.08] bg-[#191a1f]/94 px-4 pb-4 pt-0 text-[12px] backdrop-blur-sm">
          <div className="sticky top-0 z-20 -mx-4 mb-2 flex items-center justify-between gap-3 bg-[#191a1f]/58 px-4 pb-3 pt-5 backdrop-blur-xl">
            <div className="min-w-0">
              <div
                data-testid="director-world-panel-title"
                className="truncate text-[15px] font-semibold leading-5 text-white"
              >
                {t("viewer.threeD.directorWorld")}
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label={t("viewer.threeD.close")}
              className="h-6 w-6 shrink-0 rounded-full !bg-white/[0.10] text-white/56 transition-colors hover:!bg-white/[0.13] hover:text-white/72"
            >
              <X className="size-3" />
            </Button>
          </div>

          <PanelSection title={t("viewer.threeD.sections.stage")}>
            <div className="grid grid-cols-2 gap-2">
              <SelectField
                label={t("viewer.threeD.sourcePickerLabel")}
                value={activeSourceId}
                onChange={setActiveSourceId}
              >
                {selectableSourceItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {sourceOptionLabel(item)}
                  </option>
                ))}
              </SelectField>
              <SelectField label={t("viewer.threeD.frameAspect")} value={frameAspect} onChange={(next) => setFrameAspect(next as FrameAspect)}>
                {FRAME_ASPECTS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </SelectField>
            </div>
          </PanelSection>

        <PanelSection title={t("viewer.threeD.sourceCalibration.title")}>
          <p className="text-[11px] leading-[1.7] text-white/42">
            {activeSourceType === "pano360"
              ? t("viewer.threeD.sourceCalibration.panoHint")
              : t("viewer.threeD.sourceCalibration.sogHint")}
          </p>
          <div className="mt-3">
            <SourceDirectionBall
              ariaLabel={t("viewer.threeD.sourceCalibration.directionBall")}
              ariaValueText={t("viewer.threeD.sourceCalibration.directionValue", {
                yaw: Math.round(sourceTransformState.yawDeg),
                pitch: Math.round(sourceTransformState.pitchDeg),
              })}
              yawDeg={sourceTransformState.yawDeg}
              pitchDeg={sourceTransformState.pitchDeg}
              onChange={(next) => updateSourceTransform(next)}
            />
          </div>
          <div className="mt-3 space-y-2">
            <RangeField
              label={t("viewer.threeD.sourceCalibration.roll", { value: sourceTransformState.rollDeg.toFixed(0) })}
              min={-180}
              max={180}
              step={1}
              value={sourceTransformState.rollDeg}
              onChange={(rollDeg) => updateSourceTransform({ rollDeg })}
            />
          </div>
          <div className="mt-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 w-full justify-between rounded-[10px] pl-0 pr-3 text-[12px] text-white/72 hover:bg-white/[0.04] hover:text-white"
              onClick={() => setSourceCalibrationAdvancedOpen((prev) => !prev)}
            >
              {t("viewer.threeD.sourceCalibration.advanced")}
              <span className="text-[11px] text-white/44">
                {sourceCalibrationAdvancedOpen
                  ? t("viewer.threeD.sourceCalibration.collapse")
                  : t("viewer.threeD.sourceCalibration.expand")}
              </span>
            </Button>
            {sourceCalibrationAdvancedOpen && (
              <div className="mt-3 space-y-3 rounded-[12px] border border-white/[0.08] bg-black/20 p-3">
                <RangeField
                  label={t("viewer.threeD.sourceCalibration.xOffset", { value: sourceTransformState.xOffset.toFixed(1) })}
                  min={sourceCalibrationRanges.offsetMin}
                  max={sourceCalibrationRanges.offsetMax}
                  step={sourceCalibrationRanges.offsetStep}
                  value={sourceTransformState.xOffset}
                  onChange={(xOffset) => updateSourceTransform({ xOffset })}
                />
                <RangeField
                  label={t("viewer.threeD.sourceCalibration.yOffset", { value: sourceTransformState.yOffset.toFixed(1) })}
                  min={sourceCalibrationRanges.offsetMin}
                  max={sourceCalibrationRanges.offsetMax}
                  step={sourceCalibrationRanges.offsetStep}
                  value={sourceTransformState.yOffset}
                  onChange={(yOffset) => updateSourceTransform({ yOffset })}
                />
                <RangeField
                  label={t("viewer.threeD.sourceCalibration.zOffset", { value: sourceTransformState.zOffset.toFixed(1) })}
                  min={sourceCalibrationRanges.offsetMin}
                  max={sourceCalibrationRanges.offsetMax}
                  step={sourceCalibrationRanges.offsetStep}
                  value={sourceTransformState.zOffset}
                  onChange={(zOffset) => updateSourceTransform({ zOffset })}
                />
                <RangeField
                  label={t("viewer.threeD.sourceCalibration.scale", { value: sourceTransformState.scale.toFixed(2) })}
                  min={sourceCalibrationRanges.scaleMin}
                  max={sourceCalibrationRanges.scaleMax}
                  step={sourceCalibrationRanges.scaleStep}
                  value={sourceTransformState.scale}
                  onChange={(scale) => updateSourceTransform({ scale })}
                />
              </div>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3 h-8 w-full rounded-[10px] !border-white/[0.10] !bg-[#242426]/68 text-[12px] !text-white/68 shadow-none hover:!border-white/[0.16] hover:!bg-[#2b2b2d]/78 hover:!text-white"
            onClick={resetSourceTransform}
            disabled={!viewer}
          >
            <RotateCcw className="size-3.5" />
            {t("viewer.threeD.sourceCalibration.reset")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2 h-8 w-full rounded-[10px] !border-white/[0.10] !bg-[#242426]/68 text-[12px] !text-white/68 shadow-none hover:!border-white/[0.16] hover:!bg-[#2b2b2d]/78 hover:!text-white"
            onClick={resetCamera}
            disabled={!viewer}
          >
            <RotateCcw className="size-3.5" />
            {t("viewer.threeD.resetCamera")}
          </Button>
        </PanelSection>

        <PanelSection title={t("viewer.threeD.sections.add")}>
          <div className="rounded-[12px] border border-white/[0.08] bg-black/20 px-3 py-2 text-[12px] text-white/54">
            {t("viewer.threeD.currentCreate", {
              type: toolMode === "actor" ? t("viewer.threeD.actor") : toolMode === "prop" ? t("viewer.threeD.prop") : t("viewer.threeD.staging"),
            })}
          </div>
          {toolMode === "actor" && (
            <div className="mt-3 space-y-2">
              {manifest.mode === "beat" ? (
                <>
                  <SelectField label={t("viewer.threeD.actorIdentity")} value={actorId} onChange={setActorId} disabled={actorChoices.length === 0}>
                    {actorChoices.map((item) => (
                      <option key={item.identity_id} value={item.identity_id}>
                        {item.label}
                      </option>
                    ))}
                  </SelectField>
                  {actorChoices.length === 0 && (
                    <p className="text-[12px] leading-5 text-white/54">
                      {t("viewer.threeD.noBeatActorPalette")}
                    </p>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-between gap-2 rounded-[12px] border border-white/[0.08] bg-black/20 px-3 py-2 text-[12px] text-white/58">
                  <span>{t("viewer.threeD.nextAnonymousActor", { label: activeActor?.label, color: actorColor })}</span>
                  <span className="h-4 w-4 shrink-0 rounded-full border border-white/20" style={{ backgroundColor: actorColor }} />
                </div>
              )}
              {manifest.mode !== "beat" && (
                <ColorPaletteField
                  label={t("viewer.threeD.actorColor", { defaultValue: "人物颜色" })}
                  value={actorColor}
                  palette={anonymousActorPalette}
                  onChange={setActorColor}
                />
              )}
              <RangeField
                label={t("viewer.threeD.scale", { value: actorScale.toFixed(2) })}
                min={0.4}
                max={2.4}
                step={0.05}
                value={actorScale}
                onChange={setActorScale}
              />
              <SelectField
                label={t("viewer.threeD.actorPose")}
                value={selection?.kind === "actor" ? selection.pose ?? "standing" : "standing"}
                onChange={(next) => viewer?.setSelectedPose(next as PoseName)}
                disabled={selection?.kind !== "actor"}
              >
                {POSES.map((pose) => (
                  <option key={pose} value={pose}>
                    {t(POSE_LABEL_KEYS[pose])}
                  </option>
                ))}
              </SelectField>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={selection?.kind === "actor" && selection.actionPlaying === false ? "default" : "outline"}
                  onClick={() => viewer?.setSelectedActionPlaying(false)}
                  disabled={selection?.kind !== "actor"}
                >
                  <Pause className="size-3.5" />
                  {t("viewer.threeD.pauseAction")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={selection?.kind === "actor" && selection.actionPlaying !== false ? "default" : "outline"}
                  onClick={() => viewer?.setSelectedActionPlaying(true)}
                  disabled={selection?.kind !== "actor"}
                >
                  <Play className="size-3.5" />
                  {t("viewer.threeD.runAction")}
                </Button>
              </div>
            </div>
          )}
          {toolMode === "prop" && (
            <div className="mt-3 space-y-2">
              {manifest.mode === "beat" ? (
                <>
                  <SelectField label={t("viewer.threeD.prop")} value={propId} onChange={setPropId} disabled={propChoices.length === 0}>
                    {propChoices.map((item) => (
                      <option key={item.prop_id} value={item.prop_id}>
                        {item.label}
                      </option>
                    ))}
                  </SelectField>
                  {propChoices.length === 0 && (
                    <p className="text-[12px] leading-5 text-white/54">
                      {t("viewer.threeD.noBeatPropPalette")}
                    </p>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-between gap-2 rounded-[12px] border border-white/[0.08] bg-black/20 px-3 py-2 text-[12px] text-white/58">
                  <span>{t("viewer.threeD.nextAnonymousProp", { label: activeProp?.label, color: propLikeColor })}</span>
                  <span className="h-4 w-4 shrink-0 rounded-full border border-white/20" style={{ backgroundColor: propLikeColor }} />
                </div>
              )}
              {manifest.mode !== "beat" && (
                <ColorPaletteField
                  label={t("viewer.threeD.propColor")}
                  value={propLikeColor}
                  palette={anonymousPropPalette}
                  onChange={setPropLikeColor}
                />
              )}
            </div>
          )}
          {toolMode === "staging" && (
            <div className="mt-3 space-y-2">
              <ColorPaletteField
                label={t("viewer.threeD.stagingColor")}
                value={propLikeColor}
                palette={anonymousPropPalette}
                onChange={setPropLikeColor}
              />
              <label className="block text-[12px] font-medium text-white/56">
                {t("viewer.threeD.stagingName")}
                <input
                  value={stagingName}
                  onChange={(event) => setStagingName(event.target.value)}
                  className="mt-1.5 h-9 w-full rounded-[10px] border border-white/[0.10] bg-black/25 px-3 text-[12px] text-white outline-none transition-colors focus:border-white/22"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={createAiStaging}
                  disabled={!viewer || aiStagingBusy || !trimmedStagingName}
                >
                  {aiStagingBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Move3D className="size-3.5" />}
                  {t("viewer.threeD.aiPlaceholder")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={placeStaging}
                  disabled={!viewer || !trimmedStagingName}
                >
                  {t("viewer.threeD.localPlaceholder")}
                </Button>
              </div>
            </div>
          )}
          <Button
            type="button"
            size="sm"
            className="mt-3 h-9 w-full rounded-[10px] text-[12px]"
            onClick={placeCurrentTool}
            disabled={!viewer || (toolMode === "actor" && !activeActor) || (toolMode === "prop" && !activeProp) || (toolMode === "staging" && !trimmedStagingName)}
          >
            {t("viewer.threeD.placeAtCrosshair")}
          </Button>
        </PanelSection>

        <PanelSection title={t("viewer.threeD.sections.selection")}>
          <div className="rounded-[12px] border border-white/[0.08] bg-black/20 px-3 py-2 text-[12px] leading-5 text-white/58">
            {selection && selectedKindLabel
              ? `${selectedKindLabel} · ${selection.label} · ${selectedPositionLabel}${selectedPoseLabel ? ` · ${selectedPoseLabel}` : ""}${selection.mounted ? ` · ${t("viewer.threeD.mountedSuffix")}` : ""}`
              : t("viewer.threeD.noSelection")}
          </div>
          {selection?.kind === "staging" && (
            <SelectField
              label={t("viewer.threeD.stagingShapeHint")}
              value={selection.shapeHint ?? "generic_large"}
              onChange={(next) => viewer?.setSelectedShapeHint(next as ShapeHintName)}
            >
              {SHAPE_HINT_NAMES.map((hint) => (
                <option key={hint} value={hint}>
                  {t(`viewer.threeD.shapeHints.${hint}`, { defaultValue: hint })}
                </option>
              ))}
            </SelectField>
          )}
          {selection?.kind === "staging" && (
            <label className="mt-2 block text-[12px] font-medium text-white/56">
              {t("viewer.threeD.selectedStagingName")}
              <input
                key={`${selection.kind}:${selection.index}`}
                defaultValue={selection.label}
                onChange={(event) => viewer?.setSelectedLabel(event.target.value)}
                className="mt-1.5 h-9 w-full rounded-[10px] border border-white/[0.10] bg-black/25 px-3 text-[12px] text-white outline-none transition-colors focus:border-white/22"
              />
            </label>
          )}
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-9 w-full rounded-[10px] !border-white/[0.10] !bg-[#242426]/62 text-[12px] !text-white/68 shadow-none hover:!border-white/[0.16] hover:!bg-[#2b2b2d]/76 hover:!text-white"
            onClick={() => {
              if (!viewer) return;
              if (selection?.mounted) viewer.unmountSelected();
              else viewer.mountSelectedAtCrosshair();
            }}
            disabled={selection?.kind !== "actor"}
          >
            {selection?.mounted ? t("viewer.threeD.unmountSelected") : t("viewer.threeD.mountSelected")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-9 w-full rounded-[10px] !border-red-400/18 !bg-red-500/[0.07] text-[12px] !text-red-200/72 shadow-none hover:!border-red-300/30 hover:!bg-red-500/[0.11] hover:!text-red-100"
            onClick={() => viewer?.deleteSelected()}
            disabled={!selection}
          >
            <Trash2 className="size-3.5" />
            {t("viewer.threeD.deleteSelected")}
          </Button>
        </PanelSection>

        {manifest.mode === "beat" && (
          <PanelSection title={t("viewer.threeD.beatOverlay.title")}>
            {manifest.beat_context?.beat ? (
              <div className="mb-2 rounded-[12px] border border-white/[0.08] bg-black/20 px-3 py-2 text-[12px] leading-5 text-white/58">
                {t("viewer.threeD.beatOverlay.currentBeat", { beat: manifest.beat_context.beat })}
              </div>
            ) : null}
            {overlayStatus?.inherited_from_beat ? (
              <div className="rounded-[12px] border border-white/[0.08] bg-black/20 px-3 py-2 text-[12px] leading-5 text-white/58">
                {t("viewer.threeD.beatOverlay.inheritedFromBeat", { beat: overlayStatus.inherited_from_beat })}
              </div>
            ) : null}
            <SelectField
              label={t("viewer.threeD.beatOverlay.sameSceneBeats")}
              value={selectedOverlayBeat}
              onChange={(next) => {
                setSelectedOverlayBeat(next);
                const beatNumber = Number(next);
                if (Number.isFinite(beatNumber)) void loadOverlay(beatNumber);
              }}
              disabled={!overlayStatus?.same_scene_beats.length}
            >
              {(overlayStatus?.same_scene_beats ?? []).map((item) => (
                <option key={item.beat} value={String(item.beat)}>
                  {item.label}
                </option>
              ))}
            </SelectField>
            <div className="mt-2 rounded-[12px] border border-white/[0.08] bg-black/20 px-3 py-2 text-[12px] leading-5 text-white/58">
              {t("viewer.threeD.beatOverlay.copyFlow", {
                sourceBeat: selectedOverlayBeat || "-",
                targetBeat: manifest.beat_context?.beat ?? "-",
              })}
            </div>
            <div className="mt-2 grid gap-2">
              <Button size="sm" onClick={() => void saveOverlay()} disabled={overlayBusy || !viewer}>
                {t("viewer.threeD.beatOverlay.saveCurrent")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void copySelectedOverlay()}
                disabled={overlayBusy || !selectedOverlayBeat}
              >
                {t("viewer.threeD.beatOverlay.copySelected")}
              </Button>
            </div>
          </PanelSection>
        )}

        <PanelSection title={t("viewer.threeD.sections.output")}>
          <div className="grid gap-2">
            {manifest.mode === "beat" && manifest.allowed_destinations.includes("beat_selected_background") && onCaptureSelectedBackground && (
              <Button
                size="sm"
                onClick={() => void capture("env_only", "selected_background")}
                disabled={!viewer || captureBusy !== null}
              >
                {captureBusy === "env_only" ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
                {autoCommitDirectorCombined
                  ? t("viewer.threeD.submitCurrentViewAsBackground")
                  : t("viewer.threeD.useEnvAsBackground")}
              </Button>
            )}
            {manifest.mode === "beat" && onSubmitDirectorCombined && (
              <Button
                size="sm"
                onClick={() => void capture("combined", "director_combined")}
                disabled={!viewer || captureBusy !== null}
              >
                {captureBusy === "combined" ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
                {autoCommitDirectorCombined
                  ? t("viewer.threeD.submitCurrentViewAsDirectorCombined")
                  : t("viewer.threeD.outputCurrentViewAsDirectorCombined")}
              </Button>
            )}
            {onCaptureCanvasNode && (
              manifest.allowed_destinations.includes("canvas_screenshot_node") ||
              (manifest.mode === "beat" && !autoCommitDirectorCombined)
            ) && (
              <Button
                size="sm"
                onClick={() => void capture("combined", "canvas_screenshot_node")}
                disabled={!viewer || captureBusy !== null}
              >
                {captureBusy === "combined" ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
                {t("viewer.threeD.panoOutputToCanvasNode")}
              </Button>
            )}
            {manifest.mode !== "beat" && onSaveScene && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleSaveScene()}
                disabled={!viewer || sceneBusy}
              >
                {sceneBusy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Move3D className="size-3.5" />
                )}
                {t("viewer.threeD.saveScene")}
              </Button>
            )}
            {manifest.mode !== "beat" && onClearScene && hasSavedSceneForActiveSource && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void handleClearScene()}
                disabled={!viewer || sceneBusy}
              >
                <Trash2 className="size-3.5" />
                {t("viewer.threeD.clearScene")}
              </Button>
            )}
            {sceneStatus && (
              <div className="text-[12px] leading-5 text-amber-200/84">{sceneStatus}</div>
            )}
            {manifest.mode === "beat" && canWriteDirectorBundle && !autoCommitDirectorCombined && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void exportControlFrames()}
                disabled={!viewer || captureBusy !== null}
              >
                {captureBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
                {t("viewer.threeD.exportControlLayer")}
              </Button>
            )}
          </div>
          {exportStatus && (
            <div className="mt-2 truncate text-[12px] leading-5 text-white/54">{exportStatus}</div>
          )}
        </PanelSection>

        <div className="mt-3 rounded-[12px] border border-white/[0.08] bg-black/20 px-3 py-2 text-[12px] leading-5 text-white/54">
          <div>
            {t("viewer.threeD.counts", {
              actor: counts.actor,
              prop: counts.prop,
              staging: counts.staging,
            })}
          </div>
          <div className="truncate">{status}</div>
          {error && <div className="mt-1 text-red-300">{error}</div>}
        </div>
      </aside>
      )}

      <main className="relative min-h-0 overflow-hidden bg-black/25">
        <ThreeDStageCanvas
              splatUrl={resolveMediaUrl(activeSplatUrl) ?? activeSplatUrl}
              panoUrl={resolveMediaUrl(activePanoUrl) ?? activePanoUrl}
              orientationMode={orientationMode}
              sourceTransform={activeSourceInitialTransform}
              collisionUrl={resolveMediaUrl(activeCollisionUrl) ?? activeCollisionUrl}
              interactionActive={stageActive}
              onInteractionActiveChange={setStageActive}
              onReady={handleReady}
              onError={(next) => setError(next.message)}
              onStatus={setStatus}
              onSourceReady={handleSourceReady}
              onPlaceRequest={placeCurrentTool}
              showInteractionHint={false}
            />
            <FrameGuide ref={frameGuideRef} aspect={frameAspect} />
            <Crosshair />
            <div className="pointer-events-none absolute bottom-[24px] left-6 z-10 flex h-6 items-center gap-2 rounded-[8px] bg-black/45 px-2.5 text-[12px] font-normal text-white/64 backdrop-blur-md">
              <span>
                {stageActive
                  ? t("viewer.threeD.stageInteractive")
                  : t("viewer.threeD.stageClickToEnter")}
              </span>
              <span>|</span>
              <span>
                {panelHidden
                  ? t("viewer.threeD.stageTabRestore")
                  : t("viewer.threeD.stageTabFullscreen")}
              </span>
            </div>
            <div className="pointer-events-auto absolute bottom-[24px] right-6 z-10 flex items-center gap-2">
              {[
                {
                  key: "1",
                  title: t("viewer.threeD.actionActorTitle"),
                  value: activeActor?.label ?? t("viewer.threeD.actionPresetsValue", { count: actorChoices.length }),
                  active: toolMode === "actor",
                  onClick: cycleActorChoice,
                },
                {
                  key: "2",
                  title: t("viewer.threeD.actionPropTitle"),
                  value: activeProp?.label ?? t("viewer.threeD.actionPresetsValue", { count: propChoices.length }),
                  active: toolMode === "prop",
                  onClick: cyclePropChoice,
                },
                {
                  key: "3",
                  title: t("viewer.threeD.actionStagingTitle"),
                  value: selection?.kind === "staging"
                    ? selection.label
                    : t("viewer.threeD.actionStagingValue", { count: counts.staging }),
                  active: toolMode === "staging",
                  onClick: () => {
                    setToolMode("staging");
                    viewer?.cycleSelection("staging");
                  },
                },
              ].map((slot) => (
                <button
                  key={slot.key}
                  type="button"
                  onClick={slot.onClick}
                  className={cn(
                    stageToolbarGlassButtonClass,
                    "max-w-[150px]",
                    slot.active && "text-white",
                  )}
                >
                  <span className="shrink-0 font-semibold">{slot.key} · {slot.title}</span>
                  <span className="min-w-0 truncate text-white/58">{slot.value}</span>
                </button>
              ))}
              <div className="relative">
                {quickActionsOpen ? (
                  <div className="absolute bottom-10 right-0 w-[280px] rounded-[14px] border border-white/[0.12] bg-[#151515]/78 px-3 py-2 text-[12px] leading-5 text-white/68 shadow-[0_18px_42px_rgba(0,0,0,0.46)] backdrop-blur-2xl">
                    {t("viewer.threeD.stageShortcutHint")}
                    {canWriteDirectorBundle ? (
                      <button
                        type="button"
                        onClick={() => {
                          void exportControlFrames();
                          setQuickActionsOpen(false);
                        }}
                        className="mt-2 h-8 w-full rounded-[9px] border border-white/[0.10] bg-white/[0.06] text-white/70 transition hover:bg-white/[0.10] hover:text-white"
                      >
                        {t("viewer.threeD.actionExportTitle")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => setQuickActionsOpen((next) => !next)}
                  className={cn(stageToolbarGlassButtonClass, quickActionsOpen && "text-white")}
                >
                  <Keyboard className="h-3.5 w-3.5 shrink-0" />
                  {t("viewer.threeD.quickActions")}
                </button>
              </div>
            </div>
            {shortcutsOpen ? (
              <div className="absolute right-4 top-4 z-20 w-[360px] max-w-[calc(100%-2rem)] rounded-2xl border border-[#ffe28a]/35 bg-[rgba(20,16,11,0.92)] p-4 text-xs text-[#ccb98e] shadow-2xl backdrop-blur-xl">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#fff8df]">{t("viewer.threeD.shortcuts.title")}</div>
                    <div className="mt-1 text-[11px] text-[#9f9170]">{t("viewer.threeD.shortcuts.subtitle")}</div>
                  </div>
                  <button
                    type="button"
                    className="nodrag rounded-full border border-[rgba(255,226,166,0.2)] px-2 py-1 text-[11px] text-[#fff8df] transition hover:border-[#ffe28a]/60"
                    onClick={(event) => {
                      event.stopPropagation();
                      setShortcutsOpen(false);
                    }}
                  >
                    {t("viewer.threeD.shortcuts.close")}
                  </button>
                </div>
                <div className="grid gap-2">
                  {[
                    ["1/2/3", t("viewer.threeD.shortcuts.select")],
                    ["C / F / G / M", t("viewer.threeD.shortcuts.place")],
                    ["↑ ↓ ← → / I J K L / U O", t("viewer.threeD.shortcuts.nudge")],
                    ["R/T · -/+ · [ ]", t("viewer.threeD.shortcuts.transform")],
                    ["B / N / V", t("viewer.threeD.shortcuts.camera")],
                    ["P / 4", t("viewer.threeD.shortcuts.saveExport")],
                    ["Shift+Delete", t("viewer.threeD.shortcuts.safeDelete")],
                    ["H / Tab / Esc", t("viewer.threeD.shortcuts.system")],
                  ].map(([keys, label]) => (
                    <div key={keys} className="grid grid-cols-[132px_minmax(0,1fr)] gap-3 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2">
                      <div className="font-mono text-[11px] font-semibold text-[#fff8df]">{keys}</div>
                      <div className="leading-5">{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <SelectionBadge
              viewer={viewer}
              selection={selection}
              selectedKindLabel={selectedKindLabel}
            />
      </main>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-3 rounded-[14px] border border-white/[0.08] bg-[#1d1e24]/78 p-3 shadow-[0_12px_30px_rgba(0,0,0,0.18)]">
      <h3 className="mb-3 text-[12px] font-semibold leading-none text-white/72">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function SourceDirectionBall({
  ariaLabel,
  ariaValueText,
  yawDeg,
  pitchDeg,
  onChange,
}: {
  ariaLabel: string;
  ariaValueText: string;
  yawDeg: number;
  pitchDeg: number;
  onChange: (patch: Pick<DirectorWorldSourceTransform, "yawDeg" | "pitchDeg">) => void;
}) {
  const activePointerIdRef = useRef<number | null>(null);
  const handlePointer = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = rect.width || 128;
    const height = rect.height || 128;
    const left = rect.width ? rect.left : event.clientX - width / 2;
    const top = rect.height ? rect.top : event.clientY - height / 2;
    const x = clamp((event.clientX - left) / width, 0, 1);
    const y = clamp((event.clientY - top) / height, 0, 1);
    onChange({
      yawDeg: Math.round((x - 0.5) * 360),
      pitchDeg: Math.round((0.5 - y) * 180),
    });
  };
  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    handlePointer(event);
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    activePointerIdRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 15 : 5;
    if (event.key === "ArrowLeft") {
      onChange({ yawDeg: clamp(yawDeg - step, -180, 180), pitchDeg });
    } else if (event.key === "ArrowRight") {
      onChange({ yawDeg: clamp(yawDeg + step, -180, 180), pitchDeg });
    } else if (event.key === "ArrowUp") {
      onChange({ yawDeg, pitchDeg: clamp(pitchDeg + step, -90, 90) });
    } else if (event.key === "ArrowDown") {
      onChange({ yawDeg, pitchDeg: clamp(pitchDeg - step, -90, 90) });
    } else {
      return;
    }
    event.preventDefault();
  };
  const knobX = `${50 + (clamp(yawDeg, -180, 180) / 360) * 100}%`;
  const knobY = `${50 - (clamp(pitchDeg, -90, 90) / 180) * 100}%`;

  return (
    <button
      type="button"
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={-180}
      aria-valuemax={180}
      aria-valuenow={Math.round(yawDeg)}
      aria-valuetext={ariaValueText}
      onPointerDown={handlePointerDown}
      onPointerMove={(event) => {
        if (activePointerIdRef.current === event.pointerId) handlePointer(event);
      }}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      className="relative mx-auto block aspect-square w-[128px] touch-none rounded-full bg-[radial-gradient(circle_at_36%_28%,rgba(174,217,255,0.92),rgba(66,132,192,0.86)_34%,rgba(18,66,117,0.94)_68%,rgba(8,24,44,0.98)_100%)] shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_12px_28px_rgba(0,0,0,0.36)] outline-none focus-visible:ring-2 focus-visible:ring-[#8fd3ff]"
    >
      <span className="pointer-events-none absolute bottom-[18%] left-1/2 top-[18%] border-l border-white/16" />
      <span className="pointer-events-none absolute left-[18%] right-[18%] top-1/2 border-t border-white/16" />
      <span
        className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 bg-[#ffd76a] shadow-[0_0_0_7px_rgba(255,215,106,0.12),0_0_18px_rgba(255,215,106,0.28)]"
        style={{ left: knobX, top: knobY }}
      />
    </button>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const props = child.props as { value?: unknown; children?: React.ReactNode };
      return {
        value: String(props.value ?? ""),
        label: props.children,
      };
    });
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? value;

  return (
    <div
      className="relative block text-[12px] font-medium text-white/56"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="sr-only"
      >
        {children}
      </select>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((next) => !next)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="mt-1.5 flex h-9 w-full items-center justify-between rounded-[10px] border border-white/[0.10] bg-black/25 pl-3 pr-3 text-left text-[12px] text-white outline-none transition-colors hover:border-white/16 focus:border-white/22 disabled:cursor-not-allowed disabled:opacity-45"
      >
        <span className="min-w-0 truncate">{selectedLabel}</span>
        <ChevronDown className={cn("ml-3 h-4 w-4 shrink-0 text-white/62 transition-transform", open && "rotate-180")} />
      </button>
      {open && !disabled ? (
        <div
          role="listbox"
          aria-label={label}
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-[12px] border border-white/12 bg-[#242426]/98 py-1.5 text-[12px] text-white shadow-[0_14px_34px_rgba(0,0,0,0.42)] backdrop-blur-xl"
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <div key={option.value} className="px-1.5">
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-[9px] px-3 text-left transition-colors",
                    active
                      ? "bg-white/[0.075] text-white ring-1 ring-white/[0.08]"
                      : "text-white/72 hover:bg-white/[0.045] hover:text-white",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className={cn("w-3 text-center text-white/82", active ? "opacity-100" : "opacity-0")}>✓</span>
                  <span className="min-w-0 truncate">{option.label}</span>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function RangeField({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-[12px] font-medium text-white/56">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="dc-range mt-2 h-5 w-full appearance-none bg-transparent"
      />
    </label>
  );
}

function ColorPaletteField({
  label,
  value,
  palette,
  onChange,
}: {
  label: string;
  value: string;
  palette: readonly string[];
  onChange: (value: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerButtonRef = useRef<HTMLButtonElement | null>(null);
  const [pickerPosition, setPickerPosition] = useState<{ left: number; top: number } | null>(null);
  const hsv = useMemo(() => hexToHsv(value), [value]);
  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const updateSaturationValue = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const v = clamp(1 - (event.clientY - rect.top) / rect.height, 0, 1);
    onChange(hsvToHex({ h: hsv.h, s, v }));
  };
  const updatePickerPosition = useCallback(() => {
    if (typeof window === "undefined") return;
    const rect = pickerButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pickerWidth = 220;
    const pickerHeight = 206;
    const gap = 8;
    const viewportPadding = 12;
    setPickerPosition({
      left: Math.min(rect.right + gap, window.innerWidth - pickerWidth - viewportPadding),
      top: Math.max(viewportPadding, rect.bottom - pickerHeight),
    });
  }, []);
  useEffect(() => {
    if (!pickerOpen) return undefined;
    updatePickerPosition();
    window.addEventListener("resize", updatePickerPosition);
    window.addEventListener("scroll", updatePickerPosition, true);
    return () => {
      window.removeEventListener("resize", updatePickerPosition);
      window.removeEventListener("scroll", updatePickerPosition, true);
    };
  }, [pickerOpen, updatePickerPosition]);

  return (
    <div className="relative rounded-[12px] border border-white/[0.08] bg-black/20 px-3 py-2 text-[12px] text-white/56">
      <div className="font-medium">{label}</div>
      <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(24px,24px))] gap-2">
        {palette.map((preset) => {
          const selected = value.toLowerCase() === preset.toLowerCase();
          return (
            <button
              key={preset}
              type="button"
              aria-label={preset}
              onClick={() => onChange(preset)}
              className={[
                "h-6 w-6 rounded-full border border-white/14 shadow-[0_1px_4px_rgba(0,0,0,0.45)] transition hover:scale-105 hover:border-white/48",
                selected ? "border-white/70 shadow-[0_0_0_3px_rgba(255,255,255,0.38),0_0_0_5px_rgba(255,255,255,0.12),0_1px_4px_rgba(0,0,0,0.45)]" : "",
              ].join(" ")}
              style={{ backgroundColor: preset }}
            />
          );
        })}
        <div className="relative h-6 w-6">
          <button
            ref={pickerButtonRef}
            type="button"
            onClick={() => setPickerOpen((next) => !next)}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-white/16 bg-white/[0.05] text-white/60 transition hover:border-white/44 hover:bg-white/[0.08] hover:text-white"
            aria-label={label}
          >
            <Pipette className="h-3 w-3" />
          </button>
          {pickerOpen && pickerPosition && typeof document !== "undefined" ? createPortal(
            <div
              className="fixed z-[10000] w-[220px] rounded-[14px] border border-white/[0.10] bg-[#242426]/72 p-3 shadow-[0_18px_42px_rgba(0,0,0,0.46)] backdrop-blur-2xl"
              style={{ left: pickerPosition.left, top: pickerPosition.top }}
            >
              <div
                className="relative h-[116px] cursor-crosshair overflow-hidden rounded-[10px] border border-white/[0.06] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                style={{ backgroundColor: hueColor }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  updateSaturationValue(event);
                }}
                onPointerMove={(event) => {
                  if (event.buttons === 1) updateSaturationValue(event);
                }}
              >
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,#fff,rgba(255,255,255,0))]" />
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,#000,rgba(0,0,0,0))]" />
                <span
                  className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                  style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={Math.round(hsv.h)}
                onChange={(event) => onChange(hsvToHex({ ...hsv, h: Number(event.target.value) }))}
                className="dc-color-hue mt-3 h-4 w-full appearance-none bg-transparent"
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="font-mono text-[11px] uppercase text-white/50">{value}</span>
                <span className="h-5 w-5 rounded-full border border-white/20 shadow-[0_1px_4px_rgba(0,0,0,0.35)]" style={{ backgroundColor: value }} />
              </div>
            </div>,
            document.body,
          ) : null}
        </div>
      </div>
    </div>
  );
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const normalized = hex.replace("#", "").trim();
  const full = normalized.length === 3
    ? normalized.split("").map((char) => char + char).join("")
    : normalized.padEnd(6, "0").slice(0, 6);
  const r = Number.parseInt(full.slice(0, 2), 16) / 255;
  const g = Number.parseInt(full.slice(2, 4), 16) / 255;
  const b = Number.parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;
  return {
    h,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

function hsvToHex({ h, s, v }: { h: number; s: number; v: number }): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `#${[r, g, b]
    .map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

const FrameGuide = forwardRef<HTMLDivElement, { aspect: FrameAspect }>(function FrameGuide(
  { aspect },
  ref,
) {
  const [w, h] = aspectToWh(aspect);
  const ratio = w / h;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[4] flex items-center justify-center p-4"
    >
      <div
        ref={ref}
        className="relative"
        style={{
          aspectRatio: `${w} / ${h}`,
          width: `min(calc(100% - 32px), calc((100dvh - 64px) * ${ratio}))`,
          maxHeight: "calc(100% - 32px)",
          border: "1px solid rgba(255, 255, 255, 0.34)",
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.16), 0 0 18px rgba(0, 0, 0, 0.42)",
        }}
      >
        <div className="absolute left-[10px] top-2 rounded-full bg-black/45 px-2 py-1 text-[11px] font-semibold text-white/56">
          {aspect}
        </div>
      </div>
    </div>
  );
});

function Crosshair() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 z-[5] h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2"
    >
      <span className="absolute left-2 top-0 h-[18px] w-[2px] bg-white/85 shadow-[0_0_8px_rgba(0,0,0,0.75)]" />
      <span className="absolute left-0 top-2 h-[2px] w-[18px] bg-white/85 shadow-[0_0_8px_rgba(0,0,0,0.75)]" />
    </div>
  );
}

function SelectionBadge({
  viewer,
  selection,
  selectedKindLabel,
}: {
  viewer: ViewerApp | null;
  selection: SelectionState | null;
  selectedKindLabel: string | null;
}) {
  const tagRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!viewer || !selection) return undefined;
    let raf = 0;
    const tick = () => {
      const tag = tagRef.current;
      if (tag) {
        const pos = viewer.getSelectionScreenPosition();
        if (!pos || !pos.visible) {
          tag.style.opacity = "0";
        } else {
          tag.style.opacity = "1";
          tag.style.transform = `translate(-50%, -100%) translate(${pos.x}px, ${pos.y}px)`;
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [selection, viewer]);

  if (!selection || !selectedKindLabel) return null;
  const [x, y, z] = selection.position;
  return (
    <div
      ref={tagRef}
      className="pointer-events-none absolute left-0 top-0 z-10 rounded-full border border-[#ffbd59]/70 bg-black/75 px-3 py-1 text-xs font-semibold text-[#fff4be] shadow-[0_8px_22px_rgba(0,0,0,0.45)]"
    >
      {selectedKindLabel} · {selection.label} · ({x.toFixed(2)}, {y.toFixed(2)}, {z.toFixed(2)})
    </div>
  );
}
