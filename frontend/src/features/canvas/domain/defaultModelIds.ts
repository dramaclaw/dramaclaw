// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/** Image model new image nodes and edit overlays start from. */
export const DEFAULT_SHARED_MODEL_ID = 'newapi_gpt_image2';

// Matches the backend `FreezoneVideoGenRequest.model` default. The picker
// hydrates the live list via /freezone/video/models, but this id is what the
// canvas store uses on first node creation before that fetch resolves (and
// when no previously-picked model has been remembered).
export const DEFAULT_VIDEO_MODEL_ID = 'newapi_seedance-2.0';
