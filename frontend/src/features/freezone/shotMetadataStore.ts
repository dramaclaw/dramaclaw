// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from "zustand";

export interface ShotMetadata {
  shot_type?: string;
  angle?: string;
  camera_movement?: string;
  subject_action?: string;
  mood?: string;
  color_tone?: string;
  /**
   * Free-form additions (lens_mm, aperture, fps, etc.). Frontend doesn't
   * enumerate these — anything in here gets serialized into the prompt.
   */
  extra?: Record<string, string>;
}

export const EMPTY_SHOT_METADATA: ShotMetadata = {};

interface ShotMetadataState {
  shot: ShotMetadata;
  /** True if any field is non-empty — drives the toolbar chip styling. */
  isActive: boolean;
  setShot: (shot: ShotMetadata) => void;
  clearShot: () => void;
  /** Replace from canvas hydrate (suppresses dirty save while loading). */
  hydrate: (shot: ShotMetadata) => void;
}

function deriveActive(shot: ShotMetadata): boolean {
  if (Object.values(shot).some((v) => typeof v === "string" && v.trim().length > 0)) {
    return true;
  }
  if (shot.extra && Object.values(shot.extra).some((v) => v && v.trim().length > 0)) {
    return true;
  }
  return false;
}

export const useShotMetadataStore = create<ShotMetadataState>((set) => ({
  shot: EMPTY_SHOT_METADATA,
  isActive: false,
  setShot: (shot) => set({ shot, isActive: deriveActive(shot) }),
  clearShot: () => set({ shot: EMPTY_SHOT_METADATA, isActive: false }),
  hydrate: (shot) => set({ shot, isActive: deriveActive(shot) }),
}));

/**
 * Render the current shot metadata into a single string ready to be appended
 * to a generation prompt. Empty fields are skipped. Returns "" when nothing
 * is set so callers can no-op.
 */
export function renderShotMetadataForPrompt(shot: ShotMetadata): string {
  const parts: string[] = [];
  // 这些字段名直接拼进发给模型的提示词，锁中文；界面上的镜头参数标签另有词条。
  // i18n-exempt-start
  const labelMap: Record<keyof ShotMetadata, string> = {
    shot_type: "景别",
    angle: "镜头角度",
    camera_movement: "运镜",
    subject_action: "主体动作",
    mood: "氛围",
    color_tone: "色调",
    extra: "",
  };
  // i18n-exempt-end
  for (const [key, label] of Object.entries(labelMap)) {
    if (key === "extra") continue;
    const v = shot[key as keyof ShotMetadata];
    if (typeof v === "string" && v.trim()) {
      parts.push(`${label}: ${v.trim()}`);
    }
  }
  if (shot.extra) {
    for (const [k, v] of Object.entries(shot.extra)) {
      if (v && v.trim()) parts.push(`${k}: ${v.trim()}`);
    }
  }
  if (parts.length === 0) return "";
  return `\n[镜头参数]\n${parts.join("\n")}`; // i18n-exempt —— 提示词里的段落头
}

/**
 * Per-node shot metadata override (v1.6η).
 *
 * Users can embed an inline block in any GenNode / EditNode's prompt:
 *
 *   ```
 *   a portrait
 *
 *   [shot]
 *   shot_type: 中景
 *   angle: 仰拍
 *   mood: 紧张
 *   [/shot]
 *   ```
 *
 * `parseInlineShotBlock` strips the block from the prompt and returns it as
 * a ShotMetadata. If present it overrides the canvas-level metadata for that
 * single generation.
 */
const INLINE_SHOT_BLOCK_RE = /\[shot\]([\s\S]*?)\[\/shot\]/i;
const RECOGNIZED_KEYS = new Set<keyof ShotMetadata>([
  "shot_type",
  "angle",
  "camera_movement",
  "subject_action",
  "mood",
  "color_tone",
]);

export function parseInlineShotBlock(
  prompt: string,
): { cleaned: string; override: ShotMetadata | null } {
  const match = INLINE_SHOT_BLOCK_RE.exec(prompt);
  if (!match) return { cleaned: prompt, override: null };

  const body = match[1];
  const override: ShotMetadata = {};
  const extra: Record<string, string> = {};
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key || !value) continue;
    if (RECOGNIZED_KEYS.has(key as keyof ShotMetadata)) {
      (override as Record<string, string>)[key] = value;
    } else {
      extra[key] = value;
    }
  }
  if (Object.keys(extra).length > 0) override.extra = extra;

  // Strip the block + collapse the now-empty surrounding whitespace lines.
  const cleaned = prompt
    .replace(INLINE_SHOT_BLOCK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { cleaned, override };
}

/**
 * Merge canvas-level + per-node shot metadata. Per-node fields win on conflict;
 * fields the per-node block doesn't mention fall through to the canvas default.
 */
export function mergeShotMetadata(
  canvasShot: ShotMetadata,
  nodeOverride: ShotMetadata | null,
): ShotMetadata {
  if (!nodeOverride) return canvasShot;
  const merged: ShotMetadata = { ...canvasShot };
  for (const key of RECOGNIZED_KEYS) {
    const v = nodeOverride[key];
    if (typeof v === "string" && v.trim()) {
      (merged as Record<string, string>)[key] = v;
    }
  }
  if (nodeOverride.extra) {
    merged.extra = { ...(canvasShot.extra ?? {}), ...nodeOverride.extra };
  }
  return merged;
}
