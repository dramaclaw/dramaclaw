// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createInterface } from 'node:readline';
import { Console } from 'node:console';
import { applyCommands, type SavedCanvas, type ApplyCommandsEnvironment } from './applyCommands';
import { extractCanvasChatCommandEnvelopes } from '../serverEntry';
import { isRecord, isFiniteNumber } from '@/features/freezone/canvasCommandEnvelope';

console = new Console({ stdout: process.stderr, stderr: process.stderr });

function invalidRequest(message: string): never {
  throw new Error(message);
}

function parsePayload(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.canvas) || !Array.isArray(payload.envelopes)) invalidRequest('canvas and envelopes are required');
  const canvas = payload.canvas;
  if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) invalidRequest('canvas nodes and edges must be arrays');
  for (const node of canvas.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || typeof node.type !== 'string' || !isRecord(node.data) || !isRecord(node.position) || !isFiniteNumber(node.position.x) || !isFiniteNumber(node.position.y)) invalidRequest('Invalid canvas node');
  }
  for (const edge of canvas.edges) {
    if (!isRecord(edge) || typeof edge.id !== 'string' || typeof edge.source !== 'string' || typeof edge.target !== 'string') invalidRequest('Invalid canvas edge');
  }
  const envelopes = extractCanvasChatCommandEnvelopes(payload.envelopes);
  if (envelopes.length !== payload.envelopes.length || payload.envelopes.some((raw, index) => !isRecord(raw) || !Array.isArray(raw.commands) || raw.commands.length !== envelopes[index].commands.length)) invalidRequest('Invalid command envelope');
  const env = payload.env ?? { catalogs: {} };
  if (!isRecord(env) || (env.locale !== undefined && typeof env.locale !== 'string') || !isRecord(env.catalogs)) invalidRequest('Invalid command environment');
  // JSON callers cannot inject executable ids or clocks.
  const environment: ApplyCommandsEnvironment = { locale: typeof env.locale === 'string' ? env.locale : undefined, catalogs: { image: env.catalogs.image, video: env.catalogs.video } };
  return { canvas: canvas as unknown as SavedCanvas, envelopes, environment };
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
    if (!isRecord(parsed) || id === null || (parsed.op !== 'ping' && parsed.op !== 'apply_commands')) invalidRequest('Expected a string id and ping or apply_commands op');
    const payload = parsed.op === 'apply_commands' ? parsePayload(parsed.payload) : null;
    const result = payload ? await applyCommands(payload.canvas, payload.envelopes, payload.environment) : { pong: true };
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: { code: 'invalid_request', message: error instanceof Error ? error.message : String(error) } }) + '\n');
  }
}
