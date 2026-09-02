// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from "i18next";

export type MainlineContextKind =
  | "identity"
  | "voice"
  | "narrator_voice"
  | "bgm"
  | "sfx"
  | "ambient_audio"
  | "scene"
  | "prop"
  | "beat"
  | "sketch"
  | "frame"
  | "video"
  | "audio"
  | "director_combined"
  | "selected_background";

export interface MainlineContext {
  kind: MainlineContextKind;
  projectId: string;
  episode?: number;
  beat?: number;
  character?: string;
  identityId?: string;
  sceneId?: string;
  propId?: string;
  voiceId?: string;
  audioRole?:
    | "character_voice"
    | "narrator_voice"
    | "bgm"
    | "sfx"
    | "ambient"
    | "beat_audio";
  markerColor?: string;
  visualDescription?: string;
  narrationSegment?: string;
  detectedIdentities?: string[];
  detectedProps?: string[];
  sketchColors?: Record<string, string>;
  propMarkerColors?: Record<string, string>;
  role?: string;
  label?: string;
  sourceUrl?: string;
  [key: string]: unknown;
}

export interface MainlineContextNodeLike {
  id?: string;
  type?: string | null;
  data?: {
    mainline_context?: unknown;
    [key: string]: unknown;
  } | null;
}

export interface MainlineContextEdgeLike {
  source?: string;
  target?: string;
  data?: unknown;
}

export type MainlineEdgeKind =
  | "reference"
  | "workflow"
  | "role_binding"
  | "mainline_data"
  | "compare"
  | "annotation"
  | "candidate_binding";

export type CandidateBindingRole =
  | "background_candidate"
  | "sketch_candidate"
  | "frame_candidate"
  | "selected_background"
  | "current_sketch"
  | "current_frame";

export interface CandidateBinding {
  sourceNodeId: string;
  beatContextNodeId: string;
  role: CandidateBindingRole;
}

export interface PropagatingEdgeValidationResult {
  ok: boolean;
  reason: string;
  beatContextNodeIds: string[];
}

export interface BeatContextResolution {
  context: (MainlineContext & { episode: number; beat: number }) | null;
  beatContextNodeId: string | null;
}

export interface CandidateBindingRoleValidationResult {
  ok: boolean;
  reason: string;
}

const CANDIDATE_BINDING_ROLES = new Set<CandidateBindingRole>([
  "background_candidate",
  "sketch_candidate",
  "frame_candidate",
  "selected_background",
  "current_sketch",
  "current_frame",
]);

const CANONICAL_BEAT_BINDING_ROLES = new Set<CandidateBindingRole>([
  "selected_background",
  "current_sketch",
  "current_frame",
]);

const MAINLINE_CONTEXT_KINDS = new Set<MainlineContextKind>([
  "identity",
  "voice",
  "narrator_voice",
  "bgm",
  "sfx",
  "ambient_audio",
  "scene",
  "prop",
  "beat",
  "sketch",
  "frame",
  "video",
  "audio",
  "director_combined",
  "selected_background",
]);

const PROPAGATING_EDGE_KINDS = new Set<MainlineEdgeKind>([
  "workflow",
  "role_binding",
  "mainline_data",
]);

export function isMainlineContext(value: unknown): value is MainlineContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; projectId?: unknown };
  return (
    typeof candidate.kind === "string" &&
    MAINLINE_CONTEXT_KINDS.has(candidate.kind as MainlineContextKind) &&
    typeof candidate.projectId === "string" &&
    candidate.projectId.length > 0
  );
}

export function extractMainlineContextsFromNode(
  node: MainlineContextNodeLike | null | undefined,
): MainlineContext[] {
  const raw = node?.data?.mainline_context;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isMainlineContext);
}

