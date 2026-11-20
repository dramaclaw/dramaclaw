// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as pure from '@/features/canvas/application/generationRequests';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { imageModelOptionsFromPayload } from '@/features/canvas/domain/modelCatalogPayload';
import { SHARED_MODELS } from '@/features/canvas/domain/modelOptions';
import { createServerTranslate } from '@/features/canvas/server/i18n';

export const rawCatalog = { models: [{
  id: 'image-picker', catalog_id: 'image-catalog', provider: 'openai', model: 'test-image',
  display_name: 'Test image', resolution_options: ['2K'], ratio_options: ['16:9'],
  quality_options: ['medium', 'high'], reference_image_max: 2,
}] };
export function requestPayload(withReference = false) {
  const nodes: CanvasNode[] = [{
    id: 'image', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 },
    data: { prompt: 'A cat', model: 'image-picker', size: '2K', aspectRatio: '16:9', count: 1 },
  }];
  if (withReference) nodes.push({
    id: 'source', type: CANVAS_NODE_TYPES.upload, position: { x: 1, y: 2 },
    data: { imageUrl: '/static/reference.png?version=1' },
  });
  return {
    canvas: { nodes, edges: withReference ? [{ id: 'ref', source: 'source', target: 'image' }] : [] },
    node_id: 'image', env: {
      locale: 'en', project: 'test/project', canvasId: 'canvas-1', catalogs: { image: rawCatalog },
      executionSource: 'workflow' as const,
    },
  };
}
type RequestPayload = ReturnType<typeof requestPayload>;
export function requestContext(input: Omit<RequestPayload, 'env'> & {
  env: Omit<RequestPayload['env'], 'catalogs' | 'executionSource'> & {
    catalogs?: { image?: unknown }; executionSource: 'manual' | 'workflow';
    productOperation?: pure.ImageGenerationRequestContext['productOperation']; prompt?: string;
  };
}): pure.ImageGenerationRequestContext {
  return {
    ...input.canvas, nodeId: input.node_id, projectId: input.env.project, canvasId: input.env.canvasId,
    imageModels: input.env.catalogs?.image === undefined ? SHARED_MODELS : imageModelOptionsFromPayload(input.env.catalogs.image),
    executionSource: input.env.executionSource, productOperation: input.env.productOperation ?? null,
  };
}
export const task = { task_key: 'task-1', task_type: 'freezone_gen', job_id: 'job-1' };
export const metadata = { mode: 'model', prompt: 'Compiled cat', recipeIds: ['recipe-1'] } as const;
export const compileMetadata = { ...metadata, recipeIds: [...metadata.recipeIds] };
export function outcomePayload(outcome: pure.ImageGenerationOutcome, locale = 'en') {
  return {
    phase: 'outcome' as const, locale, node_id: 'image', node_data: { generationTaskKey: task.task_key },
    task_key: task.task_key, first_accepted_task: task, run_index: 0, total: 1,
    completed_urls: [] as string[], attach_story_frame: true, outcome,
  };
}
export async function outcomeInput(input: ReturnType<typeof outcomePayload>): Promise<pure.ImageGenerationOutcomeInput> {
  return {
    nodeId: input.node_id, nodeData: input.node_data, taskKey: input.task_key,
    firstAcceptedTask: input.first_accepted_task, runIndex: input.run_index, total: input.total,
    completedUrls: input.completed_urls, attachStoryFrame: input.attach_story_frame,
    outcome: input.outcome, translate: await createServerTranslate(input.locale),
  };
}
export const outcomes: pure.ImageGenerationOutcome[] = [
  { kind: 'completed', result: { output_url: '/static/cat.png' } },
  { kind: 'completed', result: null, fallbackUrl: '/static/fallback.png' },
  { kind: 'completed', result: null, fallbackUrl: null },
  { kind: 'failed', message: 'content_policy_violation' },
  { kind: 'cancelled', message: 'Stopped' },
  { kind: 'reference_invalid', message: 'Invalid reference' },
  { kind: 'compile_failed', message: 'Compile failed request_id=compile-1' },
];
export function wire(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
