// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  collectNodeMainlineContexts,
  extractMainlineContextsFromNode,
  type MainlineContext,
  type MainlineContextEdgeLike,
  type MainlineContextNodeLike,
} from "@/features/freezone/context/mainlineContext";
import {
  currentBeatContextToMainlineContext,
  getCurrentBeatContextFromNode,
} from "@/features/freezone/context/currentBeatContext";

export type ContextPromptPaletteEntryKind = "actor" | "prop";

export interface ContextPromptPaletteEntry {
  kind: ContextPromptPaletteEntryKind;
  id: string;
  label: string;
  named: boolean;
  color: string;
}

export interface ContextPromptPalette {
  actorEntries: ContextPromptPaletteEntry[];
  propEntries: ContextPromptPaletteEntry[];
  hasEntries: boolean;
}

export function buildContextPromptPalette(contexts: MainlineContext[]): ContextPromptPalette {
  const beat = contexts.find((ctx) => ctx.kind === "beat" && contextHasPaletteColors(ctx));
  const resolvedActorEntries = defaultColorEntries(
    "actor",
    DEFAULT_ACTOR_COLORS,
    namedEntriesByColor("actor", beat?.sketchColors),
  );
  const resolvedPropEntries = defaultColorEntries(
    "prop",
    DEFAULT_PROP_COLORS,
    namedEntriesByColor("prop", beat?.propMarkerColors),
  );
  return {
    actorEntries: resolvedActorEntries,
    propEntries: resolvedPropEntries,
    hasEntries: resolvedActorEntries.length > 0 || resolvedPropEntries.length > 0,
  };
}

export function buildContextPromptPaletteForNode(
  nodes: MainlineContextNodeLike[],
  edges: MainlineContextEdgeLike[],
  targetNodeId: string,
): ContextPromptPalette {
  const directPalette = buildContextPromptPalette(
    collectNodeMainlineContexts(nodes, edges, targetNodeId),
  );
  if (hasNamedEntries(directPalette)) return directPalette;

  const canvasBeatContexts = collectCanvasBeatPaletteContexts(nodes);
  return buildContextPromptPalette(canvasBeatContexts.length === 1 ? canvasBeatContexts : []);
}

/**
 * 点一下就插进提示词输入框的那句话。它跟着上游镜头上下文一起发给模型，
 * 模型认的是这套中文表述，跟界面语言无关。
 */
// i18n-exempt-start
export function contextPromptPaletteInsertionText(entry: ContextPromptPaletteEntry): string {
  if (entry.kind === "actor") {
    if (!entry.named) return `${entry.color} 标记的人物`;
    return `${entry.color} 标记的人物「${entry.label}」`;
  }
  if (!entry.named) return `${entry.color} 标记的道具`;
  return `${entry.color} 标记的道具「${entry.label}」`;
}
// i18n-exempt-end

// Keep these in sync with the backend director-world anonymous palettes:
// BRIDGMAN_CHARACTER_PALETTE and PROP_MARKER_PALETTE.
const DEFAULT_ACTOR_COLORS = [
  "#FF00FF",
  "#00FFFF",
  "#CCFF00",
  "#FF6B00",
  "#7C4DFF",
  "#00FF66",
  "#00A2FF",
  "#FFD400",
  "#9D00FF",
  "#00FFCC",
  "#39FF14",
  "#5C6BC0",
] as const;

const DEFAULT_PROP_COLORS = [
  "#B71C1C",
  "#6D4C41",
  "#827717",
  "#1B5E20",
  "#006064",
  "#0D47A1",
  "#311B92",
  "#7B1FA2",
  "#880E4F",
  "#3E2723",
] as const;

function collectCanvasBeatPaletteContexts(nodes: MainlineContextNodeLike[]): MainlineContext[] {
  const out: MainlineContext[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const currentBeatContext = getCurrentBeatContextFromNode(node);
    if (node.type === "beatContextNode" && currentBeatContext) {
      const projectId = typeof node.data?.projectId === "string" && node.data.projectId.trim()
        ? node.data.projectId.trim()
        : "__canvas__";
      const ctx = currentBeatContextToMainlineContext(currentBeatContext, projectId);
      if (contextHasPaletteColors(ctx)) {
        const key = JSON.stringify([node.id, ctx.projectId, ctx.episode, ctx.beat]);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(ctx);
        }
      }
      continue;
    }
    for (const ctx of extractMainlineContextsFromNode(node)) {
      if (ctx.kind !== "beat" || !contextHasPaletteColors(ctx)) continue;
      const key = JSON.stringify([ctx.projectId, ctx.episode, ctx.beat]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ctx);
    }
  }
  return out;
}

function contextHasPaletteColors(ctx: MainlineContext): boolean {
  return hasColorMap(ctx.sketchColors) || hasColorMap(ctx.propMarkerColors);
}

function hasColorMap(map: Record<string, string> | undefined): boolean {
  return Boolean(map && Object.keys(map).length > 0);
}

function hasNamedEntries(palette: ContextPromptPalette): boolean {
  return (
    palette.actorEntries.some((entry) => entry.named)
    || palette.propEntries.some((entry) => entry.named)
  );
}

function namedEntriesByColor(
  kind: ContextPromptPaletteEntryKind,
  map: Record<string, string> | undefined,
): Map<string, ContextPromptPaletteEntry> {
  const out = new Map<string, ContextPromptPaletteEntry>();
  if (!map) return out;
  const namedEntries = Object.entries(map)
    .map(([id, rawColor]): ContextPromptPaletteEntry | null => {
      const color = normalizeHexColor(rawColor);
      if (!color) return null;
      return {
        kind,
        id,
        label: labelFromPaletteId(id),
        named: true,
        color,
      };
    })
    .filter((entry): entry is ContextPromptPaletteEntry => Boolean(entry))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
  for (const entry of namedEntries) {
    if (!out.has(entry.color)) {
      out.set(entry.color, entry);
    }
  }
  return out;
}

function defaultColorEntries(
  kind: ContextPromptPaletteEntryKind,
  colors: readonly string[],
  namedByColor: Map<string, ContextPromptPaletteEntry> = new Map(),
): ContextPromptPaletteEntry[] {
  return colors.map((color) => (
    namedByColor.get(color) ?? {
      kind,
      id: `${kind}:${color}`,
      label: "",
      named: false,
      color,
    }
  ));
}

function normalizeHexColor(value: string): string | null {
  const color = value.trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(color)) return color;
  return null;
}

function labelFromPaletteId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return id;
  const colon = trimmed.lastIndexOf(":");
  return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
}
