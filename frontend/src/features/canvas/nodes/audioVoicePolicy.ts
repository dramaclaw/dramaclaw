// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { AudioNodeData } from '@/features/canvas/domain/canvasNodes';

/** Historical nodes have neither the voice policy marker nor a new workflow binding. */
export function usesLegacySpeechVoice(data: AudioNodeData): boolean {
  return data.voicePolicyConfirmed !== true && data.workflowCatalog == null;
}

/** True when a speech node has no usable custom/reference voice selection. */
export function requiresCustomVoiceSelection(data: AudioNodeData): boolean {
  if (data.audioKind === 'music') return false;
  if (usesLegacySpeechVoice(data)) {
    if (data.speechMode === 'preset') return false;
    if (data.voiceAvailable === false) return true;
    if (!data.voiceRef) return false; // Historical nodes used the project narrator.
  } else if (data.voiceAvailable !== true || !data.voiceRef) {
    return true;
  }
  if (data.voiceRef.scope !== 'user_custom') return false;
  return typeof data.voiceRef.voiceId !== 'string' || data.voiceRef.voiceId.trim().length === 0;
}
