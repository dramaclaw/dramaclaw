// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Canonical backend task_type strings emitted by supertale-be.
 * Verified against:
 * - FE deep-link map at `src/routes/_app/projects.$project/tasks.tsx:29-72`
 * - FE compose call at `src/routes/_app/projects.$project/episodes.$episode/compose.lazy.tsx:59`
 * - FE video call at `src/routes/_app/projects.$project/episodes.$episode/video.lazy.tsx:133`
 *
 * When adding a new task type, add the literal here first — consumers
 * (registry, deep-link map, drawer) read from this module.
 */
export const TASK_TYPES = {
  // Project-level
  BUILD_CHARACTERS: "build_characters",
  INGEST_FAST: "ingest_fast",
  BUILD_EPISODES: "build_episodes",
  CHARACTER_PORTRAIT: "character_portrait",
  IDENTITY_IMAGE: "identity_image",
  IDENTITY_PORTRAIT: "identity_portrait",
  // Script
  SCRIPT_WRITER: "script_writer",
  LITERAL_SCRIPT_WRITER: "literal_script_writer",
  BEAT_VIDEO_PROMPT: "beat_video_prompt",
  // Backend emits `director_notes`; keep the FE key aligned with that exact
  // task_type so the task stream and cancel endpoint target the same task.
  DIRECTOR_NOTES: "director_notes",
  IDENTITY_PLANNER: "identity_planner",
  EPISODE_SCENE_PLANNER: "episode_scene_planner",
  EPISODE_PROP_PLANNER: "episode_prop_planner",
  // Sketch
  SKETCH_GENERATION: "sketch_generation",
  BATCH_SKETCH: "batch_sketch",
  SKETCH_REGEN: "sketch_regen",
  GRID_REGENERATE: "grid_regenerate",
  // Audio
  AUDIO_GENERATION: "audio_generation",
  AUDIO_GENERATION_INDEXTTS2: "audio_generation_indextts2",
  // Video
  SINGLE_VIDEO: "single_video",
  GLOBAL_OPTIMIZE_VIDEO: "global_optimize_video",
  SELECTED_REGEN: "selected_regen",
  // Compose — BE emits `compose_episode` (task_identity.py); FE used
  // `video_compose` which caused the same infinite-spinner class of bug
  // we hit with script_writer / staging.
  COMPOSE_EPISODE: "compose_episode",
} as const;

export type TaskType = (typeof TASK_TYPES)[keyof typeof TASK_TYPES];

/**
 * Task types classified as batch (episode-wide, no per-beat attribution)
 * vs scoped (carry beat_num). `useBeatStates` uses this to decide whether
 * a failed task can attribute failure to a specific beat.
 */
export const SCOPED_TASK_TYPES = new Set<TaskType>([
  TASK_TYPES.SINGLE_VIDEO,
  TASK_TYPES.BEAT_VIDEO_PROMPT,
  TASK_TYPES.GRID_REGENERATE,
  TASK_TYPES.SKETCH_REGEN,
  TASK_TYPES.SELECTED_REGEN,
]);

export function isScopedTask(type: string): boolean {
  return SCOPED_TASK_TYPES.has(type as TaskType);
}
