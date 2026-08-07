// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * `pending` is for outcomes that are not failures — most notably "the front-end
 * stopped waiting but the backend job is still running". It keeps the dialog
 * shell but drops the error semantics (icon, tone, wording).
 */
export type GlobalErrorDialogVariant = 'error' | 'pending';

export interface GlobalErrorDialogDetail {
  title: string;
  message: string;
  details?: string;
  copyText?: string;
  variant?: GlobalErrorDialogVariant;
}

const OPEN_ERROR_DIALOG_EVENT = 'storyboard:open-error-dialog';

export function openGlobalErrorDialog(detail: GlobalErrorDialogDetail): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent<GlobalErrorDialogDetail>(OPEN_ERROR_DIALOG_EVENT, { detail }));
}

export function subscribeOpenGlobalErrorDialog(
  callback: (detail: GlobalErrorDialogDetail) => void
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<GlobalErrorDialogDetail>;
    callback(customEvent.detail);
  };

  window.addEventListener(OPEN_ERROR_DIALOG_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(OPEN_ERROR_DIALOG_EVENT, handler as EventListener);
  };
}
