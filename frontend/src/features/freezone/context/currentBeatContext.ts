// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { NO_CHARACTER_MARKER, NO_PROP_MARKER } from "@/lib/beat-markers";
import {
  extractMainlineContextsFromNode,
  type MainlineContext,
  type MainlineContextNodeLike,
} from "@/features/freezone/context/mainlineContext";

export interface CurrentBeatContext {
  episode?: number;
  beat?: number;
  scene_id?: string;
  visual_description?: string;
  narration_segment?: string;
  detected_identities?: string[];
  detected_props?: string[];
  sketch_colors?: Record<string, string>;
  prop_marker_colors?: Record<string, string>;
  [key: string]: unknown;
}

export interface BeatContextVisualMarkers {
  identities: string[];
  props: string[];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function unique(items: string[]): string[] {
  return items.filter((item, index, values) => values.indexOf(item) === index);
}

function appendUnique(target: string[], value: string): void {
  const normalized = value.trim();
  if (normalized && !target.includes(normalized)) {
    target.push(normalized);
  }
}

export function parseBeatContextVisualMarkers(text: string): BeatContextVisualMarkers {
  const identities: string[] = [];
  const props: string[] = [];
  for (const match of text.matchAll(/\{\{([^{}]+)\}\}/gu)) {
    appendUnique(identities, match[1]);
  }
  for (const match of text.matchAll(/\[\[([^\[\]]+)\]\]/gu)) {
    appendUnique(props, match[1]);
  }
  return { identities, props };
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    const normalizedKey = key.trim();
    const normalizedValue = String(item || "").trim();
    if (normalizedKey && normalizedValue) {
      out[normalizedKey] = normalizedValue;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeStringMaps(
  ...maps: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged = Object.assign({}, ...maps.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function hasMainlineBeatProvenance(node: MainlineContextNodeLike | null | undefined): boolean {
  return extractMainlineContextsFromNode(node).some((context) => context.kind === "beat");
}

function isStandaloneBeatContext(context: Record<string, unknown> | undefined): boolean {
  return nonEmptyString(context?.source) === "standalone";
}

export function getCurrentBeatContextFromNode(
  node: MainlineContextNodeLike | null | undefined,
): CurrentBeatContext | undefined {
  const data = recordValue(node?.data) ?? {};
  const explicitBeatContext = recordValue(data.beat_context);
  if (explicitBeatContext && (!hasMainlineBeatProvenance(node) || !isStandaloneBeatContext(explicitBeatContext))) {
    const visualDescription = nonEmptyString(explicitBeatContext.visual_description);
    if (isStandaloneBeatContext(explicitBeatContext) && visualDescription) {
      const markers = parseBeatContextVisualMarkers(visualDescription);
      return {
        ...explicitBeatContext,
        // 「无角色出场 / 无道具」哨兵不会出现在 {{}} / [[]] 标记里，过滤时必须保留，
        // 否则 Render 会把用户显式选择的空镜判为「尚未标注出场身份」。
        detected_identities: stringList(explicitBeatContext.detected_identities).filter(
          (id) => id === NO_CHARACTER_MARKER || markers.identities.includes(id),
        ),
        detected_props: stringList(explicitBeatContext.detected_props).filter(
          (id) => id === NO_PROP_MARKER || markers.props.includes(id),
        ),
      };
    }
    return { ...explicitBeatContext };
  }

  const snapshot = recordValue(data.snapshot);
  const editFields = recordValue(data.beat_edit_fields);
  const episode =
    numericValue(data.episode) ??
    numericValue(snapshot?.episode) ??
    numericValue(snapshot?.episode_number);
  const beat =
    numericValue(data.beat) ??
    numericValue(data.beat_number) ??
    numericValue(snapshot?.beat) ??
    numericValue(snapshot?.beat_number);
  const sceneId =
    nonEmptyString(editFields?.scene_id) ??
    nonEmptyString(editFields?.sceneId) ??
    nonEmptyString(snapshot?.sceneId) ??
    nonEmptyString(snapshot?.scene_id) ??
    nonEmptyString(data.sceneId) ??
    nonEmptyString(data.scene_id);
  const visualDescription =
    nonEmptyString(editFields?.visual_description) ??
    nonEmptyString(editFields?.visualDescription) ??
    nonEmptyString(snapshot?.visualDescription) ??
    nonEmptyString(snapshot?.visual_description) ??
    nonEmptyString(data.content);
  const narrationSegment =
    nonEmptyString(editFields?.narration_segment) ??
    nonEmptyString(editFields?.narrationSegment) ??
    nonEmptyString(snapshot?.narrationSegment) ??
    nonEmptyString(snapshot?.narration_segment);
  const detectedIdentities = unique([
    ...stringList(editFields?.detected_identities),
    ...stringList(editFields?.detectedIdentities),
    ...stringList(snapshot?.detectedIdentities),
    ...stringList(snapshot?.detected_identities),
    ...stringList(data.detected_identities),
    ...stringList(data.detectedIdentities),
  ]);
  const detectedProps = unique([
    ...stringList(editFields?.detected_props),
    ...stringList(editFields?.detectedProps),
    ...stringList(snapshot?.detectedProps),
    ...stringList(snapshot?.detected_props),
    ...stringList(data.detected_props),
    ...stringList(data.detectedProps),
  ]);
  const sketchColors = mergeStringMaps(
    stringMap(data.sketch_colors),
    stringMap(data.sketchColors),
    stringMap(snapshot?.sketch_colors),
    stringMap(snapshot?.sketchColors),
    stringMap(editFields?.sketch_colors),
    stringMap(editFields?.sketchColors),
  );
  const propMarkerColors = mergeStringMaps(
    stringMap(data.prop_marker_colors),
    stringMap(data.propMarkerColors),
    stringMap(snapshot?.prop_marker_colors),
    stringMap(snapshot?.propMarkerColors),
    stringMap(editFields?.prop_marker_colors),
    stringMap(editFields?.propMarkerColors),
  );

  const context: CurrentBeatContext = {};
  if (episode !== undefined) context.episode = episode;
  if (beat !== undefined) context.beat = beat;
  if (sceneId) context.scene_id = sceneId;
  if (visualDescription) context.visual_description = visualDescription;
  if (narrationSegment) context.narration_segment = narrationSegment;
  if (detectedIdentities.length > 0) context.detected_identities = detectedIdentities;
  if (detectedProps.length > 0) context.detected_props = detectedProps;
  if (sketchColors) context.sketch_colors = sketchColors;
  if (propMarkerColors) context.prop_marker_colors = propMarkerColors;
  return Object.keys(context).length > 0 ? context : undefined;
}

export function currentBeatContextToMainlineContext(
  context: CurrentBeatContext,
  projectId = "__canvas__",
): MainlineContext {
  return {
    kind: "beat",
    projectId,
    episode: typeof context.episode === "number" ? context.episode : undefined,
    beat: typeof context.beat === "number" ? context.beat : undefined,
    sceneId: nonEmptyString(context.scene_id),
    visualDescription: nonEmptyString(context.visual_description),
    narrationSegment: nonEmptyString(context.narration_segment),
    detectedIdentities: stringList(context.detected_identities),
    detectedProps: stringList(context.detected_props),
    sketchColors: stringMap(context.sketch_colors),
    propMarkerColors: stringMap(context.prop_marker_colors),
  };
}
