// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  createCanvasStore, createNodeCanvasEnvironment, createNodeCanvasCommandEnvironment,
  applyCanvasCommandsAsync, normalizeCanvasChatCommandEnvelopesForValidation,
  validateCanvasChatCommandEnvelopes, buildCanvasCommandToolResultPayload,
  type CanvasChatCommandEnvelope, type CanvasChatCommandApplyResult,
} from '../serverEntry';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasEdge } from '../domain/canvasNodes';
import type { IdGenerator } from '../application/ports';
import { defaultNodeDataDefaults } from '../domain/nodeRegistry';
import { SHARED_MODELS, VIDEO_MODELS } from '../domain/modelOptions';
import { imageModelOptionsFromPayload, videoModelOptionsFromPayload } from '../domain/modelCatalogPayload';
import { withCanvasModelCatalogsAsync } from '../domain/canvasModelCatalogs';
import { invalidateWorkflowResultsAfterNodeUpdate } from '../core/workflowInvalidation';
import { sanitizePreviewImageUrls } from '@/features/canvas/domain/canvasSerialization';
import { canvasCommandValidationFailureResult, CANVAS_COMMAND_VALIDATION_FAILURE_MESSAGE } from '@/features/freezone/canvasCommandValidationFailure';
import { createServerTranslate } from './i18n';
import { runServerRequest } from './requestScope';

export interface SavedCanvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport?: unknown;
  metadata?: unknown;
  revision?: number;
}
export interface ApplyCommandsEnvironment {
  locale?: string;
  catalogs: { image?: unknown; video?: unknown };
  ids?: IdGenerator;
  now?: () => number;
}
const HOST_COMMANDS = new Set(['html_artifact', 'run_node_action', 'open_mainline_projection', 'run_workflow']);

export function applyCommands(canvas: SavedCanvas, envelopes: CanvasChatCommandEnvelope[], env: ApplyCommandsEnvironment) {
  return runServerRequest(env.locale, () => applyCommandsSerial(canvas, envelopes, env));
}

async function applyCommandsSerial(canvas: SavedCanvas, envelopes: CanvasChatCommandEnvelope[], env: ApplyCommandsEnvironment) {
  const translate = await createServerTranslate(env.locale);
  const catalogs = {
    image: env.catalogs.image === undefined ? SHARED_MODELS : imageModelOptionsFromPayload(env.catalogs.image),
    video: env.catalogs.video === undefined ? VIDEO_MODELS : videoModelOptionsFromPayload(env.catalogs.video),
  };
  return withCanvasModelCatalogsAsync(catalogs, async () => {
    const store = createCanvasStore(createNodeCanvasEnvironment({ translate, ids: env.ids, now: env.now, videoModels: catalogs.video }));
    const input = structuredClone(canvas);
    // Clean historical inline media; leave command output for Python validation.
    input.nodes = sanitizePreviewImageUrls(input.nodes) as CanvasNode[];
    store.getState().setCanvasData(input.nodes, input.edges);
    // Shared hydration only knows registered types. Keep saved extension nodes
    // and their edges available to structural commands in the worker.
    const unknownNodes = input.nodes.filter(node => !Object.values(CANVAS_NODE_TYPES).includes(node.type));
    if (unknownNodes.length > 0) {
      const unknownIds = new Set(unknownNodes.map(node => node.id));
      store.setState(state => ({
        nodes: [...state.nodes, ...unknownNodes],
        edges: [...state.edges, ...input.edges.filter(edge => unknownIds.has(edge.source) || unknownIds.has(edge.target))],
      }));
    }
    const initialState = store.getState();
    const before = { nodes: initialState.nodes, edges: initialState.edges };
    const normalized = normalizeCanvasChatCommandEnvelopesForValidation(envelopes, store.getState().nodes.map(node => node.id));
    const host_command_types = [...new Set(normalized.flatMap(envelope => envelope.commands.map(command => command.type).filter(type => HOST_COMMANDS.has(type))))];
    const validation = validateCanvasChatCommandEnvelopes(normalized, store.getState().nodes, store.getState().edges, defaultNodeDataDefaults);
    let status: 'applied' | 'validation_failed' | 'host_required';
    let result: CanvasChatCommandApplyResult;
    if (host_command_types.length > 0) {
      status = 'host_required';
      result = { applied: 0, openedUiActions: 0, createdNodeIds: [], errors: [], commandResults: normalized.flatMap(envelope => envelope.commands).flatMap((command, commandIndex) => HOST_COMMANDS.has(command.type)
        ? [{ commandIndex, type: command.type, status: 'pending' as const, label: command.type, output: { reason: 'host_required' } }]
        : []) };
    } else if (!validation.ok) {
      status = 'validation_failed';
      result = canvasCommandValidationFailureResult([CANVAS_COMMAND_VALIDATION_FAILURE_MESSAGE, ...validation.issues.map(issue => `${issue.path}: ${issue.message}`)]);
    } else {
      status = 'applied';
      const commandEnv = createNodeCanvasCommandEnvironment({
        translate,
        validate: (commands, nodes, edges) => validateCanvasChatCommandEnvelopes(commands, nodes, edges, defaultNodeDataDefaults),
        onNodeDataUpdated: (nodeId, data) => invalidateWorkflowResultsAfterNodeUpdate(store, nodeId, data, env.now),
      });
      result = await applyCanvasCommandsAsync(store, commandEnv, normalized);
    }
    const state = store.getState();
    const after = status === 'applied' ? { nodes: state.nodes, edges: state.edges } : before;
    const oldNodes = new Map(before.nodes.map(node => [node.id, node]));
    const newNodes = new Map(after.nodes.map(node => [node.id, node]));
    const oldEdges = new Set(before.edges.map(edge => edge.id));
    const newEdges = new Set(after.edges.map(edge => edge.id));
    const changes = {
      created_node_ids: after.nodes.filter(node => !oldNodes.has(node.id)).map(node => node.id),
      updated_node_ids: after.nodes.filter(node => oldNodes.has(node.id) && JSON.stringify(oldNodes.get(node.id)) !== JSON.stringify(node)).map(node => node.id),
      deleted_node_ids: before.nodes.filter(node => !newNodes.has(node.id)).map(node => node.id),
      created_edge_ids: after.edges.filter(edge => !oldEdges.has(edge.id)).map(edge => edge.id),
      deleted_edge_ids: before.edges.filter(edge => !newEdges.has(edge.id)).map(edge => edge.id),
    };
    const { turn_id, anchor_text_prefix, bridge_key, ...receipt } = buildCanvasCommandToolResultPayload({ translate, result });
    return { status, canvas: after, changes, receipt: { ...receipt, received_at: (env.now ?? Date.now)() }, ...(host_command_types.length ? { host_command_types } : {}) };
  });
}
