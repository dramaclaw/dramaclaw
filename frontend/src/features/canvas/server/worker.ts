// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createInterface } from 'node:readline';
import { Console } from 'node:console';
import { applyCommands, type ApplyCommandsEnvironment } from './applyCommands';
import { answerContextRequests, type AnswerContextEnvironment, type CanvasContextHostData } from './answerContextRequests';
import { extractCanvasContextRequestEnvelopes } from '@/features/freezone/chatNodeReferences';
import { extractCanvasChatCommandEnvelopes } from '../serverEntry';
import { isRecord } from '@/features/freezone/canvasCommandEnvelope';
import { InvalidRequest, invalidRequest, parseCanvasPayload } from './requestPayload';
import { serveImageGenerationRequest, serveImageGenerationPatch } from './imageGeneration';
import { serveVideoGenerationRequest, serveVideoGenerationPatch } from './videoGeneration';
import { serveAudioGenerationRequest, serveAudioGenerationPatch } from './audioGeneration';
import { serveTextGenerationRequest, serveTextGenerationPatch } from './textGeneration';
import { serveImageToolRequest, serveImageToolPatch } from './imageTool';
import { serveAudioTranslateRequest, serveAudioTranslatePatch } from './audioTranslate';
import { serveWorldGenerationRequest, serveWorldGenerationPatch, serveWorldGenerationUpstream } from './worldGeneration';
import { serveGenerationErrorDescribe } from './generationError';
import { servePlanWorkflow } from './planWorkflow';
import { serveRecipeCompileRequest, serveRecipeCompileResult } from './recipeCompile';

console = new Console({ stdout: process.stderr, stderr: process.stderr });

function invalidEnvelope(envelopes: unknown[], field: 'commands' | 'requests', parses: (item: unknown) => boolean): never {
  for (const envelope of envelopes) {
    if (!isRecord(envelope)) continue;
    const items = envelope[field];
    if (!Array.isArray(items)) continue;
    for (const [index, item] of items.entries()) {
      if (parses(item)) continue;
      const type = isRecord(item) && typeof item.type === 'string' ? ` (${item.type})` : '';
      const kind = field === 'commands' ? 'command' : 'context request';
      invalidRequest(`${field}[${index}]${type} is not a valid canvas ${kind}`);
    }
  }
  invalidRequest(field === 'commands' ? 'Invalid command envelope' : 'Invalid context envelope');
}

function parsePayload(payload: unknown) {
  const input = parseCanvasPayload(payload);
  const envelopes = extractCanvasChatCommandEnvelopes(input.envelopes);
  if (envelopes.length !== input.envelopes.length || input.envelopes.some((raw, index) => !isRecord(raw) || !Array.isArray(raw.commands) || raw.commands.length !== envelopes[index].commands.length)) {
    invalidEnvelope(input.envelopes, 'commands', command => extractCanvasChatCommandEnvelopes([{ schema_version: 'canvas_chat_commands.v1', commands: [command] }]).length === 1);
  }
  const env = input.env ?? { catalogs: {} };
  if (!isRecord(env) || (env.locale !== undefined && typeof env.locale !== 'string') || !isRecord(env.catalogs)) invalidRequest('Invalid command environment');
  // JSON callers cannot inject executable ids or clocks.
  const environment: ApplyCommandsEnvironment = { locale: typeof env.locale === 'string' ? env.locale : undefined, catalogs: { image: env.catalogs.image, video: env.catalogs.video } };
  return { canvas: input.canvas, envelopes, environment };
}

