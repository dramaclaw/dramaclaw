// SPDX-License-Identifier: Elastic-2.0
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';

export const MEDIA_KINDS = ['text', 'image', 'video', 'audio'] as const;
export type MediaKind = typeof MEDIA_KINDS[number];
export const ELEMENT_TAGS = ['character', 'scene', 'prop', 'other'] as const;
export type ElementTag = typeof ELEMENT_TAGS[number];
export interface BoardMetadata {
  version: 1;
  order: Partial<Record<MediaKind, string[]>>;
  elementTags: Record<string, ElementTag>;
}
export interface BoardCard {
  id: string; kind: MediaKind; node: CanvasNode; name: string; text: string;
  url: string; poster: string; model: string; width: number; height: number;
  duration: number; busy: boolean; progress: number; error: string;
  createdAt: number; tag?: ElementTag; references: string[];
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (...vs: unknown[]) => vs.find(v => typeof v === 'string' && v.length > 0) as string | undefined;
const num = (...vs: unknown[]) => vs.find(v => typeof v === 'number' && Number.isFinite(v)) as number | undefined;

export function normalizeBoardMetadata(value: unknown): BoardMetadata {
  const raw = record(value), order = record(raw.order), tags = record(raw.elementTags);
  return { version: 1, order: Object.fromEntries(MEDIA_KINDS.map(k => [k,
    Array.isArray(order[k]) ? [...new Set((order[k] as unknown[]).filter((v): v is string => typeof v === 'string'))] : [],
  ])), elementTags: Object.fromEntries(Object.entries(tags).filter(([, tag]) => ELEMENT_TAGS.includes(tag as ElementTag))) as Record<string, ElementTag> };
}

/** Read current result fields, never historical output snapshots or node positions. */
export function buildStoryboardProjection(nodes: CanvasNode[], edges: CanvasEdge[], metadata: BoardMetadata): BoardCard[] {
  const incoming = new Map<string, string[]>();
  for (const e of edges) { const refs = incoming.get(e.target) ?? []; if (!refs.includes(e.source)) refs.push(e.source); incoming.set(e.target, refs); }
  const cards: BoardCard[] = [];
  for (const node of nodes) {
    const d = record(node.data), imported = record(d.liblibImport);
    let kind: MediaKind;
    if (node.type === 'groupNode') continue;
    if (d.videoUrl || ['videoNode', 'videoComposeNode', 'videoStoryNode'].includes(node.type ?? '') || d.mediaType === 'video' || d.mediaKind === 'video') kind = 'video';
    else if (d.audioUrl || node.type === 'audioNode' || d.mediaType === 'audio' || d.mediaKind === 'audio') kind = 'audio';
    else if (['textAnnotationNode', 'scriptNode'].includes(node.type ?? '')) kind = 'text';
    else if (d.imageUrl || d.previewImageUrl || ['uploadNode', 'imageGenNode', 'imageNode', 'exportImageNode', 'liblibMediaNode'].includes(node.type ?? '')) kind = 'image';
    else continue;
    const width = num(d.widthPx, d.imageNaturalWidth, d.imageWidth, imported.width) ?? 0;
    const height = num(d.heightPx, d.imageNaturalHeight, d.imageHeight, imported.height) ?? 0;
    const progress = num(d.generationProgress, d.progress) ?? 0;
    cards.push({ id: node.id, node, kind, name: str(d.displayName, d.sourceFileName) ?? node.id,
      text: str(d.content, d.script, d.text) ?? '',
      url: str(kind === 'video' ? d.videoUrl : kind === 'audio' ? d.audioUrl : d.imageUrl, kind === 'image' ? d.previewImageUrl : null, node.type === 'liblibMediaNode' ? d.localUrl : null) ?? '',
      poster: str(d.posterUrl, d.previewImageUrl, d.thumbnailUrl, kind === 'video' ? d.imageUrl : null) ?? '',
      model: str(d.textModel, d.model) ?? '', width, height,
      duration: (num(d.durationMs) ?? ((num(d.durationSec, d.duration) ?? 0) * 1000)) / 1000,
      busy: Boolean(d.isGenerating || d.isUploading), progress: Math.min(100, Math.max(0, progress)),
      error: str(d.generationError, d.errorMessage, d.uploadError) ?? '',
      createdAt: num(d.createdAt) ?? 0, references: incoming.get(node.id) ?? [],
      tag: metadata.elementTags[node.id],
    });
  }
  const ids = new Set(cards.map(c => c.id));
  for (const card of cards) {
    const order = record(card.node.data).referenceOrder;
    const ranks = new Map((Array.isArray(order) ? order : []).map((id, i) => [id, i]));
    card.references = card.references.filter(id => ids.has(id)).sort((a, b) => (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity));
  }
  return cards;
}

export function orderedCards(cards: BoardCard[], kind: MediaKind, metadata: BoardMetadata): BoardCard[] {
  const ranks = new Map((metadata.order[kind] ?? []).map((id, i) => [id, i]));
  return cards.filter(c => c.kind === kind).sort((a, b) => {
    const ai = ranks.get(a.id), bi = ranks.get(b.id);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return 1;
    if (bi !== undefined) return -1;
    return b.createdAt - a.createdAt;
  });
}

export function reorderCards(ids: string[], source: string, target: string): string[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return ids;
  const next = ids.filter(id => id !== source); next.splice(next.indexOf(target), 0, source); return next;
}
