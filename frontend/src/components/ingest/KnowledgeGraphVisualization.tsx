// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { Maximize2, Minus, Network, Plus, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type {
  KnowledgeGraphNode,
  KnowledgeGraphSnapshot,
} from "@/lib/queries/ingest";
import { cn } from "@/lib/utils";

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 520;

const TYPE_COLORS: Record<string, string> = {
  Entity: "#a78bfa",
  EntityType: "#22d3ee",
  TextSummary: "#f472b6",
  Document: "#34d399",
  DocumentChunk: "#f59e0b",
};

interface LayoutNode extends KnowledgeGraphNode {
  x: number;
  y: number;
  radius: number;
  color: string;
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function buildKnowledgeGraphLayout(graph: KnowledgeGraphSnapshot): LayoutNode[] {
  const nodes = graph.nodes.map((node, index) => {
    const seed = hashText(node.id);
    const angle = ((seed % 360) * Math.PI) / 180 + index * 2.399;
    const radius = 45 + Math.sqrt(index + 1) * 27;
    return {
      ...node,
      x: VIEW_WIDTH / 2 + Math.cos(angle) * radius,
      y: VIEW_HEIGHT / 2 + Math.sin(angle) * radius * 0.58,
      radius: Math.min(18, 7 + Math.sqrt(Math.max(1, node.degree)) * 1.8),
      color: TYPE_COLORS[node.type] ?? "#60a5fa",
      vx: 0,
      vy: 0,
    };
  });
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const springs = graph.edges
    .map((edge) => [indexById.get(edge.source), indexById.get(edge.target)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] != null && pair[1] != null);

  // A small deterministic force pass gives the real topology an organic layout
  // without adding another runtime dependency or persisting presentation state.
  for (let step = 0; step < 120; step += 1) {
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left];
        const b = nodes[right];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const distanceSquared = Math.max(64, dx * dx + dy * dy);
        const distance = Math.sqrt(distanceSquared);
        dx /= distance;
        dy /= distance;
        const force = 1350 / distanceSquared;
        a.vx -= dx * force;
        a.vy -= dy * force;
        b.vx += dx * force;
        b.vy += dy * force;
      }
    }
    for (const [sourceIndex, targetIndex] of springs) {
      if (sourceIndex === targetIndex) continue;
      const source = nodes[sourceIndex];
      const target = nodes[targetIndex];
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = (distance - 82) * 0.0024;
      source.vx += (dx / distance) * force;
      source.vy += (dy / distance) * force;
      target.vx -= (dx / distance) * force;
      target.vy -= (dy / distance) * force;
    }
    for (const node of nodes) {
      node.vx += (VIEW_WIDTH / 2 - node.x) * 0.00045;
      node.vy += (VIEW_HEIGHT / 2 - node.y) * 0.0008;
      node.vx *= 0.84;
      node.vy *= 0.84;
      node.x = Math.min(VIEW_WIDTH - 35, Math.max(35, node.x + node.vx));
      node.y = Math.min(VIEW_HEIGHT - 28, Math.max(28, node.y + node.vy));
    }
  }

  return nodes.map(({ vx: _vx, vy: _vy, ...node }) => node);
}

