// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isAudioNode, type CanvasNode } from '../../domain/canvasNodes';
import { deriveAudioText } from '../../nodes/audioGenerationText';
import type { WorkflowProductOperationContext } from '../workflowExecutionActivity';

export interface AudioTranslateRequestContext {
  /** Latest store snapshot, as read by the translate_text subscriber. */
  nodes: readonly CanvasNode[];
  nodeId: string;
  projectId: string | null | undefined;
  /** URL canvas with the caller's nullish 'default' fallback already applied. */
  canvasId: string;
  productOperation: WorkflowProductOperationContext | null;
}
export type AudioTranslateRequestResult =
  | { ok: false; code: 'no_project' | 'not_audio_node' | 'empty_text'; message: string }
  | { ok: true; request: { method: 'POST'; path: string; body: Record<string, unknown> } };

/** AudioNode translate_text guards, followed by the text-translate ops serializer. */
export function buildAudioTranslateRequest(ctx: AudioTranslateRequestContext): AudioTranslateRequestResult {
  if (!ctx.projectId) {
    return { ok: false, code: 'no_project', message: '缺少项目 ID，无法翻译音频文本' }; // i18n-exempt -- exact subscriber refusal
  }
  const node = ctx.nodes.find(candidate => candidate.id === ctx.nodeId);
  if (!isAudioNode(node)) {
    return { ok: false, code: 'not_audio_node', message: '音频节点不存在' }; // i18n-exempt -- exact subscriber refusal
  }
  const text = deriveAudioText(node.data).trim();
  if (!text) {
    return { ok: false, code: 'empty_text', message: '音频节点没有可翻译文本' }; // i18n-exempt -- exact subscriber refusal
  }
  return { ok: true, request: { method: 'POST',
    path: `projects/${encodeURIComponent(ctx.projectId)}/freezone/text/translate`,
    body: { text, node_type: 'audio',
      ...(ctx.canvasId ? { canvas_id: ctx.canvasId } : {}),
      ...(ctx.nodeId ? { node_id: ctx.nodeId } : {}),
      ...(ctx.productOperation?.generationAttemptId ? {
        product_operation_id: ctx.productOperation.operationId,
        generation_attempt_id: ctx.productOperation.generationAttemptId,
      } : {}),
    },
  } };
}

/** Pass fetchFreezoneTextTranslateResult's translated_text unchanged, including ''. No task descriptor is written. */
export function audioTranslateResultPatch(translatedText: string): { text: string } {
  return { text: translatedText };
}

/** Failures publish raw Error.message or String(thrown), with no node write. */
export function audioTranslateActionResult(input: { text: string } | { error: string }):
  { status: 'success'; output: { text: string } } | { status: 'error'; error: string } {
  return 'error' in input ? { status: 'error', error: input.error }
    : { status: 'success', output: { text: input.text } };
}
