// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { ScrollText, Pencil, Mic2, Video, Film, type LucideIcon } from "lucide-react";
import { TASK_TYPES, type TaskType } from "@/lib/task-types";

export type StageId = "script" | "sketch" | "audio" | "video" | "compose";

export interface StageDef {
  id: StageId;
  labelKey: string;
  /** Path segment appended to `/projects/$project/episodes/$episode`. */
  routeSegment: "/script" | "/sketches" | "/audio" | "/video" | "/compose";
  icon: LucideIcon;
  /** Backend task types that belong to this stage (any of these running → stage is busy). */
  taskTypes: readonly TaskType[];
  /** Hard prerequisites. All must be `ready` for this stage's primary action to unlock. */
  dependsOn: readonly StageId[];
  /** True if the stage supports per-beat navigation (drawer can open to it). */
  supportsBeatJump: boolean;
}

export const EPISODE_STAGE_REGISTRY: readonly StageDef[] = [
  {
    id: "script",
    labelKey: "episode.stage.script",
    routeSegment: "/script",
    icon: ScrollText,
    taskTypes: [
      TASK_TYPES.SCRIPT_WRITER,
      TASK_TYPES.LITERAL_SCRIPT_WRITER,
      TASK_TYPES.DIRECTOR_NOTES,
      TASK_TYPES.IDENTITY_PLANNER,
    ],
    dependsOn: [],
    supportsBeatJump: true,
  },
  {
    id: "sketch",
    labelKey: "episode.stage.sketch",
    routeSegment: "/sketches",
    icon: Pencil,
    taskTypes: [
      TASK_TYPES.SKETCH_GENERATION,
      TASK_TYPES.SKETCH_GRID_GENERATION,
      TASK_TYPES.BATCH_SKETCH,
      TASK_TYPES.SKETCH_REGEN,
      TASK_TYPES.GRID_REGENERATE,
    ],
    dependsOn: ["script"],
    supportsBeatJump: true,
  },
  {
    id: "audio",
    labelKey: "episode.stage.audio",
    routeSegment: "/audio",
    icon: Mic2,
    taskTypes: [
      TASK_TYPES.AUDIO_GENERATION_INDEXTTS2,
      TASK_TYPES.AUDIO_GENERATION,
    ],
    dependsOn: ["script"],
    supportsBeatJump: true,
  },
  {
    id: "video",
    labelKey: "episode.stage.video",
    routeSegment: "/video",
    icon: Video,
    taskTypes: [
      TASK_TYPES.SINGLE_VIDEO,
      TASK_TYPES.GLOBAL_OPTIMIZE_VIDEO,
      TASK_TYPES.SELECTED_REGEN,
    ],
    dependsOn: ["sketch"],
    supportsBeatJump: true,
  },
  {
    id: "compose",
    labelKey: "episode.stage.compose",
    routeSegment: "/compose",
    icon: Film,
    taskTypes: [TASK_TYPES.COMPOSE_EPISODE],
    dependsOn: ["sketch", "video", "audio"],
    supportsBeatJump: false,
  },
];

export const STAGES_BY_ID: Record<StageId, StageDef> = Object.fromEntries(
  EPISODE_STAGE_REGISTRY.map((s) => [s.id, s]),
) as Record<StageId, StageDef>;

/**
 * Look up the stage that owns a given backend task_type. Returns undefined
 * for project-level task types (build_characters, ingest_fast, build_episodes).
 */
export function stageForTaskType(taskType: string): StageDef | undefined {
  return EPISODE_STAGE_REGISTRY.find((s) =>
    (s.taskTypes as readonly string[]).includes(taskType),
  );
}
