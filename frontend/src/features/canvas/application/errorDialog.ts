// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from 'i18next';

import { openGlobalErrorDialog } from '@/features/app/errorDialogEvents';

export interface ResolvedErrorContent {
  message: string;
  details?: string;
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function resolveErrorContent(error: unknown, fallbackMessage: string): ResolvedErrorContent {
  if (error instanceof Error) {
    const errorWithDetails = error as ErrorWithDetails;
    const details = stringifyUnknown(errorWithDetails.details);
    return {
      message: error.message?.trim() || fallbackMessage,
      details: details?.trim() || undefined,
    };
  }

  if (typeof error === 'string') {
    const content = error.trim();
    return {
      message: content || fallbackMessage,
      details: content || undefined,
    };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const candidate =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.error === 'string' && record.error) ||
      (typeof record.details === 'string' && record.details) ||
      (typeof record.msg === 'string' && record.msg) ||
      '';
    const details = stringifyUnknown(record);
    return {
      message: candidate.trim() || fallbackMessage,
      details: details?.trim() || undefined,
    };
  }

  return { message: fallbackMessage };
}

export async function showErrorDialog(
  text: string,
  title: string,
  details?: string,
  copyText?: string
): Promise<void> {
  const content = text.trim();
  if (!content) {
    return;
  }

  openGlobalErrorDialog({
    title,
    message: content,
    details: details?.trim() || undefined,
    copyText: copyText?.trim() || undefined,
    variant: 'error',
  });
}

/**
 * Same shell as {@link showErrorDialog} but without the failure semantics — for
 * outcomes where nothing broke, e.g. the front-end stopped waiting on a task
 * that the backend is still working on. Callers pass already-translated text.
 */
export function showTaskStillRunningDialog(params: {
  title: string;
  message: string;
  details?: string;
}): void {
  const content = params.message.trim();
  if (!content) {
    return;
  }

  openGlobalErrorDialog({
    title: params.title,
    message: content,
    details: params.details?.trim() || undefined,
    variant: 'pending',
  });
}

/**
 * The single reaction to a {@link import('@/api/tasks').TaskPollTimeoutError}:
 * every flow that hits one wants the same neutral notice, and none of them may
 * write a generation error (the job is still running and the node still holds a
 * resumable task handle). Pass the component's `t`.
 */
export function notifyTaskStillRunning(t: TFunction): void {
  showTaskStillRunningDialog({
    title: t('errorDialog.stillRunningTitle'),
    message: t('errorDialog.stillRunningMessage'),
  });
}
