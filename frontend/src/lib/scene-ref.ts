// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { STANDARD_TIME_OF_DAY_OPTIONS } from "@/features/canvas/domain/timeOfDay";

export interface SceneRefLike {
  scene_id?: string | null;
  variant_id?: string | null;
}

export interface SceneRefRecordLike {
  name?: string | null;
  scene_id?: string | null;
  base_scene_id?: string | null;
  variant_id?: string | null;
  time_of_day?: string | null;
}

export interface SceneRefValue {
  scene_id: string;
  variant_id: string;
  plate_time_of_day: string;
}

const STANDARD_TIME_OF_DAY_SET = new Set<string>(STANDARD_TIME_OF_DAY_OPTIONS);

function trimValue(value: unknown): string {
  return String(value || "").trim();
}

function refFromRecord(record: SceneRefRecordLike): SceneRefValue | null {
  const recordName = trimValue(record.name || record.scene_id);
  const baseSceneId = trimValue(record.base_scene_id);
  const variantId = trimValue(record.variant_id);
  const timeOfDay = trimValue(record.time_of_day);
  if (!recordName) return null;
  if (baseSceneId) {
    return {
      scene_id: baseSceneId,
      variant_id: variantId,
      plate_time_of_day: timeOfDay,
    };
  }
  if (!variantId && !timeOfDay) return null;
  return {
    scene_id: recordName,
    variant_id: variantId,
    plate_time_of_day: timeOfDay,
  };
}

// Prefer structured scene metadata. The suffix parser is only for old records
// and manual names that predate base_scene_id / variant_id / time_of_day.
export function sceneNameToRef(
  name: string,
  records?: SceneRefRecordLike[],
): SceneRefValue {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { scene_id: "", variant_id: "", plate_time_of_day: "" };
  const record = records?.find((item) => trimValue(item.name || item.scene_id) === trimmed);
  const structured = record ? refFromRecord(record) : null;
  if (structured) return structured;

  let withoutTime = trimmed;
  let plateTimeOfDay = "";
  const lastSeparator = trimmed.lastIndexOf("_");
  if (lastSeparator > 0 && lastSeparator < trimmed.length - 1) {
    const tail = trimmed.slice(lastSeparator + 1);
    if (STANDARD_TIME_OF_DAY_SET.has(tail)) {
      withoutTime = trimmed.slice(0, lastSeparator);
      plateTimeOfDay = tail;
    }
  }
  const separatorIndex = withoutTime.lastIndexOf("_");
  if (separatorIndex <= 0 || separatorIndex >= withoutTime.length - 1) {
    return { scene_id: withoutTime, variant_id: "", plate_time_of_day: plateTimeOfDay };
  }
  return {
    scene_id: withoutTime.slice(0, separatorIndex),
    variant_id: withoutTime.slice(separatorIndex + 1),
    plate_time_of_day: plateTimeOfDay,
  };
}

export function sceneRefToName(ref: SceneRefLike | null | undefined): string {
  const sceneId = String(ref?.scene_id || "").trim();
  const variantId = String(ref?.variant_id || "").trim();
  return sceneId && variantId ? `${sceneId}_${variantId}` : sceneId;
}
