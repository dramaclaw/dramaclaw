// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isRecord, isFiniteNumber } from '@/features/freezone/canvasCommandEnvelope';
import type { SavedCanvas } from './applyCommands';

export class InvalidRequest extends Error {}

export function invalidRequest(message: string): never {
  throw new InvalidRequest(message);
}

export function parseCanvasPayload(payload: unknown) {
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
