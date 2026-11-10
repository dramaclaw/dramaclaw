// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createInterface } from 'node:readline';
import { Console } from 'node:console';
import { applyCommands, type SavedCanvas, type ApplyCommandsEnvironment } from './applyCommands';
import { answerContextRequests, type AnswerContextEnvironment, type CanvasContextHostData } from './answerContextRequests';
import { extractCanvasContextRequestEnvelopes } from '@/features/freezone/chatNodeReferences';
import { extractCanvasChatCommandEnvelopes } from '../serverEntry';
import { isRecord, isFiniteNumber } from '@/features/freezone/canvasCommandEnvelope';

console = new Console({ stdout: process.stderr, stderr: process.stderr });

function invalidRequest(message: string): never {
  throw new Error(message);
}

function parseCanvasPayload(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.canvas) || !Array.isArray(payload.envelopes)) invalidRequest('canvas and envelopes are required');
  const canvas = payload.canvas;
  if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) invalidRequest('canvas nodes and edges must be arrays');
  for (const node of canvas.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || typeof node.type !== 'string' || !isRecord(node.data) || !isRecord(node.position) || !isFiniteNumber(node.position.x) || !isFiniteNumber(node.position.y)) invalidRequest('Invalid canvas node');
  }
  for (const edge of canvas.edges) {
    if (!isRecord(edge) || typeof edge.id !== 'string' || typeof edge.source !== 'string' || typeof edge.target !== 'string') invalidRequest('Invalid canvas edge');
  }
  return { canvas: canvas as unknown as SavedCanvas & { canvas_id?: string }, envelopes: payload.envelopes, env: payload.env };
}

function parsePayload(payload: unknown) {
  const input = parseCanvasPayload(payload);
  const envelopes = extractCanvasChatCommandEnvelopes(input.envelopes);
  if (envelopes.length !== input.envelopes.length || input.envelopes.some((raw, index) => !isRecord(raw) || !Array.isArray(raw.commands) || raw.commands.length !== envelopes[index].commands.length)) invalidRequest('Invalid command envelope');
  const env = input.env ?? { catalogs: {} };
  if (!isRecord(env) || (env.locale !== undefined && typeof env.locale !== 'string') || !isRecord(env.catalogs)) invalidRequest('Invalid command environment');
  // JSON callers cannot inject executable ids or clocks.
  const environment: ApplyCommandsEnvironment = { locale: typeof env.locale === 'string' ? env.locale : undefined, catalogs: { image: env.catalogs.image, video: env.catalogs.video } };
  return { canvas: input.canvas, envelopes, environment };
}

function parseContextPayload(payload: unknown) {
  const input = parseCanvasPayload(payload);
  const envelopes = extractCanvasContextRequestEnvelopes(input.envelopes);
  if (envelopes.length !== input.envelopes.length || input.envelopes.some((raw, index) => !isRecord(raw) || !Array.isArray(raw.requests) || raw.requests.length !== envelopes[index].requests.length)) invalidRequest('Invalid context envelope');
  const env = input.env ?? {};
  if (!isRecord(env) || (env.locale !== undefined && typeof env.locale !== 'string') ||
    (env.project !== undefined && typeof env.project !== 'string') ||
    (env.canvasId !== undefined && typeof env.canvasId !== 'string') ||
    (env.username !== undefined && env.username !== null && typeof env.username !== 'string') ||
    (env.catalogs !== undefined && !isRecord(env.catalogs)) ||
    (env.selectedNodeIds !== undefined && (!Array.isArray(env.selectedNodeIds) || !env.selectedNodeIds.every(id => typeof id === 'string'))) ||
    (env.hostData !== undefined && !isRecord(env.hostData))) invalidRequest('Invalid context environment');
  const environment: AnswerContextEnvironment = {
    locale: typeof env.locale === 'string' ? env.locale : undefined,
    project: typeof env.project === 'string' ? env.project : undefined,
    canvasId: typeof env.canvasId === 'string' ? env.canvasId : undefined,
    username: typeof env.username === 'string' ? env.username : null,
    catalogs: isRecord(env.catalogs) ? { image: env.catalogs.image, video: env.catalogs.video } : {},
    selectedNodeIds: Array.isArray(env.selectedNodeIds) ? env.selectedNodeIds : [],
    hostData: isRecord(env.hostData) ? env.hostData as CanvasContextHostData : undefined,
  };
  return { ...input, envelopes, environment };
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let id: string | null = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: { code: 'invalid_json', message: error instanceof Error ? error.message : String(error) } }) + '\n');
    continue;
  }
  try {
    if (isRecord(parsed) && typeof parsed.id === 'string') id = parsed.id;
    if (!isRecord(parsed) || id === null || (parsed.op !== 'ping' && parsed.op !== 'apply_commands' && parsed.op !== 'answer_context')) invalidRequest('Expected a string id and ping, apply_commands or answer_context op');
    let result: unknown = { pong: true };
    if (parsed.op === 'apply_commands') {
      const payload = parsePayload(parsed.payload);
      result = await applyCommands(payload.canvas, payload.envelopes, payload.environment);
    } else if (parsed.op === 'answer_context') {
      const payload = parseContextPayload(parsed.payload);
      result = await answerContextRequests(payload.canvas, payload.envelopes, payload.environment);
    }
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: { code: 'invalid_request', message: error instanceof Error ? error.message : String(error) } }) + '\n');
  }
}
