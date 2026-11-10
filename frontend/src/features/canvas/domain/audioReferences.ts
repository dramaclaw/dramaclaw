// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export type FreezoneAudioVoiceRefScope =
  | "project_narrator"
  | "user_custom"
  | "character_default"
  | "character_age_group"
  | "identity"
  | "identity_resolved";

export interface FreezoneAudioVoiceRef {
  scope: FreezoneAudioVoiceRefScope;
  characterName?: string;
  identityId?: string;
  slot?: string;
  voiceId?: string;
}

export interface FreezoneAudioReferenceItem {
  scope: FreezoneAudioVoiceRefScope;
  character_name?: string | null;
  identity_id?: string | null;
  slot?: string | null;
  voice_id?: string | null;
  label?: string | null;
  language?: string | null;
  gender?: string | null;
  preview_url?: string | null;
  [key: string]: unknown;
}

export interface FreezoneAudioReferencesResult {
  available: FreezoneAudioReferenceItem[];
  [key: string]: unknown;
}

export function coerceAudioReferences(payload: unknown): FreezoneAudioReferencesResult {
  if (Array.isArray(payload)) {
    return { available: payload as FreezoneAudioReferenceItem[] };
  }
  if (payload && typeof payload === "object") {
    const wrapper = payload as Record<string, unknown>;
    if (Array.isArray(wrapper.available)) {
      return wrapper as unknown as FreezoneAudioReferencesResult;
    }
    if (Array.isArray(wrapper.items)) {
      return { available: wrapper.items as FreezoneAudioReferenceItem[] };
    }
    if (Array.isArray(wrapper.data)) {
      return { available: wrapper.data as FreezoneAudioReferenceItem[] };
    }
  }
  return { available: [] };
}
