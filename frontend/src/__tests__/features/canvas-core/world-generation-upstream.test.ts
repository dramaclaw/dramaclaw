// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createInstance } from 'i18next';
import { expect, it } from 'vitest';
import en from '../../../../public/locales/en/translation.json';
import {
  worldUpstreamReference, selectWorldGenerationUpstream, buildWorldGenerationRequest, worldGenerationStartPatch, worldGenerationAcceptedPatch,
  worldGenerationSuccessPatch, worldGenerationActionResult,
} from '@/features/canvas/application/generationRequests';
import { CANVAS_NODE_TYPES, isThreeDWorldNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import captured from './worldGenerationExpected.json';
import { worldUpstreamFixtures, worldId } from './worldUpstreamFixtures';

const expected: Record<string, { request: { body: unknown } | null }> = captured;
const now = 1700000000000;
const ref = { task_key: 'world-task', task_type: 'freezone_image_to_3gs', job_id: 'world-job' };
const result = { ply_url: 'https://media.example.test/world.ply' };

it.each(worldUpstreamFixtures)('$name', async fixture => {
  const translator = createInstance();
  await translator.init({ lng: 'en', fallbackLng: false, resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const translate = (key: string, options?: Record<string, unknown>) => translator.t(key, options);
  const canvas = structuredClone(fixture.canvas);
  const snapshot = structuredClone(canvas);
  const world = canvas.nodes.find(node => node.id === worldId);
  if (!isThreeDWorldNode(world)) throw new Error('Missing world');
  const initial = world.data;
  const selection = selectWorldGenerationUpstream({ ...canvas, nodeId: worldId });
  expect(selection).toStrictEqual({ upstream: fixture.expected,
    sourceNode: fixture.expected?.kind === 'image' ? canvas.nodes.find(n => n.id === fixture.expected?.nodeId) : null });
  const decision = buildWorldGenerationRequest({ nodeId: worldId, projectId: 'world/project', canvasId: 'default',
    data: initial, blocked: false, isGenerating: false, ...selection, productOperation: null, translate });
  const patches: Record<string, unknown>[] = [];
  let output = {};
  if (!decision.ok) patches.push(...decision.patches);
  else {
    patches.push(worldGenerationStartPatch({ request: decision, data: initial, startedAtMs: now }), worldGenerationAcceptedPatch(ref));
    const success = worldGenerationSuccessPatch({ result, generatedId: `generated-sog:${decision.sourceKind}:${now}`,
      sourceKind: decision.sourceKind, rawPanoSource: decision.rawPanoSource, currentSources: initial.sources ?? [],
      labels: { pano3dgs: translate('node.threeDWorld.pano3dgsLabel'), image3dgs: translate('node.threeDWorld.image3dgsLabel'), worldUrlMissing: translate('node.threeDWorld.worldUrlMissing') } });
    if (success.kind !== 'completed') throw new Error('Expected successful world result');
    patches.push(success.patch); output = success.output;
  }

  const finalData = Object.assign({}, initial, ...patches);
  const trace = { request: decision.ok ? decision.request : null, writes: patches, finalData,
    event: { requestId: fixture.name, nodeId: worldId, action: 'generate_3gs_world',
      ...worldGenerationActionResult({ output, latestNode: { ...world, data: finalData } }) } };
  const literal = expected[`WU:${fixture.name}`];
  expect(JSON.parse(JSON.stringify(trace))).toStrictEqual(expected[`WU:${fixture.name}`]);
  expect(JSON.stringify(trace.request?.body)).toBe(JSON.stringify(literal.request?.body));
  expect(canvas).toStrictEqual(snapshot);
});

it.each([
  { type: CANVAS_NODE_TYPES.imageGen, data: { imageUrl: 7 }, expected: { nodeId: 'source', kind: 'image', imageUrl: 7 } },
  { type: CANVAS_NODE_TYPES.upload, data: { imageUrl: 7 }, expected: { nodeId: 'source', kind: 'image', imageUrl: 7 } },
  { type: CANVAS_NODE_TYPES.imageGen, data: { imageUrl: '', referenceImageUrl: '' }, expected: null },
  { type: CANVAS_NODE_TYPES.imageGen, data: { imageUrl: 'image', referenceImageUrl: 'ref' }, expected: { nodeId: 'source', kind: 'image', imageUrl: 'image' } },
  { type: CANVAS_NODE_TYPES.imageGen, data: { referenceImageUrl: 'ref' }, expected: { nodeId: 'source', kind: 'image', imageUrl: 'ref' } },
  ...[CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.exportImage, CANVAS_NODE_TYPES.storyboardGen].map(type => ({
    type, data: { imageUrl: 'image' }, expected: { nodeId: 'source', kind: 'image', imageUrl: 'image' },
  })),
  { type: CANVAS_NODE_TYPES.textAnnotation, data: { content: '  A field.  ' }, expected: { nodeId: 'source', kind: 'text', textContent: 'A field.' } },
  { type: CANVAS_NODE_TYPES.textAnnotation, data: { content: ' \n\t ' }, expected: null },
  { type: CANVAS_NODE_TYPES.imageGen, data: { imageUrl: '', referenceImageUrl: '', previewImageUrl: 'preview' }, expected: null },
  { type: CANVAS_NODE_TYPES.video, data: { imageUrl: 'image' }, expected: null },
  ...[CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.exportImage, CANVAS_NODE_TYPES.storyboardGen].map(type => ({
    type, data: { referenceImageUrl: 'ref' }, expected: null,
  })),
])('reference classification $type $data', ({ type, data, expected }) => {
  const node: CanvasNode = { id: 'source', type, position: { x: 0, y: 0 }, data };
  expect(worldUpstreamReference(node)).toStrictEqual(expected);
});
