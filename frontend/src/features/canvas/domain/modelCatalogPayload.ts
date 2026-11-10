// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ModelOption } from './modelOptions';
import { readReferenceMediaLimits, type ReferenceMediaLimits } from './referenceMediaLimits';
export type FreezoneProvider =
  | "newapi"
  | "openrouter"
  | "huimeng"
  | "openai";
export type FreezoneVideoResolution = string;
export type MediaModelParameterControl = "select" | "number" | "switch" | "text" | "multiselect";
export interface MediaModelParameterDefinition {
  key: string;
  label: string;
  control: MediaModelParameterControl;
  requestPath: string;
  options?: Array<string | number | boolean>;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  modes?: string[];
}
export interface MediaModelRequestSchema {
  endpoint: "images/generations" | "video/generations" | "audio/speech";
  parameters?: MediaModelParameterDefinition[];
  omitPaths?: string[];
}

export interface FreezoneImageModelInfo extends ReferenceMediaLimits {
  /** Opaque database identity used by new billing and task records. */
  catalogId?: string;
  /** Stable picker id, e.g. `"newapi_gpt_image2"`. */
  id: string;
  /** Provider tab id (`huimeng` / `openrouter` / `openai`). */
  providerId: FreezoneProvider;
  /** Value sent to backend `model` field. */
  apiModel: string;
  /** Display label in the model chip. */
  label: string;
  resolutionOptions?: string[];
  qualityOptions?: string[];
  ratioOptions?: string[];
  referenceImageMax?: number | null;
  request?: MediaModelRequestSchema;
}

// Provider inference for raw model strings the backend may return without
// metadata (e.g. just a flat string list). Order matters — first match wins.
const MODEL_PROVIDER_HINTS: Array<{
  match: (raw: string) => boolean;
  providerId: FreezoneProvider;
}> = [
  { match: (s) => s.toLowerCase().startsWith("huimeng"), providerId: "huimeng" },
  { match: (s) => s.toLowerCase().includes("/gemini"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("google/"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("anthropic/"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("openrouter/"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("gpt-image"), providerId: "openai" },
  { match: (s) => s.toLowerCase().startsWith("dall-e"), providerId: "openai" },
];

function inferProvider(raw: string): FreezoneProvider {
  for (const hint of MODEL_PROVIDER_HINTS) {
    if (hint.match(raw)) return hint.providerId;
  }
  return "huimeng";
}

export function pickString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function pickStringArray(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.length > 0);
    }
  }
  return [];
}

function pickMediaRequestSchema(value: unknown): MediaModelRequestSchema | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schema = value as Record<string, unknown>;
  if (typeof schema.endpoint !== "string") return undefined;
  return schema as unknown as MediaModelRequestSchema;
}

function normalizeProviderId(raw: string | null): FreezoneProvider | null {
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (
    lowered === "newapi" ||
    lowered === "huimeng" ||
    lowered === "openrouter" ||
    lowered === "openai"
  ) {
    return lowered;
  }
  return null;
}

function modelEntryFromObject(entry: Record<string, unknown>): FreezoneImageModelInfo | null {
  const apiModel = pickString(entry, "model", "apiModel", "api_model", "name");
  if (!apiModel) return null;
  const providerId =
    normalizeProviderId(pickString(entry, "providerId", "provider_id", "provider")) ??
    inferProvider(apiModel);
  const id = pickString(entry, "id") ?? `${providerId}/${apiModel}`;
  const label = pickString(entry, "label", "displayName", "display_name") ?? apiModel;
  const catalogId = pickString(entry, "catalogId", "catalog_id");
  return {
    ...(catalogId ? { catalogId } : {}),
    id,
    providerId,
    apiModel,
    label,
    resolutionOptions: pickStringArray(entry, "resolutionOptions", "resolution_options"),
    qualityOptions: pickStringArray(entry, "qualityOptions", "quality_options"),
    ratioOptions: pickStringArray(entry, "ratioOptions", "ratio_options"),
    ...readReferenceMediaLimits(entry),
    referenceImageMax: pickNumber(entry, "referenceImageMax", "reference_image_max"),
    request: pickMediaRequestSchema(entry.request),
  };
}

function modelEntryFromString(raw: string): FreezoneImageModelInfo {
  const providerId = inferProvider(raw);
  return {
    id: `${providerId}/${raw}`,
    providerId,
    apiModel: raw,
    label: raw,
  };
}

