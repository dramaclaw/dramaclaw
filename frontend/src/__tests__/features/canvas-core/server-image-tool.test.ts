// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildImageToolRequest } from '@/features/canvas/application/generationRequests/imageToolRequest';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import * as imageTool from '@/features/canvas/server/imageTool';
import { serveImageToolRequest, serveImageToolPatch } from '@/features/canvas/server/imageTool';
import { actions, imagePayload, source, toolFixtures, placePayload, browserPlacement } from './toolFixtures';
import { invalidToolFields, malformedToolUnions } from './toolValidationFixtures';

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(123); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const fixtures = (await toolFixtures()).filter(f => f.op.startsWith('image_tool_'));
const serve = (op: string, payload: unknown) => op === 'image_tool_place' ? imageTool.serveImageToolPlace(payload) : op === 'image_tool_request' ? serveImageToolRequest(payload) : serveImageToolPatch(payload);
it.each(fixtures)('matches the pure result without mutation: $name', async fixture => {
  const before = structuredClone(fixture.payload);
  expect(await serve(fixture.op, fixture.payload)).toStrictEqual(await fixture.expected());
  expect(fixture.payload).toStrictEqual(before);
});
it.each(invalidToolFields(fixtures))('rejects invalid field: $name', async fixture => {
  await expect(serve(fixture.op, fixture.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it.each(malformedToolUnions.filter(f => f.op.startsWith('image_tool_')))('rejects malformed union %j', async fixture => {
  await expect(serve(fixture.op, fixture.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it.each([null, [], {}, { phase: 'unknown' }])('rejects invalid payload %j', async payload => {
  await expect(serveImageToolRequest(payload)).rejects.toBeInstanceOf(InvalidRequest);
  await expect(serveImageToolPatch(payload)).rejects.toBeInstanceOf(InvalidRequest);
});

it.each(actions.flatMap(action => ['data:image/png;base64,AA==', 'blob:https://media.example.test/image'].map(imageUrl => ({ action, imageUrl }))))(
  'refuses inline sources only at the server boundary: $action $imageUrl', async ({ action, imageUrl }) => {
    const p = imagePayload(action); p.canvas.nodes = [source({ imageUrl })];
    const response = await serveImageToolRequest(p);
    expect(response).toStrictEqual({ ok: false, message: 'Inline image sources must be prepared before building an image tool request.' });
    expect(JSON.stringify(response)).not.toContain(imageUrl);
    expect(buildImageToolRequest({
      action, nodes: p.canvas.nodes, nodeId: p.node_id, projectId: p.env.project,
      imageModels: [], translate: key => key, nowMs: p.env.now_ms,
    }).ok).toBe(true);
  });


it('places the child as the browser store does, retaining owner and builder data', async () => {
  const payload = placePayload();
  const expected = await browserPlacement(payload);
  const actual = await imageTool.serveImageToolPlace(payload);
  expect(actual.node).toMatchObject({ id: payload.child_node_id, type: 'exportImageNode',
    data: payload.child.data, position: expected.node?.position });
  expect(actual.edge).toStrictEqual(expected.edge);
  expect(actual.edge?.id).toBe('e-source-placed-child');
});

it('returns null when addEdge refuses', async () => {
  const payload = placePayload();
  payload.edge.source = 'missing';
  expect((await imageTool.serveImageToolPlace(payload)).edge).toBeNull();
});

it.each([
  null, {}, { ...placePayload(), extra: true },
  ...Object.keys(placePayload()).map(key => Object.fromEntries(
    Object.entries(placePayload()).filter(([field]) => field !== key),
  )),
  { ...placePayload(), child: { ...placePayload().child, extra: true } },
  { ...placePayload(), child: { ...placePayload().child, type: 'textNode' } },
  { ...placePayload(), child: { ...placePayload().child, layout: { width: 1, height: 2 } } },
  { ...placePayload(), edge: { source: 'source', target: 'actual-child' } },
])('rejects invalid placement payload %j', async payload => {
  await expect(imageTool.serveImageToolPlace(payload)).rejects.toBeInstanceOf(InvalidRequest);
});

it.each(actions)('preserves refusal order: %s', async action => {
  const payload = imagePayload(action);
  payload.env.project = '';
  payload.canvas.nodes = [source({ imageUrl: 'data:image/png;base64,AA==' })];
  expect(await serveImageToolRequest(payload)).toStrictEqual({
    ok: false, message: '当前 URL 缺少 project，无法提交生成',
  });
  payload.canvas.nodes = [];
  expect(await serveImageToolRequest(payload)).toStrictEqual({
    ok: false, message: action === 'run_outpaint_tool' ? '目标节点没有可用于扩图的图片'
      : action === 'run_upscale_tool' ? '目标节点没有可用于高清放大的图片'
        : '目标节点没有可用于生成的图片',
  });
});
