// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ThreeDSceneSnapshot } from "./engine/viewerApp";
import type { DirectorWorldSourceTransform } from "./sourceTransform";

export type DirectorStageMode = "scene" | "beat";
export type DirectorStageSourceKind = "active" | "master" | "reverse" | "pano" | "uploaded" | "custom";
export type DirectorWorldSourceType = "sog" | "pano360" | "mesh";
export type DirectorStageSourceType = Exclude<DirectorWorldSourceType, "mesh">;
export type DirectorStageOrientationMode =
  | "supersplat_auto"
  | "identity"
  | "lcc_legacy"
  | "flip_z";
export type DirectorPlacementSpace = "world" | "pano_view";
export type DirectorPlacementKind = "actor" | "prop" | "staging";
export type DirectorPropOrStagingPlacementKind = Exclude<DirectorPlacementKind, "actor">;
export type DirectorCaptureBundle = "combined" | "env_only" | "frame_meta";

export interface DirectorWorldSource {
  id?: string;
  source_type: DirectorWorldSourceType;
  source_kind?: DirectorStageSourceKind;
  label?: string;
  ply_url?: string;
  url?: string;
  pano_url?: string;
  pano_fs?: string;
  collision_glb_url?: string;
  slot_kind?: "scene_director_pano_360" | "scene_360_candidate";
  fs?: string;
  current?: boolean;
  transform?: DirectorWorldSourceTransform;
}

export type DirectorPlacement =
  | { space: "world"; position: [number, number, number]; yawDeg: number }
  | { space: "pano_view"; yawDeg: number; pitchDeg: number; distance: number };

export type DirectorActorPlacement = {
  kind: "actor";
  placement: DirectorPlacement;
  pose?: string;
  actionPlaying?: boolean;
  shapeHint?: never;
};

export type DirectorPropOrStagingPlacement = {
  kind: DirectorPropOrStagingPlacementKind;
  placement: DirectorPlacement;
  pose?: never;
  shapeHint?: string;
};

export type DirectorPlacedObject = DirectorActorPlacement | DirectorPropOrStagingPlacement;

export type DirectorFrameMetaPlacement =
  | { space: "world"; position: [number, number, number]; yaw_deg: number }
  | { space: "pano_view"; yaw_deg: number; pitch_deg: number; distance: number };

export interface DirectorObjectLayerBase {
  id: string;
  label: string;
  color: string;
  scale: [number, number, number];
  placement: DirectorFrameMetaPlacement;
}

export type DirectorObjectLayerActor = DirectorObjectLayerBase & {
  kind: "actor";
  pose?: string;
  action_playing?: boolean;
  shape_hint?: never;
};

export type DirectorObjectLayerProp = DirectorObjectLayerBase & {
  kind: "prop";
  shape_hint?: string;
  pose?: never;
  action_playing?: never;
};

export type DirectorObjectLayerStaging = DirectorObjectLayerBase & {
  kind: "staging";
  name?: string;
  marker_color?: string;
  semantic_label?: string;
  shape_hint?: string;
  pose?: never;
  action_playing?: never;
};

export interface DirectorObjectLayer {
  source_id: string;
  actors: DirectorObjectLayerActor[];
  props: DirectorObjectLayerProp[];
  stagings: DirectorObjectLayerStaging[];
}

export interface DirectorFrameMetaActor {
  id: string;
  identity_id: string;
  name: string;
  label: string;
  state?: string;
  action_playing?: boolean;
  marker_color: string;
}

export interface DirectorFrameMetaProp {
  id: string;
  prop_id: string;
  name: string;
  label: string;
  type: "prop_hero" | "prop_staging";
  category: "hero" | "staging";
  marker_color: string;
  semantic_label: string;
  shape_hint?: string;
}

export interface DirectorFrameMetaSource {
  source_id: string;
  source_type: DirectorStageSourceType;
  source_kind: Exclude<DirectorStageSourceKind, "active">;
  label?: string;
  ply_url?: string;
  url?: string;
  pano_url?: string;
  pano_fs?: string;
  collision_glb_url?: string;
  slot_kind?: "scene_director_pano_360" | "scene_360_candidate";
  fs?: string;
}

export interface DirectorFrameMeta {
  schema_version: "director_frame_meta_v1";
  source: DirectorFrameMetaSource;
  camera: {
    mode: "sog" | "pano";
    frame_aspect: string;
    state: Record<string, unknown>;
  };
  layer: DirectorObjectLayer;
  actors?: DirectorFrameMetaActor[];
  props?: DirectorFrameMetaProp[];
  stagings?: DirectorFrameMetaProp[];
  beat_context?: DirectorStageManifest["beat_context"];
}

export interface DirectorControlFrameBundle {
  schema_version: "director_control_bundle_v1";
  dir: string;
  paths: Record<string, string>;
  rel_paths: Record<string, string>;
  urls?: Record<string, string>;
  source?: DirectorFrameMetaSource;
  frame_meta?: DirectorFrameMeta;
}

export interface DirectorWorldSourceCapability {
  captureBundle: readonly DirectorCaptureBundle[];
  placementSpace: DirectorPlacementSpace;
}

const DIRECTOR_WORLD_CAPTURE_BUNDLE = ["combined", "env_only", "frame_meta"] as const;

export const DIRECTOR_WORLD_SOURCE_CAPABILITIES = {
  sog: { captureBundle: DIRECTOR_WORLD_CAPTURE_BUNDLE, placementSpace: "world" },
  pano360: { captureBundle: DIRECTOR_WORLD_CAPTURE_BUNDLE, placementSpace: "world" },
  mesh: { captureBundle: DIRECTOR_WORLD_CAPTURE_BUNDLE, placementSpace: "world" },
} as const satisfies Record<DirectorWorldSourceType, DirectorWorldSourceCapability>;

