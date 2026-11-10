// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { initializeWorkerI18n } from './i18n';

let pending: Promise<unknown> = Promise.resolve();

// Both operations share the worker's catalogs and default i18next instance.
export function runServerRequest<T>(locale: string | undefined, task: () => Promise<T>): Promise<T> {
  const next = pending.then(async () => {
    await initializeWorkerI18n(locale);
    return task();
  });
  pending = next.catch(() => {});
  return next;
}
