// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TextAnnotationNodeData } from '../../domain/canvasNodes';

export type TextGenerationOutcome =
  | { kind: 'completed'; content: string }
  | {
      kind: 'failed';
      /** Error.message for Errors (including ''); String(thrown) for non-Errors. */
      message: string;
      isError: boolean;
    };
export type TextGenerationOutcomeResult =
  | { patch: Partial<TextAnnotationNodeData>; output: { content: string } }
  | { patch: Partial<TextAnnotationNodeData>; error: { message: string; isError: boolean } };

/** runRecipeText starts before recipe validation; only the raw error field is cleared. */
export function textGenerationStartPatch(startedAtMs: number): Partial<TextAnnotationNodeData> {
  return { isGenerating: true, generationStartedAt: startedAtMs, generationError: null };
}

/**
 * Apply start, then this single outcome patch. Quirks of runRecipeText:
 * - No accepted phase, persisted task handle, or stale-task/attempt arbitration.
 *   The subscriber publishes action acceptance immediately, without a node patch.
 * - Completed content is stored/returned as-is, including empty/whitespace text.
 *   Success does not clear generationError again after start.
 * - Failure retains prior content and workflowTextGenerated; Error.message is
 *   stored verbatim even when empty. Only a non-Error uses the literal fallback.
 * - Neither outcome clears task fields, diagnostics or workflowResultStale.
 *
 * For GenerationErrorInfo from describeGenerationSubmitFailure use info.message
 * and isError: true: that function reconstructs an Error for every submit failure.
 * Never use info.display. This path does not call backendErrorToastMessage or show
 * its classified text in a toast; it stores the raw message and publishes it.
 * Arbitrary non-Errors need their original type flag and String(thrown); a general
 * GenerationErrorInfo alone cannot recover that flag. The browser rethrows the
 * original value unchanged; error describes its serializable publication, not
 * its identity, stack or cause. Preserve the original value if rethrowing locally.
 */
export function textGenerationOutcomePatch(input: { outcome: TextGenerationOutcome }): TextGenerationOutcomeResult {
  const { outcome } = input;
  const stopped = { isGenerating: false, generationStartedAt: null };
  if (outcome.kind === 'completed') {
    return { patch: { ...stopped, content: outcome.content, workflowTextGenerated: true },
      output: { content: outcome.content } };
  }
  return { patch: { ...stopped,
    generationError: outcome.isError ? outcome.message : '文本生成失败', // i18n-exempt -- exact runRecipeText non-Error fallback
  }, error: { message: outcome.message, isError: outcome.isError } };
}
