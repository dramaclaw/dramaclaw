// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { expect, it } from 'vitest';
import { answerContextRequests } from '@/features/canvas/server/answerContextRequests';
import { contextCanvas, contextEnvelopes, contextEnv, contextHostData, contextNeeds, contextRequests } from './contextParityFixtures';
import { compareContextParity } from './contextParityComparison';

it('discovers all host needs in one pass, then matches browser reads', async () => {
  expect(await answerContextRequests(contextCanvas, contextEnvelopes(), contextEnv)).toEqual({ status: 'needs_host_data', needs: contextNeeds });
  const answer = await answerContextRequests(contextCanvas, contextEnvelopes(), { ...contextEnv, hostData: contextHostData });
  expect(answer.status).toBe('answered');
  if (answer.status === 'answered') compareContextParity(answer.result);
});
it('answers pure reads without host data', async () => {
  const pure = contextRequests.filter(request => !['audio_voice_options', 'node_action_read', 'mainline_projection_assets'].includes(request.type));
  expect(await answerContextRequests(contextCanvas, contextEnvelopes(pure), contextEnv)).toMatchObject({ status: 'answered', result: { ok: true } });
});

it('requests only missing keys and deduplicates repeated host reads', async () => {
  const requests = contextEnvelopes([
    { type: 'node_action_read', node_id: 'html', action: 'read_source', parameters: { version: 1 } },
    { type: 'node_action_read', node_id: 'html', action: 'read_source', parameters: { version: 1 } },
    { type: 'mainline_projection_assets' },
  ]);
  expect(await answerContextRequests(contextCanvas, requests, { ...contextEnv, hostData: { project_assets: [] } })).toEqual({
    status: 'needs_host_data', needs: [{ kind: 'html_artifact', artifact_id: 'page', version: 1 }, { kind: 'characters' }],
  });
  expect(await answerContextRequests(contextCanvas, requests, { ...contextEnv, hostData: contextHostData })).toMatchObject({
    status: 'answered', result: { ok: true, responses: [{ data: { version: 1, html: '<html>Old log</html>' } }, { data: { version: 1 } }, { type: 'mainline_projection_assets' }] },
  });
});

it.each([
  { type: 'node_action_read', node_id: 'absent', action: 'read_source', message: 'node not found: absent' },
  { type: 'node_action_read', node_id: 'html', action: 'read_source', message: 'Artifact not found', hostData: { html_artifacts: { 'page@latest': { error: { message: 'Artifact not found' } } } } },
  { type: 'node_action_read', node_id: 'html', action: 'history', message: 'History unavailable', hostData: { html_versions: { page: { error: { message: 'History unavailable' } } } } },
  { type: 'mainline_projection_assets', message: 'Assets unavailable', hostData: { project_assets: { error: { message: 'Assets unavailable' } }, characters: [] } },
  { type: 'mainline_projection_assets', message: 'Characters unavailable', hostData: { project_assets: [], characters: { error: { message: 'Characters unavailable' } } } },
])('returns the browser failure body: $message', async ({ message, ...testCase }) => {
  const { hostData, ...request } = 'hostData' in testCase ? testCase : { ...testCase, hostData: undefined };
  const result = await answerContextRequests(contextCanvas, [{ schema_version: 'canvas_context_request.v1', requests: [request] }], { ...contextEnv, hostData });
  expect(result).toEqual({ status: 'answered', result: {
    project_id: contextEnv.project, canvas_id: contextEnv.canvasId, ok: false,
    tool_call_status: 'failed', canvas_context_status: 'failed', responses: [], errors: [`读取画布上下文失败：${message}`],
    message: 'Frontend failed to resolve requested canvas context.',
  } });
});

it('keeps the browser audio fetch failure response inside the successful context result', async () => {
  expect(await answerContextRequests(contextCanvas, contextEnvelopes([{ type: 'audio_voice_options', node_id: 'audio' }]), {
    ...contextEnv, hostData: { audio_references: { error: { message: 'Audio unavailable' } } },
  })).toMatchObject({ status: 'answered', result: { ok: true, responses: [{ data: { current: null, options: [], error: 'Audio unavailable' } }] } });
});
