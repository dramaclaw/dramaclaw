// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
const APP_SELF_UPDATE_EVENT = "supertale:app-self-update";

export interface AppSelfUpdateDetail {
  latestTag: string;
}

export function beginAppSelfUpdate(latestTag: string) {
  window.dispatchEvent(
    new CustomEvent<AppSelfUpdateDetail>(APP_SELF_UPDATE_EVENT, { detail: { latestTag } }),
  );
}

export function subscribeAppSelfUpdate(listener: (detail: AppSelfUpdateDetail) => void) {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<AppSelfUpdateDetail>).detail;
    if (detail?.latestTag) listener(detail);
  };
  window.addEventListener(APP_SELF_UPDATE_EVENT, handler);
  return () => window.removeEventListener(APP_SELF_UPDATE_EVENT, handler);
}