export function isActorPlacement(kind: DirectorPlacementKind): kind is "actor" {
  return kind === "actor";
}

export function isPropOrStagingPlacement(kind: DirectorPlacementKind): kind is DirectorPropOrStagingPlacementKind {
  return kind === "prop" || kind === "staging";
}

export function directorPlacementSpaceForSource(source: { source_type?: DirectorWorldSourceType }): DirectorPlacementSpace {
  return DIRECTOR_WORLD_SOURCE_CAPABILITIES[source.source_type ?? "sog"].placementSpace;
}

export type DirectorDestination =
  | "view"
  | "download"
  | "canvas_screenshot_node"
  | "beat_director_combined"
  | "beat_director_env_only"
  | "beat_selected_background";

export interface DirectorStageManifest {
  viewer_kind: "three_d_director";
  mode: DirectorStageMode;
  project: string;
  scene_id: string;
  display_name: string;
  source: {
    source_type?: DirectorStageSourceType;
    ply_url?: string;
    url?: string;
    pano_url?: string;
    pano_fs?: string;
    collision_glb_url?: string;
    source_kind: Exclude<DirectorStageSourceKind, "active">;
    transform?: DirectorWorldSourceTransform;
  };
  source_options?: Array<{
    kind: DirectorStageSourceKind;
    label: string;
    source_type?: DirectorStageSourceType;
    ply_url?: string;
    url?: string;
    pano_url?: string;
    pano_fs?: string;
    slot_kind?: "scene_director_pano_360" | "scene_360_candidate";
    fs?: string;
    current?: boolean;
    transform?: DirectorWorldSourceTransform;
  }>;
  sources?: DirectorWorldSource[];
  active_source_id?: string;
  scene?: ThreeDSceneSnapshot | null;
  scenes_by_source_id?: Record<string, ThreeDSceneSnapshot | null | undefined>;
  source_orientation_mode?: DirectorStageOrientationMode;
  blockings_dir_fs?: string;
  control_frames_dir_fs?: string;
  slate_beat?: number;
  beat_context?: {
    episode: number;
    beat: number;
    visual_description?: string;
    detected_identities: string[];
    detected_props: string[];
  };
  palette: {
    actors: Array<{ identity_id: string; label: string; color: string }>;
    props: Array<{ prop_id: string; label: string; color: string }>;
    anonymous_colors: string[];
    anonymous_prop_colors: string[];
  };
  allowed_destinations: DirectorDestination[];
}

export interface DirectorCaptureResult {
  combined_blob?: Blob;
  env_only_blob?: Blob;
  actor_overlay_blob?: Blob;
  camera: Record<string, unknown>;
  actors: Array<{
    identity_id?: string;
    anonymous_id?: string;
    color: string;
    screen_region: [number, number, number, number];
  }>;
  props: Array<{
    prop_id?: string;
    anonymous_id?: string;
    color: string;
    screen_region: [number, number, number, number];
  }>;
}

export interface DirectorStageOverlayPayload {
  schema_version?: string;
  scene_id?: string;
  episode?: number;
  beat?: number;
  frame_aspect?: string;
  source?: DirectorFrameMetaSource;
  frame_meta?: DirectorFrameMeta;
  snapshot?: Record<string, unknown>;
  camera?: Record<string, unknown>;
  actors?: unknown[];
  props?: unknown[];
  stagings?: unknown[];
  command_log?: unknown[];
  deleted_keys?: string[];
  beat_context?: {
    detected_identities?: string[];
    detected_props?: string[];
  };
  saved_at?: string;
}

export interface DirectorStageOverlayStatus {
  status: "current" | "inherited" | "missing" | "saved";
  overlay: DirectorStageOverlayPayload | null;
  path: string;
  inherited_from_beat?: number;
  same_scene_beats: Array<{ beat: number; label: string; scene_id: string }>;
}

/** 3GS package extensions; anything else (jpg/png/webp) is treated as a 360 pano. */
const THREE_GS_EXT_RE = /\.(ply|sog|splat|ksplat|spz)(\?|#|$)/i;

/**
 * Build a minimal scene-mode director manifest from just a world asset URL.
 * Used by the「历史资产」world-model tab to open 虾境 straight off a generation
 * record, which only carries the output url — no node `sources` / scene edits /
 * layers. URLs ending in a 3GS extension load as a `sog` source; everything else
 * is treated as a `pano360` background. Returns null for an empty url.
 */
export function buildStandaloneWorldManifest(params: {
  project: string;
  /** The world asset URL (3GS package or 360 pano image). */
  url: string;
  displayName?: string | null;
}): DirectorStageManifest | null {
  const url = params.url?.trim();
  if (!url) return null;
  const isPly = THREE_GS_EXT_RE.test(url);
  const sourceType: DirectorStageSourceType = isPly ? "sog" : "pano360";
  return {
    viewer_kind: "three_d_director",
    mode: "scene",
    project: params.project,
    scene_id: "freezone-3gs",
    // 写进 manifest 的规范名，跨语言要保持一致。
    display_name: params.displayName?.trim() || "导演世界", // i18n-exempt —— 规范值
    source: {
      source_type: sourceType,
      ply_url: isPly ? url : undefined,
      url,
      pano_url: isPly ? undefined : url,
      source_kind: "custom",
    },
    palette: {
      actors: [],
      props: [],
      anonymous_colors: [],
      anonymous_prop_colors: [],
    },
    allowed_destinations: ["view", "download", "canvas_screenshot_node"],
  };
}
