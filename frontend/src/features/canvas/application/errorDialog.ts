// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from 'i18next';

import { openGlobalErrorDialog } from '@/features/app/errorDialogEvents';

export { resolveErrorContent } from '../domain/errorContent';
export type { ResolvedErrorContent } from '../domain/errorContent';

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
export function notifyTaskStillRunning(t?: TFunction): void {
  showTaskStillRunningDialog({
    title: t ? t('errorDialog.stillRunningTitle') : 'Still generating',
    message: t
      ? t('errorDialog.stillRunningMessage')
      : 'This generation is taking longer than expected. The page has stopped waiting, but the task is still running in the background. Refresh later or check the task centre for progress.',
  });
}