export function collectNodeMainlineContexts(
  nodes: MainlineContextNodeLike[],
  edges: MainlineContextEdgeLike[],
  targetNodeId: string,
): MainlineContext[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out: MainlineContext[] = [];
  const seen = new Set<string>();
  const visitedNodeIds = new Set<string>();

  const append = (contexts: MainlineContext[]) => {
    for (const ctx of contexts) {
      const key = JSON.stringify([
        ctx.kind,
        ctx.projectId,
        ctx.episode,
        ctx.beat,
        ctx.character,
        ctx.identityId,
        ctx.sceneId,
        ctx.propId,
        ctx.role,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ctx);
    }
  };

  const visit = (nodeId: string | undefined) => {
    if (!nodeId || visitedNodeIds.has(nodeId)) return;
    visitedNodeIds.add(nodeId);
    append(extractMainlineContextsFromNode(byId.get(nodeId)));
    for (const edge of edges) {
      if (edge.target !== nodeId || !edge.source || !isPropagatingMainlineEdge(edge)) continue;
      visit(edge.source);
    }
  };

  visit(targetNodeId);

  return out;
}

export function getMainlineEdgeKind(edge: MainlineContextEdgeLike): MainlineEdgeKind | undefined {
  const data = edge.data;
  if (!data || typeof data !== "object") return undefined;
  const edgeKind = (data as { edgeKind?: unknown }).edgeKind;
  return typeof edgeKind === "string" ? (edgeKind as MainlineEdgeKind) : undefined;
}

export function isPropagatingMainlineEdge(edge: MainlineContextEdgeLike): boolean {
  const data = edge.data;
  if (data && typeof data === "object" && (data as { propagates?: unknown }).propagates === false) {
    return false;
  }
  if (data && typeof data === "object" && (data as { propagates?: unknown }).propagates === true) {
    return true;
  }
  const edgeKind = getMainlineEdgeKind(edge);
  return Boolean(edgeKind && PROPAGATING_EDGE_KINDS.has(edgeKind));
}

export function isBeatContextNode(node: MainlineContextNodeLike | null | undefined): boolean {
  return (
    node?.type === "beatContextNode" ||
    extractMainlineContextsFromNode(node).some((ctx) => ctx.kind === "beat")
  );
}

export function resolveBeatContextForNode(
  nodes: MainlineContextNodeLike[],
  edges: MainlineContextEdgeLike[],
  targetNodeId: string,
): BeatContextResolution {
  const contexts = collectNodeMainlineContexts(nodes, edges, targetNodeId);
  const beatContext =
    contexts.find(
      (ctx): ctx is MainlineContext & { episode: number; beat: number } =>
        ctx.kind === "beat" &&
        typeof ctx.episode === "number" &&
        typeof ctx.beat === "number",
    ) ?? null;

  if (!beatContext) {
    return { context: null, beatContextNodeId: null };
  }

  const beatContextNode =
    nodes.find((node) =>
      extractMainlineContextsFromNode(node).some(
        (ctx) =>
          ctx.kind === "beat" &&
          ctx.projectId === beatContext.projectId &&
          ctx.episode === beatContext.episode &&
          ctx.beat === beatContext.beat,
      ),
    ) ?? null;

  return {
    context: beatContext,
    beatContextNodeId: beatContextNode?.id ? String(beatContextNode.id) : null,
  };
}

export function collectCandidateBindingsForNode(
  edges: MainlineContextEdgeLike[],
  nodeId: string,
): CandidateBinding[] {
  const out: CandidateBinding[] = [];
  for (const edge of edges) {
    const data = edge.data;
    if (
      !data ||
      typeof data !== "object" ||
      String((data as { edgeKind?: unknown }).edgeKind || "") !== "candidate_binding"
    ) {
      continue;
    }
    const role = (data as { role?: unknown }).role;
    if (typeof role !== "string" || !CANDIDATE_BINDING_ROLES.has(role as CandidateBindingRole)) {
      continue;
    }
    if (edge.source === nodeId && edge.target) {
      out.push({
        sourceNodeId: nodeId,
        beatContextNodeId: edge.target,
        role: role as CandidateBindingRole,
      });
      continue;
    }
    if (edge.target === nodeId && edge.source) {
      out.push({
        sourceNodeId: nodeId,
        beatContextNodeId: edge.source,
        role: role as CandidateBindingRole,
      });
    }
  }
  return out;
}

function parseCandidateBindingEdge(edge: MainlineContextEdgeLike): CandidateBinding | null {
  const data = edge.data;
  if (!data || typeof data !== "object") return null;
  const edgeKind = String((data as { edgeKind?: unknown }).edgeKind || "");
  if (edgeKind !== "candidate_binding") return null;
  const role = (data as { role?: unknown }).role;
  if (typeof role !== "string" || !CANDIDATE_BINDING_ROLES.has(role as CandidateBindingRole)) {
    return null;
  }

  const explicitSourceNodeId = (data as { sourceNodeId?: unknown }).sourceNodeId;
  const explicitBeatContextNodeId = (data as { beatContextNodeId?: unknown }).beatContextNodeId;
  if (
    typeof explicitSourceNodeId === "string" &&
    typeof explicitBeatContextNodeId === "string"
  ) {
    return {
      sourceNodeId: explicitSourceNodeId,
      beatContextNodeId: explicitBeatContextNodeId,
      role: role as CandidateBindingRole,
    };
  }

  if (edge.source && edge.target) {
    return {
      sourceNodeId: edge.source,
      beatContextNodeId: edge.target,
      role: role as CandidateBindingRole,
    };
  }
  return null;
}

export function validateCandidateBindingRoleCandidate(
  edges: MainlineContextEdgeLike[],
  edgeCandidate: MainlineContextEdgeLike,
): CandidateBindingRoleValidationResult {
  const candidate = parseCandidateBindingEdge(edgeCandidate);
  if (!candidate || !CANONICAL_BEAT_BINDING_ROLES.has(candidate.role)) {
    return { ok: true, reason: "" };
  }

  for (const edge of edges) {
    const existing = parseCandidateBindingEdge(edge);
    if (
      !existing ||
      existing.beatContextNodeId !== candidate.beatContextNodeId ||
      !CANONICAL_BEAT_BINDING_ROLES.has(existing.role)
    ) {
      continue;
    }
    if (
      existing.sourceNodeId === candidate.sourceNodeId &&
      existing.role !== candidate.role
    ) {
      return {
        ok: false,
        reason: i18n.t("canvas.mainline.imageRoleTaken", {
          existing: existing.role,
          candidate: candidate.role,
        }),
      };
    }
    if (
      existing.role === candidate.role &&
      existing.sourceNodeId !== candidate.sourceNodeId
    ) {
      return {
        ok: false,
        reason: i18n.t("canvas.mainline.roleBoundElsewhere", { role: candidate.role }),
      };
    }
  }

  return { ok: true, reason: "" };
}

export function validatePropagatingEdgeCandidate(
  nodes: MainlineContextNodeLike[],
  edges: MainlineContextEdgeLike[],
  edgeCandidate: MainlineContextEdgeLike,
): PropagatingEdgeValidationResult {
  if (!isPropagatingMainlineEdge(edgeCandidate)) {
    return { ok: true, reason: "", beatContextNodeIds: [] };
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const startIds = [edgeCandidate.source, edgeCandidate.target].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const allEdges = [...edges, edgeCandidate];
  const visited = new Set<string>();
  const stack = [...startIds];

  while (stack.length) {
    const nodeId = stack.pop();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const edge of allEdges) {
      if (!isPropagatingMainlineEdge(edge)) continue;
      if (edge.source === nodeId && edge.target && !visited.has(edge.target)) {
        stack.push(edge.target);
      }
      if (edge.target === nodeId && edge.source && !visited.has(edge.source)) {
        stack.push(edge.source);
      }
    }
  }

  const beatContextNodes = [...visited]
    .map((nodeId) => byId.get(nodeId))
    .filter((node): node is MainlineContextNodeLike => Boolean(node && isBeatContextNode(node)));

  if (beatContextNodes.length <= 1) {
    return {
      ok: true,
      reason: "",
      beatContextNodeIds: beatContextNodes.map((node) => String(node.id)),
    };
  }

  const labels = beatContextNodes.map((node) => {
    const beat = extractMainlineContextsFromNode(node).find((ctx) => ctx.kind === "beat");
    return `EP${beat?.episode ?? "?"}/Beat ${beat?.beat ?? "?"}`;
  });

  return {
    ok: false,
    reason: i18n.t("canvas.mainline.chainAlreadyBound", {
      bound: labels[0],
      incoming: labels.slice(1).join(i18n.t("common.listSeparator")),
    }),
    beatContextNodeIds: beatContextNodes.map((node) => String(node.id)),
  };
}
