// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { TaskCompletionError } from '@/api/tasks';
import {
  buildImageGenerationSuccessPatch,
  isStaleGenerationTask,
  shouldWriteGenerationError,
} from '@/features/canvas/application/generationTaskArbitration';
import { resolveGenerationErrorDiagnostics } from '@/features/canvas/application/generationErrorReport';
import { backendErrorToastMessage } from '@/lib/api-errors';

const t = ((key: string) => key) as unknown as Parameters<typeof backendErrorToastMessage>[1];

describe('generation task arbitration', () => {
  it('shows a concise task error while preserving its raw response and request id', () => {
    const rawError =
      'video generation failed: request_id=req-123; ' +
      'body={"error":{"message":"Content failed safety review.","code":"moderation_blocked"}}';
    const error = new TaskCompletionError(rawError, 'failed', 'task-current');

    expect(backendErrorToastMessage(error, t)).toBe('Content failed safety review.');
    expect(resolveGenerationErrorDiagnostics(error)).toEqual({
      details: rawError,
      requestId: 'req-123',
    });
  });

  it('keeps provider policy codes searchable after normalizing the displayed message', () => {
    const policyCode = 'InputImageSensitiveContentDetected.PrivateInformation';
    const rawError =
      'video generation failed: request_id=req-sensitive; ' +
      `body={"error":{"message":"Sensitive input image.","code":"${policyCode}"}}`;
    const error = new TaskCompletionError(rawError, 'failed', 'task-current');
    const displayMessage = backendErrorToastMessage(error, t);
    const diagnostics = resolveGenerationErrorDiagnostics(error);

    expect(displayMessage).toBe('Sensitive input image.');
    expect(displayMessage).not.toContain(policyCode);
    expect(`${displayMessage}\n${diagnostics.details ?? ''}`).toContain(policyCode);
  });

  it('clears stale generation errors when an image generation succeeds', () => {
    expect(buildImageGenerationSuccessPatch('/outputs/image.png')).toEqual({
      imageUrl: '/outputs/image.png',
      previewImageUrl: '/outputs/image.png',
      isGenerating: false,
      generationStartedAt: null,
      generationError: null,
      generationErrorDetails: null,
      generationErrorRequestId: null,
    });
  });

  it('does not write a cancelled error over an existing generated image', () => {
    const shouldWrite = shouldWriteGenerationError({
      nodeData: {
        imageUrl: '/outputs/image.png',
        generationTaskKey: 'task-current',
      },
      taskKey: 'task-current',
      error: new TaskCompletionError('task cancelled', 'cancelled', 'task-current'),
    });

    expect(shouldWrite).toBe(false);
  });

  it('does not write errors from stale tasks that are no longer registered on the node', () => {
    const shouldWrite = shouldWriteGenerationError({
      nodeData: {
        generationTaskKey: 'task-newer',
      },
      taskKey: 'task-older',
      error: new Error('task failed'),
    });

    expect(shouldWrite).toBe(false);
  });

  it('identifies stale task settlements separately from current task settlements', () => {
    expect(isStaleGenerationTask({
      nodeData: { generationTaskKey: 'task-newer' },
      taskKey: 'task-older',
    })).toBe(true);
    expect(isStaleGenerationTask({
      nodeData: { generationTaskKey: 'task-current' },
      taskKey: 'task-current',
    })).toBe(false);
  });

  it('writes errors from the current failed task when there is no successful image', () => {
    const shouldWrite = shouldWriteGenerationError({
      nodeData: {
        generationTaskKey: 'task-current',
      },
      taskKey: 'task-current',
      error: new TaskCompletionError('provider failed', 'failed', 'task-current'),
    });

    expect(shouldWrite).toBe(true);
  });

  it('writes cancelled errors for the current task when the node has no generated media', () => {
    const shouldWrite = shouldWriteGenerationError({
      nodeData: {
        generationTaskKey: 'task-current',
      },
      taskKey: 'task-current',
      error: new TaskCompletionError('task cancelled', 'cancelled', 'task-current'),
    });

    expect(shouldWrite).toBe(true);
  });
});
