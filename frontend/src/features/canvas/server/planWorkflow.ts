// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  createCanvasStore, createNodeCanvasEnvironment, extractCanvasChatCommandEnvelopes,
  validateCanvasChatCommandEnvelopes,
} from '../serverEntry';
import { defaultNodeDataDefaults } from '../domain/nodeRegistry';
import { SHARED_MODELS, VIDEO_MODELS } from '../domain/modelOptions';
import { imageModelOptionsFromPayload, videoModelOptionsFromPayload } from '../domain/modelCatalogPayload';
import { withCanvasModelCatalogsAsync } from '../domain/canvasModelCatalogs';
import { planCanvasNodeActions } from '@/features/freezone/workflowActionPlan';
import { agentRunnableNodeActions, isRecord } from '@/features/freezone/canvasCommandEnvelope';
import type { CanvasChatCommand } from '../core/commands/types';
import { isSystemManagedNodeData } from '../domain/mainlineNodeFlags';
import { invalidRequest, parseCanvasPayload } from './requestPayload';
import { createServerTranslate } from './i18n';
import { runServerRequest } from './requestScope';

export async function servePlanWorkflow(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.commands)) invalidRequest('commands must be an array');
  const input = parseCanvasPayload({ ...payload, envelopes: [] });
  const actions = agentRunnableNodeActions();
  const acceptedActions = actions.join(', ');
  const issues: string[] = [];
  payload.commands.forEach((command, index) => {
    const path = `envelopes[0].commands[${index}]`;
    if (!isRecord(command)) {
      issues.push(`${path}: expected a command object`);
    } else if (command.type !== 'run_workflow' && command.type !== 'run_node_action') {
      issues.push(`${path}.type: ${JSON.stringify(command.type ?? null)} is not accepted; only run_workflow and run_node_action commands are accepted`);
    } else if (command.type === 'run_node_action') {
      if (typeof command.node_id !== 'string' || !command.node_id.trim()) {
        issues.push(`${path}.node_id: expected a non-empty node id string`);
      }
      if (typeof command.action !== 'string' || !command.action.trim()) {
        issues.push(`${path}.action: expected a non-empty action string; use one of: ${acceptedActions}`);
      } else if (!actions.includes(command.action.trim())) {
        issues.push(`${path}.action: ${JSON.stringify(command.action)} is not a runnable node action; use one of: ${acceptedActions}`);
      }
    }
  });
  if (issues.length) invalidRequest('Invalid workflow commands: ' + issues.join('; '));
  const envelopes = extractCanvasChatCommandEnvelopes([{
    schema_version: 'canvas_chat_commands.v1', commands: payload.commands,
  }]);
  if (envelopes.length !== 1 || envelopes[0].commands.length !== payload.commands.length) {
    const dropped = payload.commands.flatMap((command, index) => {
      const parsed = extractCanvasChatCommandEnvelopes([{
        schema_version: 'canvas_chat_commands.v1', commands: [command],
      }]);
      return parsed[0]?.commands.length ? [] : [
        `envelopes[0].commands[${index}]: invalid ${isRecord(command) ? command.type : null} command`,
      ];
    });
    invalidRequest('Invalid workflow commands: ' + dropped.join('; '));
  }
  const commands: Extract<CanvasChatCommand, { type: 'run_workflow' | 'run_node_action' }>[] = [];
  for (const command of envelopes[0].commands) {
    if (command.type !== 'run_workflow' && command.type !== 'run_node_action') {
      invalidRequest('Only run_workflow and run_node_action commands are accepted');
    }
    commands.push(command);
  }
  const env = input.env ?? {};
  if (!isRecord(env) || (env.locale !== undefined && typeof env.locale !== 'string') ||
      (env.catalogs !== undefined && !isRecord(env.catalogs)) ||
      (env.selectedNodeIds !== undefined && (!Array.isArray(env.selectedNodeIds) ||
        !env.selectedNodeIds.every(id => typeof id === 'string')))) invalidRequest('Invalid workflow environment');
  const locale = typeof env.locale === 'string' ? env.locale : undefined;
  const selectedNodeIds: string[] = Array.isArray(env.selectedNodeIds) ? env.selectedNodeIds : [];
  const catalogInput = isRecord(env.catalogs) ? env.catalogs : {};
  return runServerRequest(locale, async () => {
    const translate = await createServerTranslate(locale);
    const catalogs = {
      image: catalogInput.image === undefined ? SHARED_MODELS : imageModelOptionsFromPayload(catalogInput.image),
      video: catalogInput.video === undefined ? VIDEO_MODELS : videoModelOptionsFromPayload(catalogInput.video),
    };
    return withCanvasModelCatalogsAsync(catalogs, async () => {
      const store = createCanvasStore(createNodeCanvasEnvironment({ translate, videoModels: catalogs.video }));
      const canvas = structuredClone(input.canvas);
      store.getState().setCanvasData(canvas.nodes, canvas.edges);
      const state = store.getState();
      const validation = validateCanvasChatCommandEnvelopes(envelopes, state.nodes, state.edges, defaultNodeDataDefaults);
      if (!validation.ok) invalidRequest(validation.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));
      const plan = planCanvasNodeActions(store, commands, { selectedNodeIds, nodeDataDefaults: defaultNodeDataDefaults, translate });
      if (!plan.ok) return plan;
      return {
        ok: true,
        actions: plan.actions.map(action => ({
          command_index: action.commandIndex, node_id: action.nodeId, action: action.action,
          execution_mode: action.executionMode, label: action.label,
          ...(action.action === 'generate_image' && state.nodes.some(node => node.id === action.nodeId &&
            node.data.autoCommitOnGenerate === true && isSystemManagedNodeData(node.data)) ? { auto_commit: true } : {}),
          ...(action.parameters !== undefined ? { parameters: action.parameters } : {}),
          ...(action.invalidationReason !== undefined ? { invalidation_reason: action.invalidationReason } : {}),
        })),
        levels: plan.levels, dependencies: plan.dependencies, already_completed: plan.alreadyCompleted,
      };
    });
  });
}