function formatProperty(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function KnowledgeGraphVisualization({
  graph,
  className,
}: {
  graph: KnowledgeGraphSnapshot;
  className?: string;
}) {
  const { t } = useTranslation();
  const filterId = useId().replace(/:/g, "");
  const nodes = useMemo(() => buildKnowledgeGraphLayout(graph), [graph]);
  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);
  const selected = selectedId ? nodesById.get(selectedId) ?? null : null;
  const selectedRelations = useMemo(() => {
    if (!selectedId) return [];
    return graph.edges
      .filter((edge) => edge.source === selectedId || edge.target === selectedId)
      .slice(0, 12)
      .map((edge) => {
        const neighborId = edge.source === selectedId ? edge.target : edge.source;
        return {
          id: edge.id,
          relation: edge.relation,
          neighbor: nodesById.get(neighborId)?.label ?? neighborId,
        };
      });
  }, [graph.edges, nodesById, selectedId]);
  const selectedNeighborIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const result = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.source === selectedId) result.add(edge.target);
      if (edge.target === selectedId) result.add(edge.source);
    }
    return result;
  }, [graph.edges, selectedId]);
  const visibleLabels = useMemo(
    () => new Set([...nodes].sort((a, b) => b.degree - a.degree).slice(0, 24).map((node) => node.id)),
    [nodes],
  );

  const zoom = (factor: number) =>
    setView((current) => ({
      ...current,
      scale: Math.min(2.6, Math.max(0.55, current.scale * factor)),
    }));

  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: view.x,
      y: view.y,
    };
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setView((current) => ({
      ...current,
      x: drag.x + ((event.clientX - drag.clientX) / bounds.width) * VIEW_WIDTH,
      y: drag.y + ((event.clientY - drag.clientY) / bounds.height) * VIEW_HEIGHT,
    }));
  };

  const handlePointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const handleWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    zoom(event.deltaY < 0 ? 1.12 : 0.89);
  };

  return (
    <section
      aria-label={t("ingest.knowledgeGraph.title")}
      className={cn(
        "relative overflow-hidden rounded-2xl border border-violet-300/10 bg-[#05050a] shadow-[0_24px_80px_rgba(76,29,149,0.16)]",
        expanded ? "h-[680px]" : "h-[520px]",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_46%,rgba(109,40,217,0.18),transparent_42%),radial-gradient(circle_at_18%_22%,rgba(34,211,238,0.08),transparent_28%)]" />
      <div className="absolute left-5 top-4 z-20 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-xl border border-violet-300/15 bg-violet-500/12 text-violet-300 shadow-[0_0_28px_rgba(139,92,246,0.28)]">
          <Network className="size-[18px]" />
        </span>
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-white">
            {t("ingest.knowledgeGraph.title")}
          </h2>
          <p className="mt-0.5 text-[11px] text-white/45">
            {t("ingest.knowledgeGraph.stats", {
              nodes: graph.total_nodes,
              edges: graph.total_edges,
            })}
          </p>
        </div>
      </div>

      <div className="absolute right-4 top-4 z-20 flex items-center gap-1 rounded-lg border border-white/10 bg-black/55 p-1 backdrop-blur-xl">
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => zoom(0.82)} aria-label={t("ingest.knowledgeGraph.zoomOut")}>
          <Minus className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => setView({ x: 0, y: 0, scale: 1 })} aria-label={t("ingest.knowledgeGraph.resetView")}>
          <RotateCcw className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => zoom(1.22)} aria-label={t("ingest.knowledgeGraph.zoomIn")}>
          <Plus className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => setExpanded((value) => !value)} aria-label={t("ingest.knowledgeGraph.expand")}>
          <Maximize2 className="size-3.5" />
        </Button>
      </div>

      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="absolute inset-0 size-full cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onClick={() => setSelectedId(null)}
      >
        <defs>
          <pattern id={`${filterId}-grid`} width="36" height="36" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.8" fill="rgba(255,255,255,0.12)" />
          </pattern>
          <filter id={`${filterId}-glow`} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={`url(#${filterId}-grid)`} opacity="0.42" />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {graph.edges.map((edge, index) => {
            const source = nodesById.get(edge.source);
            const target = nodesById.get(edge.target);
            if (!source || !target) return null;
            const connected = selectedId === edge.source || selectedId === edge.target;
            return (
              <line
                key={edge.id}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke={connected ? "#c4b5fd" : "#7c3aed"}
                strokeWidth={connected ? 1.8 : 0.72}
                strokeOpacity={selectedId ? (connected ? 0.82 : 0.08) : 0.26}
                strokeDasharray={index < 90 ? "5 8" : undefined}
              >
                {index < 90 ? (
                  <animate attributeName="stroke-dashoffset" from="26" to="0" dur={`${3.2 + (index % 7) * 0.35}s`} repeatCount="indefinite" />
                ) : null}
              </line>
            );
          })}
          {nodes.map((node) => {
            const active = selectedId === node.id;
            const muted = selectedId != null && !active && !selectedNeighborIds.has(node.id);
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`${node.label}, ${node.type}`}
                transform={`translate(${node.x} ${node.y})`}
                className="cursor-pointer outline-none"
                opacity={muted ? 0.24 : 1}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedId(node.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setSelectedId(node.id);
                }}
              >
                <title>{node.label}</title>
                <circle r={node.radius * 2.1} fill={node.color} opacity={active ? 0.22 : 0.08} filter={`url(#${filterId}-glow)`} />
                <circle r={node.radius} fill="#09090f" stroke={node.color} strokeWidth={active ? 3 : 1.4} />
                <circle r={Math.max(2.8, node.radius * 0.28)} fill={node.color} filter={`url(#${filterId}-glow)`} />
                {(visibleLabels.has(node.id) || active) && (
                  <text y={node.radius + 14} textAnchor="middle" fill="rgba(255,255,255,0.78)" fontSize={active ? 11 : 9.5} fontWeight={active ? 600 : 450}>
                    {node.label.length > 15 ? `${node.label.slice(0, 14)}…` : node.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {selected && (
        <aside className="absolute bottom-4 right-4 top-16 z-30 w-[300px] overflow-y-auto rounded-xl border border-white/10 bg-[#0d0b16]/94 p-4 shadow-2xl backdrop-blur-xl">
          <button type="button" onClick={() => setSelectedId(null)} className="absolute right-3 top-3 text-white/45 transition-colors hover:text-white" aria-label={t("common.close")}>
            <X className="size-4" />
          </button>
          <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: selected.color, backgroundColor: `${selected.color}18` }}>
            {selected.type}
          </span>
          <h3 className="mt-3 pr-6 text-base font-semibold leading-6 text-white">{selected.label}</h3>
          <p className="mt-1 text-[11px] text-white/40">
            {t("ingest.knowledgeGraph.connections", { count: selected.degree })}
          </p>
          {selectedRelations.length > 0 && (
            <div className="mt-4 border-t border-white/8 pt-4">
              <p className="text-[10px] uppercase tracking-wider text-white/35">
                {t("ingest.knowledgeGraph.relationships")}
              </p>
              <div className="mt-2 space-y-1.5">
                {selectedRelations.map((relation) => (
                  <div key={relation.id} className="flex items-center gap-2 text-[11px]">
                    <span className="max-w-[118px] truncate rounded bg-violet-400/10 px-1.5 py-0.5 text-violet-200/75">
                      {relation.relation}
                    </span>
                    <span className="truncate text-white/60">{relation.neighbor}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="mt-4 space-y-3 border-t border-white/8 pt-4">
            {Object.entries(selected.properties).slice(0, 10).map(([key, value]) => (
              <div key={key}>
                <p className="text-[10px] uppercase tracking-wider text-white/35">{key}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-white/72">{formatProperty(value)}</p>
              </div>
            ))}
          </div>
        </aside>
      )}

      <div className="pointer-events-none absolute bottom-4 left-5 z-20 flex items-center gap-4 text-[10px] text-white/35">
        <span>{t("ingest.knowledgeGraph.interactionHint")}</span>
        {graph.truncated && <span>{t("ingest.knowledgeGraph.truncated")}</span>}
      </div>
    </section>
  );
}
