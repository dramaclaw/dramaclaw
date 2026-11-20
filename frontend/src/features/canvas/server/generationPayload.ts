// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isRecord, isFiniteNumber } from '@/features/freezone/canvasCommandEnvelope';
import type { ImageGenerationTaskRef } from '../application/generationRequests';
import { invalidRequest, parseCanvasPayload } from './requestPayload';

type Parser<T> = (value: unknown) => T;
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalidRequest('Expected an object');
  return value;
}
export function hasField(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
export function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = record(value);
  if (Object.keys(input).some(key => !keys.includes(key))) invalidRequest('Unexpected field');
  return input;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') invalidRequest('Expected a string');
  return value;
}
export function number(value: unknown): number {
  if (!isFiniteNumber(value)) invalidRequest('Expected a finite number');
  return value;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidRequest('Expected a boolean');
  return value;
}
export function optional<T>(value: unknown, parse: Parser<T>): T | undefined {
  return value === undefined ? undefined : parse(value);
}
export function nullable<T>(value: unknown, parse: Parser<T>): T | null {
  return value === null ? null : parse(value);
}
export function array<T>(value: unknown, parse: Parser<T>): T[] {
  if (!Array.isArray(value)) invalidRequest('Expected an array');
  return value.map(parse);
}
export function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  for (const candidate of choices) if (value === candidate) return candidate;
  return invalidRequest('Unknown value');
}
export function task(value: unknown): ImageGenerationTaskRef {
  const input = fields(value, ['task_key', 'task_type', 'job_id']);
  return { task_key: string(input.task_key), task_type: string(input.task_type), job_id: string(input.job_id) };
}
export function metadata(value: unknown) {
  const input = fields(value, ['mode', 'prompt', 'recipeIds']);
  return { mode: choice(input.mode, ['deterministic', 'memory_cache', 'persistent_cache', 'model', 'timeout_fallback']),
    prompt: string(input.prompt), recipeIds: array(input.recipeIds, string) };
}
export function productOperation(value: unknown) {
  if (value === undefined || value === null) return null;
  const input = fields(value, ['projectId', 'operationId', 'generationAttemptId']);
  return { projectId: string(input.projectId), operationId: string(input.operationId),
    generationAttemptId: optional(input.generationAttemptId, string) };
}
export function graph(payload: Record<string, unknown>) {
  const { canvas } = parseCanvasPayload({ ...payload, envelopes: [] });
  const env = record(payload.env);
  return { canvas, nodeId: string(payload.node_id), env, locale: optional(env.locale, string),
    productOperation: productOperation(env.productOperation) };
}
export function patch(payload: unknown) {
  const input = record(payload);
  return { input, phase: string(input.phase), locale: optional(input.locale, string) };
}