export function coerceModelList(payload: unknown): FreezoneImageModelInfo[] {
  // Accept several shapes the backend might return — schema is empty in
  // openapi.json so we normalize defensively rather than guess one shape.
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.models)) candidate = wrapper.models;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else {
      // provider→models[] map: { huimeng: [...], openrouter: [...] }
      const flattened: FreezoneImageModelInfo[] = [];
      for (const [providerRaw, value] of Object.entries(wrapper)) {
        const providerId = normalizeProviderId(providerRaw);
        if (!providerId || !Array.isArray(value)) continue;
        for (const item of value) {
          if (typeof item === "string") {
            flattened.push({
              id: `${providerId}/${item}`,
              providerId,
              apiModel: item,
              label: item,
            });
          } else if (item && typeof item === "object") {
            const entry = modelEntryFromObject(item as Record<string, unknown>);
            if (entry) flattened.push({ ...entry, providerId });
          }
        }
      }
      if (flattened.length > 0) return flattened;
    }
  }

  if (!Array.isArray(candidate)) return [];
  const result: FreezoneImageModelInfo[] = [];
  for (const item of candidate) {
    if (typeof item === "string") {
      result.push(modelEntryFromString(item));
    } else if (item && typeof item === "object") {
      const entry = modelEntryFromObject(item as Record<string, unknown>);
      if (entry) result.push(entry);
    }
  }
  return result;
}


// /freezone/video/models -------------------------------------------------- //

/** Provider tab id for video generation models. */
export type FreezoneVideoProvider = "newapi" | "seedance" | "huimeng";

export interface FreezoneVideoModelInfo extends ReferenceMediaLimits {
  /** Opaque database identity used by new billing and task records. */
  catalogId?: string;
  /** Stable picker id, e.g. `"seedance_2"` (backend currently keys by api id). */
  id: string;
  /** Provider tab id (`seedance` / `huimeng`). */
  providerId: FreezoneVideoProvider;
  /** Value sent to backend `/freezone/video/gen` `model` field. */
  apiModel: string;
  /** Display label in the model chip. */
  label: string;
  /** Supported output resolution values for this model, when advertised by backend. */
  resolutionOptions?: FreezoneVideoResolution[];
  humanReview?: boolean;
  /** Whether this model can produce native synchronized audio. Missing means legacy-supported. */
  supportsGenerateAudio?: boolean;
  /** Smallest supported duration in seconds, when advertised by backend. */
  minDuration?: number | null;
  /** Largest supported duration in seconds, when advertised by backend. */
  maxDuration?: number | null;
  /** Supported Seedance 2.0 Value style hints, when advertised by backend. */
  sceneOptimizeOptions?: Array<"anime" | "realistic">;
  /** Default Seedance 2.0 Value style hint, when advertised by backend. */
  defaultSceneOptimize?: "anime" | "realistic" | null;
  ratioOptions?: string[];
  supportedModes?: string[];
  referenceImageMax?: number | null;
  referenceVideoMax?: number | null;
  referenceAudioMax?: number | null;
  referenceFileMax?: number | null;
  referenceLinkMax?: number | null;
  referenceFileTypes?: string[];
  referenceAudioMinSeconds?: number | null;
  referenceAudioMaxSeconds?: number | null;
  referenceAudioTotalMinSeconds?: number | null;
  /** Total reference audio limit in seconds. */
  referenceAudioTotalMaxSeconds?: number | null;
  referenceVideoMinSeconds?: number | null;
  referenceVideoMaxSeconds?: number | null;
  referenceVideoTotalMinSeconds?: number | null;
  referenceVideoTotalMaxSeconds?: number | null;
  request?: MediaModelRequestSchema;
}

// Provider inference for raw model ids the backend may return without
// metadata. Order matters — first match wins. Anything we don't recognize
// falls back to `seedance` (the primary provider).
const VIDEO_MODEL_PROVIDER_HINTS: Array<{
  match: (raw: string) => boolean;
  providerId: FreezoneVideoProvider;
}> = [
  { match: (s) => s.toLowerCase().startsWith("huimeng"), providerId: "huimeng" },
  { match: (s) => s.toLowerCase().startsWith("seedance"), providerId: "seedance" },
];

function inferVideoProvider(raw: string): FreezoneVideoProvider {
  for (const hint of VIDEO_MODEL_PROVIDER_HINTS) {
    if (hint.match(raw)) return hint.providerId;
  }
  return "seedance";
}

function normalizeVideoProviderId(raw: string | null): FreezoneVideoProvider | null {
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (lowered === "newapi" || lowered === "seedance" || lowered === "huimeng") return lowered;
  return null;
}

