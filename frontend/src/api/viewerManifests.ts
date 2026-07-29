// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PanoViewerManifest } from "@/features/viewer-kit/pano/panoManifest";
import type {
  DirectorStageManifest,
  DirectorStageOverlayStatus,
} from "@/features/viewer-kit/three-d/directorManifest";
import type { ThreeDSceneSnapshot } from "@/features/viewer-kit/three-d/engine/viewerApp";
import { apiCall } from "./client";

export type DirectorStagePalette = DirectorStageManifest["palette"];

export interface AiStagingPropResult {
  prop?: Record<string, unknown>;
  model?: string;
}

export async function getDirectorStagePalette(project: string): Promise<DirectorStagePalette> {
  return await apiCall<DirectorStagePalette>(
    `projects/${encodeURIComponent(project)}/director-stage/palette`,
  );
}

export async function getBeatPanoViewerManifest(
  project: string,
  episode: number,
  beat: number,
): Promise<PanoViewerManifest> {
  return await apiCall<PanoViewerManifest>(
    `projects/${encodeURIComponent(project)}/episodes/${episode}/beats/${beat}/pano-background/manifest`,
  );
}

export async function getBeatDirectorStageManifest(
  project: string,
  episode: number,
  beat: number,
): Promise<DirectorStageManifest> {
  return await apiCall<DirectorStageManifest>(
    `projects/${encodeURIComponent(project)}/episodes/${episode}/beats/${beat}/director-stage/manifest`,
  );
}

export async function getBeatDirectorStageOverlay(
  project: string,
  episode: number,
  beat: number,
): Promise<DirectorStageOverlayStatus> {
  return await apiCall<DirectorStageOverlayStatus>(
    `projects/${encodeURIComponent(project)}/episodes/${episode}/beats/${beat}/director-stage/overlay`,
  );
}

export async function saveBeatDirectorStageOverlay(
  project: string,
  episode: number,
  beat: number,
  payload: Record<string, unknown>,
): Promise<DirectorStageOverlayStatus> {
  return await apiCall<DirectorStageOverlayStatus>(
    `projects/${encodeURIComponent(project)}/episodes/${episode}/beats/${beat}/director-stage/overlay`,
    {
      method: "POST",
      json: payload,
    },
  );
}

export async function saveBeatDirectorControlFrame(
  project: string,
  episode: number,
  beat: number,
  payload: Record<string, unknown>,
): Promise<{
  dir: string;
  paths: Record<string, string>;
  rel_paths: Record<string, string>;
  urls?: Record<string, string>;
}> {
  return await apiCall<{
    dir: string;
    paths: Record<string, string>;
    rel_paths: Record<string, string>;
    urls?: Record<string, string>;
  }>(
    `projects/${encodeURIComponent(project)}/episodes/${episode}/beats/${beat}/director-stage/control-frame`,
    {
      method: "POST",
      json: payload,
    },
  );
}

export async function startDirectorControlToSketch(
  project: string,
  episode: number,
  beat: number,
): Promise<{ task_type?: string; scope?: string; message?: string; error?: string }> {
  return await apiCall<{ task_type?: string; scope?: string; message?: string; error?: string }>(
    `projects/${encodeURIComponent(project)}/episodes/${episode}/beats/${beat}/director-control-to-sketch`,
    {
      method: "POST",
    },
  );
}

export async function generateAiStagingProp(
  project: string,
  payload: Record<string, unknown>,
): Promise<AiStagingPropResult> {
  return await apiCall<AiStagingPropResult>(
    `projects/${encodeURIComponent(project)}/freezone/ai-staging-prop`,
    {
      method: "POST",
      json: payload,
      // Backend model timeout is 120s; leave transport margin so the UI can
      // receive its structured timeout response instead of aborting first.
      timeout: 130_000,
    },
  );
}

export async function getScenePanoViewerManifest(
  project: string,
  sceneId: string,
): Promise<PanoViewerManifest> {
  return await apiCall<PanoViewerManifest>(
    `projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(sceneId)}/pano/manifest`,
  );
}

export async function getSceneDirectorStageManifest(
  project: string,
  sceneId: string,
): Promise<DirectorStageManifest> {
  return await apiCall<DirectorStageManifest>(
    `projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(sceneId)}/director-stage/manifest`,
  );
}

export async function saveSceneDirectorWorld(
  project: string,
  sceneId: string,
  payload: {
    active_source_id: string;
    snapshot: ThreeDSceneSnapshot;
    active_source?: Record<string, unknown>;
  },
): Promise<{ active_source_id: string; manifest?: DirectorStageManifest | null }> {
  return await apiCall<{ active_source_id: string; manifest?: DirectorStageManifest | null }>(
    `projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(sceneId)}/director-stage/world`,
    {
      method: "POST",
      json: payload,
    },
  );
}

export async function saveSceneDirectorWorldSource(
  project: string,
  sceneId: string,
  payload: {
    source_id: string;
    snapshot: ThreeDSceneSnapshot;
    source?: Record<string, unknown>;
  },
): Promise<{ active_source_id: string; manifest?: DirectorStageManifest | null }> {
  return await apiCall<{ active_source_id: string; manifest?: DirectorStageManifest | null }>(
    `projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(sceneId)}/director-stage/world/source`,
    {
      method: "POST",
      json: payload,
    },
  );
}

export async function clearSceneDirectorWorld(
  project: string,
  sceneId: string,
  activeSourceId?: string,
): Promise<{ active_source_id: string }> {
  return await apiCall<{ active_source_id: string }>(
    `projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(sceneId)}/director-stage/world/clear`,
    {
      method: "POST",
      json: { active_source_id: activeSourceId ?? "" },
    },
  );
}
