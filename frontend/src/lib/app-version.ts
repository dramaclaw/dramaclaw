// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Build-time constants, injected by Vite's `define` (see vite.config.ts).
 *
 * APP_VERSION — the human-facing version shown in the status bar.
 *   1. $VITE_APP_VERSION in the build environment (set by CI from the git tag).
 *   2. a hardcoded default otherwise.
 * Two different builds can carry the SAME APP_VERSION, so never use it to
 * decide whether a deploy happened — use BUILD_ID for that.
 *
 * BUILD_ID — the deploy fingerprint, unique per build (`git describe`, or the
 * build timestamp when git is unavailable). version-update-watch compares it
 * against the deployed /version.json to detect that a new bundle shipped.
 */
declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;

export const APP_VERSION: string = __APP_VERSION__;
export const BUILD_ID: string = __BUILD_ID__;
