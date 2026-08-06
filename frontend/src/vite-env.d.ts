// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_DIRECTOR_VIEWER_URL?: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_SUPERCHAT_URL?: string;
  readonly VITE_SUPERCHAT_WS_URL?: string;
  readonly VITE_CLUSTER_MODE?: "none" | "multi-region";
  readonly VITE_CLUSTER_REGIONS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
