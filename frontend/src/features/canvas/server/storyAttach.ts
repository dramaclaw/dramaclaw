// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createCanvasStore, createNodeCanvasEnvironment } from '../serverEntry';
import { CANVAS_NODE_TYPES } from '../domain/canvasNodes';
import { VIDEO_MODELS } from '../domain/modelOptions';
import { videoModelOptionsFromPayload } from '../domain/modelCatalogPayload';
import { videoReferenceEnvelopeInCatalog } from '../domain/videoReferenceLimits';
import { isRecord } from '@/features/freezone/canvasCommandEnvelope';
import { syncCompletedStoryFramesIn } from '../core/storyAttachment';
import { invalidRequest, parseCanvasPayload } from './requestPayload';
import { createServerTranslate } from './i18n';
import { runServerRequest } from './requestScope';

export async function serveStoryAttach(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.image_node_ids) ||
      !payload.image_node_ids.every(id => typeof id === 'string')) invalidRequest('image_node_ids must be a string array');
  const imageNodeIds: string[] = payload.image_node_ids;
  const input = parseCanvasPayload({ ...payload, envelopes: [] });
  const env = input.env ?? {};
  if (!isRecord(env) || (env.locale !== undefined && typeof env.locale !== 'string') ||
      (env.catalogs !== undefined && !isRecord(env.catalogs))) invalidRequest('Invalid story attachment environment');
  const locale = typeof env.locale === 'string' ? env.locale : undefined;
  // Reference limits follow the requester's video catalog, as the browser's live catalog does.
  const videoModels = isRecord(env.catalogs) && env.catalogs.video !== undefined
    ? videoModelOptionsFromPayload(env.catalogs.video) : VIDEO_MODELS;
  return runServerRequest(locale, async () => {
    const translate = await createServerTranslate(locale);
    const store = createCanvasStore(createNodeCanvasEnvironment({ translate, videoModels }));
    const canvas = structuredClone(input.canvas);
    store.getState().setCanvasData(canvas.nodes, canvas.edges);
    // Match command hydration, preserving extension nodes and their edges.
    const unknownNodes = canvas.nodes.filter(node => !Object.values(CANVAS_NODE_TYPES).includes(node.type));
    if (unknownNodes.length) {
      const unknownIds = new Set(unknownNodes.map(node => node.id));
      store.setState(state => ({
        nodes: [...state.nodes, ...unknownNodes],
        edges: [...state.edges, ...canvas.edges.filter(edge => unknownIds.has(edge.source) || unknownIds.has(edge.target))],
      }));
    }
    const before = store.getState();
    const warnings = syncCompletedStoryFramesIn(store, imageNodeIds, translate,
      target => videoReferenceEnvelopeInCatalog(target, videoModels));
    const after = store.getState();
    const oldNodes = new Map(before.nodes.map(node => [node.id, node]));
    const oldEdges = new Set(before.edges.map(edge => edge.id));
    const newNodeIds = new Set(after.nodes.map(node => node.id));
    const newEdgeIds = new Set(after.edges.map(edge => edge.id));
    if (after.nodes.length !== before.nodes.length || before.nodes.some(node => !newNodeIds.has(node.id)) ||
        before.edges.some(edge => !newEdgeIds.has(edge.id))) {
      throw new Error('Story attachment removed an edge or changed the node set');
    }
    const node_patches = after.nodes.flatMap(node => {
      const previous = oldNodes.get(node.id);
      if (!previous) throw new Error('Story attachment created a node');
      const patch = Object.fromEntries(Object.entries(node.data).filter(([key, value]) =>
        JSON.stringify(previous.data[key]) !== JSON.stringify(value)));
      return Object.keys(patch).length ? [{ node_id: node.id, patch }] : [];
    });
    return { ok: true, edges: after.edges.filter(edge => !oldEdges.has(edge.id)), node_patches, warnings };
  });
}
