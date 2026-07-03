// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export const queryKeys = {
  currentUser: () => ["auth", "me"] as const,
  projects: () => ["projects"] as const,
  projectSummaries: () => ["projects", "summaries"] as const,
  project: (p: string) => ["projects", p] as const,
  projectGrants: (p: string) => ["projects", p, "grants"] as const,
  userSearch: (q: string) => ["users", "search", q] as const,
  pipelineStatus: (p: string) => ["projects", p, "pipeline-status"] as const,
  characters: (p: string) => ["projects", p, "characters"] as const,
  character: (p: string, name: string) =>
    ["projects", p, "characters", name] as const,
  characterVoiceSamples: (p: string, name: string) =>
    ["projects", p, "characters", name, "voice-samples"] as const,
  characterAssetHistories: (p: string, name: string) =>
    ["projects", p, "characters", name, "asset-history"] as const,
  characterAssetHistory: (p: string, name: string, url: string) =>
    ["projects", p, "characters", name, "asset-history", url] as const,
  identities: (p: string, name: string) =>
    ["projects", p, "characters", name, "identities"] as const,
  scenes: (p: string) => ["projects", p, "scenes"] as const,
  scenePlatePreview: (
    p: string,
    sceneId: string,
    variantId: string,
    timeOfDay: string,
  ) =>
    [
      "projects",
      p,
      "scenes",
      "plate-preview",
      sceneId,
      variantId,
      timeOfDay,
    ] as const,
  scene: (p: string, name: string) =>
    ["projects", p, "scenes", name] as const,
  scenePanoManifest: (p: string, name: string) =>
    ["projects", p, "scenes", name, "pano-manifest"] as const,
  sceneDirectorStageManifest: (p: string, name: string) =>
    ["projects", p, "scenes", name, "director-stage-manifest"] as const,
  props: (p: string) => ["projects", p, "props"] as const,
  prop: (p: string, name: string) => ["projects", p, "props", name] as const,
  episodes: (p: string) => ["projects", p, "episodes"] as const,
  episode: (p: string, ep: number) =>
    ["projects", p, "episodes", ep] as const,
  episodeDetail: (p: string, ep: number) =>
    ["projects", p, "episodes", ep, "detail"] as const,
  chapters: (p: string) => ["projects", p, "chapters"] as const,
  script: (p: string, ep: number) =>
    ["projects", p, "episodes", ep, "script"] as const,
  beats: (p: string, ep: number) =>
    ["projects", p, "episodes", ep, "beats"] as const,
  grids: (p: string, ep: number) =>
    ["projects", p, "episodes", ep, "grids"] as const,
  sketchRegenQueue: (p: string, ep: number) =>
    ["projects", p, "episodes", ep, "sketch-regen-queue"] as const,
  sketchImageUsage: (p: string, ep: number) =>
    ["projects", p, "episodes", ep, "sketch-image-usage"] as const,
  sketchPoseEditor: (p: string, ep: number, beat: number) =>
    ["projects", p, "episodes", ep, "beats", beat, "sketch-pose-editor"] as const,
  beatPanoBackgroundManifest: (p: string, ep: number, beat: number) =>
    ["projects", p, "episodes", ep, "beats", beat, "pano-background-manifest"] as const,
  beatDirectorStageManifest: (p: string, ep: number, beat: number) =>
    ["projects", p, "episodes", ep, "beats", beat, "director-stage-manifest"] as const,
  beatBackgroundAnchors: (p: string, ep: number, beat: number) =>
    ["projects", p, "episodes", ep, "beats", beat, "background-anchors"] as const,
  directorControlFrame: (p: string, ep: number, beat: number) =>
    ["projects", p, "episodes", ep, "beats", beat, "director-control-frame"] as const,
  videoPool: (p: string, ep: number) =>
    ["projects", p, "episodes", ep, "video-pool"] as const,
  videoBackends: (p: string) => ["projects", p, "video-backends"] as const,
  renderSettings: (p: string) => ["projects", p, "render-settings"] as const,
  sketchSettings: (p: string) => ["projects", p, "sketch-settings"] as const,
  narratorVoice: (p: string) => ["projects", p, "narrator-voice"] as const,
  narratorVoiceSources: (p: string) =>
    ["projects", p, "narrator-voice", "sources"] as const,
  finalVideo: (p: string, ep: number) =>
    ["projects", p, "episodes", ep, "final-video"] as const,
  tasks: (p?: string) => (p ? (["projects", p, "tasks"] as const) : (["tasks"] as const)),
  freezoneCanvases: (p: string) =>
    ["projects", p, "freezone", "canvases"] as const,
  freezoneProjectAssets: (p: string) =>
    ["projects", p, "freezone", "assets"] as const,
  freezoneBeatContext: (p: string, episode?: number | null, beat?: number | null) =>
    ["projects", p, "freezone", "beat-context", episode ?? null, beat ?? null] as const,
  styles: (p?: string) =>
    p ? (["styles", p] as const) : (["styles"] as const),
  style: (id: string) => ["styles", "detail", id] as const,
  ttsVoices: (p: string) => ["projects", p, "tts", "voices"] as const,
  modelGateway: () => ["model-gateway", "config"] as const,
  releaseNotifications: (locale: string) => ["release-notifications", locale] as const,
};