function parseContextPayload(payload: unknown) {
  const input = parseCanvasPayload(payload);
  const envelopes = extractCanvasContextRequestEnvelopes(input.envelopes);
  if (envelopes.length !== input.envelopes.length || input.envelopes.some((raw, index) => !isRecord(raw) || !Array.isArray(raw.requests) || raw.requests.length !== envelopes[index].requests.length)) {
    invalidEnvelope(input.envelopes, 'requests', request => extractCanvasContextRequestEnvelopes([{ schema_version: 'canvas_context_request.v1', requests: [request] }]).length === 1);
  }
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

const operations = ['recipe_compile_request', 'recipe_compile_result', 'ping', 'plan_workflow', 'apply_commands', 'answer_context', 'image_generation_request', 'image_generation_patch',
  'video_generation_request', 'video_generation_patch', 'audio_generation_request', 'audio_generation_patch',
  'text_generation_request', 'text_generation_patch', 'generation_error_describe',
  'image_tool_request', 'image_tool_patch', 'audio_translate_request', 'audio_translate_patch',
  'world_generation_request', 'world_generation_patch', 'world_generation_upstream'];

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
    if (!isRecord(parsed) || id === null || typeof parsed.op !== 'string' || !operations.includes(parsed.op)) invalidRequest(`Expected a string id and one of these ops: ${operations.join(', ')}`);
    let result: unknown = { pong: true };
    if (parsed.op === 'apply_commands') {
      const payload = parsePayload(parsed.payload);
      result = await applyCommands(payload.canvas, payload.envelopes, payload.environment);
    } else if (parsed.op === 'plan_workflow') {
      result = await servePlanWorkflow(parsed.payload);
    } else if (parsed.op === 'answer_context') {
      const payload = parseContextPayload(parsed.payload);
      result = await answerContextRequests(payload.canvas, payload.envelopes, payload.environment);
    } else if (parsed.op === 'recipe_compile_request') {
      result = await serveRecipeCompileRequest(parsed.payload);
    } else if (parsed.op === 'recipe_compile_result') {
      result = await serveRecipeCompileResult(parsed.payload);
    } else if (parsed.op === 'image_generation_request') {
      result = await serveImageGenerationRequest(parsed.payload);
    } else if (parsed.op === 'image_generation_patch') {
      result = await serveImageGenerationPatch(parsed.payload);
    } else if (parsed.op === 'video_generation_request') {
      result = await serveVideoGenerationRequest(parsed.payload);
    } else if (parsed.op === 'video_generation_patch') {
      result = await serveVideoGenerationPatch(parsed.payload);
    } else if (parsed.op === 'audio_generation_request') {
      result = await serveAudioGenerationRequest(parsed.payload);
    } else if (parsed.op === 'audio_generation_patch') {
      result = await serveAudioGenerationPatch(parsed.payload);
    } else if (parsed.op === 'text_generation_request') {
      result = await serveTextGenerationRequest(parsed.payload);
    } else if (parsed.op === 'text_generation_patch') {
      result = await serveTextGenerationPatch(parsed.payload);
    } else if (parsed.op === 'image_tool_request') {
      result = await serveImageToolRequest(parsed.payload);
    } else if (parsed.op === 'image_tool_patch') {
      result = await serveImageToolPatch(parsed.payload);
    } else if (parsed.op === 'audio_translate_request') {
      result = await serveAudioTranslateRequest(parsed.payload);
    } else if (parsed.op === 'audio_translate_patch') {
      result = await serveAudioTranslatePatch(parsed.payload);
    } else if (parsed.op === 'world_generation_request') {
      result = await serveWorldGenerationRequest(parsed.payload);
    } else if (parsed.op === 'world_generation_patch') {
      result = await serveWorldGenerationPatch(parsed.payload);
    } else if (parsed.op === 'world_generation_upstream') {
      result = await serveWorldGenerationUpstream(parsed.payload);
    } else if (parsed.op === 'generation_error_describe') {
      result = await serveGenerationErrorDescribe(parsed.payload);
    }
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n');
  } catch (error) {
    const code = error instanceof InvalidRequest ? 'invalid_request' : 'canvas_core_failed';
    if (code === 'canvas_core_failed') console.error(error);
    process.stdout.write(JSON.stringify({ id, ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }) + '\n');
  }
}