function videoModelEntryFromObject(
  entry: Record<string, unknown>,
): FreezoneVideoModelInfo | null {
  const apiModel = pickString(entry, "model", "apiModel", "api_model", "name");
  if (!apiModel) return null;
  const providerId =
    normalizeVideoProviderId(pickString(entry, "providerId", "provider_id", "provider")) ??
    inferVideoProvider(apiModel);
  const id = pickString(entry, "id") ?? apiModel;
  const label = pickString(entry, "label", "displayName", "display_name") ?? apiModel;
  const catalogId = pickString(entry, "catalogId", "catalog_id");
  const resolutionOptions = pickStringArray(entry, "resolutionOptions", "resolution_options");
  const sceneOptimizeOptions = pickStringArray(entry, "sceneOptimizeOptions", "scene_optimize_options")
    .map((value) => value.toLowerCase())
    .filter((value): value is "anime" | "realistic" =>
      value === "anime" || value === "realistic"
    );
  const defaultSceneOptimizeRaw = pickString(entry, "defaultSceneOptimize", "default_scene_optimize")
    ?.toLowerCase();
  const defaultSceneOptimize =
    defaultSceneOptimizeRaw === "anime" || defaultSceneOptimizeRaw === "realistic"
      ? defaultSceneOptimizeRaw
      : null;
  return {
    ...(catalogId ? { catalogId } : {}),
    id,
    providerId,
    apiModel,
    label,
    ...(resolutionOptions.length > 0 ? { resolutionOptions } : {}),
    humanReview: pickBoolean(entry, "humanReview", "human_review"),
    supportsGenerateAudio: pickBoolean(
      entry,
      "supportsGenerateAudio",
      "supports_generate_audio",
    ),
    minDuration: pickNumber(entry, "minDuration", "min_duration"),
    maxDuration: pickNumber(entry, "maxDuration", "max_duration"),
    ...(sceneOptimizeOptions.length > 0 ? { sceneOptimizeOptions } : {}),
    defaultSceneOptimize,
    ratioOptions: pickStringArray(entry, "ratioOptions", "ratio_options"),
    supportedModes: pickStringArray(entry, "supportedModes", "supported_modes"),
    referenceImageMax: pickNumber(entry, "referenceImageMax", "reference_image_max"),
    ...readReferenceMediaLimits(entry),
    referenceVideoMax: pickNumber(entry, "referenceVideoMax", "reference_video_max"),
    referenceAudioMax: pickNumber(entry, "referenceAudioMax", "reference_audio_max"),
    referenceFileMax: pickNumber(entry, "referenceFileMax", "reference_file_max"),
    referenceLinkMax: pickNumber(entry, "referenceLinkMax", "reference_link_max"),
    referenceFileTypes: pickStringArray(entry, "referenceFileTypes", "reference_file_types"),
    referenceAudioMinSeconds: pickNumber(
      entry,
      "referenceAudioMinSeconds",
      "reference_audio_min_seconds",
    ),
    referenceAudioMaxSeconds: pickNumber(
      entry,
      "referenceAudioMaxSeconds",
      "reference_audio_max_seconds",
    ),
    referenceAudioTotalMinSeconds: pickNumber(
      entry,
      "referenceAudioTotalMinSeconds",
      "reference_audio_total_min_seconds",
    ),
    referenceAudioTotalMaxSeconds: pickNumber(
      entry,
      "referenceAudioTotalMaxSeconds",
      "reference_audio_total_max_seconds",
    ),
    referenceVideoMinSeconds: pickNumber(
      entry,
      "referenceVideoMinSeconds",
      "reference_video_min_seconds",
    ),
    referenceVideoMaxSeconds: pickNumber(
      entry,
      "referenceVideoMaxSeconds",
      "reference_video_max_seconds",
    ),
    referenceVideoTotalMinSeconds: pickNumber(
      entry,
      "referenceVideoTotalMinSeconds",
      "reference_video_total_min_seconds",
    ),
    referenceVideoTotalMaxSeconds: pickNumber(
      entry,
      "referenceVideoTotalMaxSeconds",
      "reference_video_total_max_seconds",
    ),
    request: pickMediaRequestSchema(entry.request),
  };
}

function videoModelEntryFromString(raw: string): FreezoneVideoModelInfo {
  const providerId = inferVideoProvider(raw);
  return {
    id: raw,
    providerId,
    apiModel: raw,
    label: raw,
  };
}

export function coerceVideoModelList(payload: unknown): FreezoneVideoModelInfo[] {
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.models)) candidate = wrapper.models;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else {
      // provider→models[] map: { seedance: [...], huimeng: [...] }
      const flattened: FreezoneVideoModelInfo[] = [];
      for (const [providerRaw, value] of Object.entries(wrapper)) {
        const providerId = normalizeVideoProviderId(providerRaw);
        if (!providerId || !Array.isArray(value)) continue;
        for (const item of value) {
          if (typeof item === "string") {
            flattened.push({
              id: item,
              providerId,
              apiModel: item,
              label: item,
            });
          } else if (item && typeof item === "object") {
            const entry = videoModelEntryFromObject(item as Record<string, unknown>);
            if (entry) flattened.push({ ...entry, providerId });
          }
        }
      }
      if (flattened.length > 0) return flattened;
    }
  }

  if (!Array.isArray(candidate)) return [];
  const result: FreezoneVideoModelInfo[] = [];
  for (const item of candidate) {
    if (typeof item === "string") {
      result.push(videoModelEntryFromString(item));
    } else if (item && typeof item === "object") {
      const entry = videoModelEntryFromObject(item as Record<string, unknown>);
      if (entry) result.push(entry);
    }
  }
  return result;
}



export function imageModelOptionsFromPayload(data: unknown): ModelOption[] {
  return toModelOptions(coerceModelList(data));
}

export function videoModelOptionsFromPayload(data: unknown): ModelOption[] {
  return toModelOptions(coerceVideoModelList(data));
}

export function toModelOptions(models: ModelOption[]): ModelOption[] {
  return models;
}
