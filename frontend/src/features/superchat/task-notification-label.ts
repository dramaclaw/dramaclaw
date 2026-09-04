// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { displayLabel } from "@/task-center/derivations";
import type { TaskState } from "@/task-center/types";
import type { TFn } from "@/lib/i18n-types";

function stringRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const SCENE_KIND_KEYS = new Set(["master", "spatial_layout", "reverse_master"]);

function sceneKindLabel(kind: string, t: TFn): string {
  return SCENE_KIND_KEYS.has(kind)
    ? t(`tasks.chatLabel.sceneKind.${kind}`)
    : t("tasks.chatLabel.sceneKind.fallback");
}

function parseTaskScope(scope: string | null | undefined): string[] {
  return String(scope ?? "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function beatRangeLabel(beats: number[], t: TFn): string {
  if (beats.length === 0) return "";
  const sorted = [...new Set(beats)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];

  for (const beat of sorted.slice(1)) {
    if (beat === previous + 1) {
      previous = beat;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = beat;
    previous = beat;
  }

  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return t("tasks.chatLabel.beatRange", { ranges: ranges.join(", ") });
}

export function buildChatTaskLabel(task: Pick<
  TaskState,
  | "task_type"
  | "result"
  | "display_name"
  | "display_name_localizable"
  | "task_type_label"
  | "metadata"
  | "episode"
  | "beat_num"
  | "scope"
>, t: TFn): string {
  const result = stringRecord(task.result);
  const scopeParts = parseTaskScope(task.scope);

  if (task.task_type === "sketch_generation") {
    const gridIndex = Number(result.grid_index);
    const totalGrids = Number(result.total_grids);
    const hasGridNumber =
      Number.isInteger(gridIndex)
      && gridIndex >= 0
      && Number.isInteger(totalGrids)
      && totalGrids > 0;
    const gridLabel = hasGridNumber
      ? t("tasks.chatLabel.sketchGrid", { index: gridIndex + 1, total: totalGrids })
      : t("tasks.chatLabel.sketch");
    const label =
      task.episode > 0
        ? t("tasks.chatLabel.episodePrefixed", { episode: task.episode, label: gridLabel })
        : gridLabel;
    const beatLabel = beatRangeLabel(numberArray(result.beat_numbers), t);
    return beatLabel ? t("tasks.chatLabel.withBeats", { label, beats: beatLabel }) : label;
  }

  if (task.task_type === "scene_reference_asset") {
    const sceneName = stringValue(result.scene_name) || scopeParts[1] || "";
    const kind = stringValue(result.kind) || scopeParts[2] || "";
    const kindLabel = sceneKindLabel(kind, t);
    return sceneName
      ? t("tasks.chatLabel.sceneKind.named", { scene: sceneName, kind: kindLabel })
      : kindLabel;
  }

  if (task.task_type === "character_portrait") {
    const characterName = stringValue(result.character_name) || scopeParts[1] || "";
    const mode = stringValue(result.mode);
    const identityName = stringValue(result.identity_name) || scopeParts[3] || "";
    if (mode === "identity_portrait" || task.scope?.includes(":identity_portrait:")) {
      return characterName && identityName
        ? t("tasks.chatLabel.identityPortraitNamed", {
            character: characterName,
            identity: identityName,
          })
        : t("tasks.chatLabel.identityPortrait", {
            name: characterName || identityName || t("tasks.chatLabel.unknownCharacter"),
          });
    }
    return characterName
      ? t("tasks.chatLabel.characterPortraitNamed", { character: characterName })
      : t("tasks.chatLabel.characterPortrait");
  }

  if (task.task_type === "identity_image") {
    const characterName = stringValue(result.character_name) || scopeParts[1] || "";
    const identityName = stringValue(result.identity_name) || scopeParts[3] || "";
    if (characterName && identityName) {
      return t("tasks.chatLabel.identityImageNamed", {
        character: characterName,
        identity: identityName,
      });
    }
    return t("tasks.chatLabel.identityImage", {
      name: characterName || identityName || t("tasks.chatLabel.unknownCharacter"),
    });
  }

  if (task.beat_num != null && task.episode > 0) {
    return t("tasks.chatLabel.withEpisodeBeat", {
      label: displayLabel(task as TaskState, t),
      episode: task.episode,
      beat: task.beat_num,
    });
  }

  if (task.episode > 0) {
    return t("tasks.chatLabel.withEpisode", {
      label: displayLabel(task as TaskState, t),
      episode: task.episode,
    });
  }

  return displayLabel(task as TaskState, t);
}
