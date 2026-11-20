// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { expect, it } from 'vitest';
import en from '../../../../public/locales/en/translation.json';
import zh from '../../../../public/locales/zh/translation.json';
import { answerContextRequests } from '@/features/canvas/server/answerContextRequests';
import { applyCommands } from '@/features/canvas/server/applyCommands';
import { videoReferenceConnectionRejection } from '@/features/canvas/domain/videoReferenceLimits';
import { contextCanvas, contextEnvelopes, contextEnv } from './contextParityFixtures';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

it.each(['en', 'zh', 'en'])('translates action catalogs using the request locale: %s', async locale => {
  const translation = locale === 'en' ? en : zh;
  const answer = await answerContextRequests(contextCanvas, contextEnvelopes([
    { type: 'canvas_action_catalog' }, { type: 'node_action_catalog', node_id: 'video' },
  ]), { ...contextEnv, locale });
  expect(answer.status).toBe('answered');
  if (answer.status !== 'answered') throw new Error('Expected an answer');
  expect(answer.result.ok).toBe(true);
  const responses = JSON.stringify(answer.result.responses);
  expect(responses).toContain(translation.node.videoNode.tabs.textToVideo);
  expect(responses).not.toMatch(/"(?:node|canvas|timeOfDay)\.[^" ]+"/);
  // Both catalogs include the same translated node action.
  expect(JSON.stringify(answer.result.responses[0])).toContain(translation.canvas.story.actionCatalog.captureFirstFrameDescription);
  expect(JSON.stringify(answer.result.responses[1])).toContain(translation.canvas.story.actionCatalog.captureFirstFrameDescription);
});

it.each(['en', 'zh'])('initializes default-instance validation text for both operations: %s', async locale => {
  const translation = locale === 'en' ? en : zh;
  const nodes: CanvasNode[] = [
    ...Array.from({ length: 10 }, (_, index): CanvasNode => ({ id: `image-${index}`, type: 'imageGenNode', position: { x: 0, y: 0 }, data: {} })),
    { id: 'target', type: 'videoNode', position: { x: 0, y: 0 }, data: {} },
  ];
  const edges = nodes.slice(0, 9).map(node => ({ id: node.id, source: node.id, target: 'target' }));
  const check = () => expect(videoReferenceConnectionRejection(nodes, edges, { source: 'image-9', target: 'target' }))
    .toBe(translation.canvas.videoReference.limitImage.replace('{{limit}}', '9'));
  await applyCommands({ nodes: [], edges: [] }, [], { locale, catalogs: {} });
  check();
  await answerContextRequests(contextCanvas, contextEnvelopes([{ type: 'canvas_summary' }]), { ...contextEnv, locale });
  check();
});
