// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { AudioNodeData, AudioTextSegment } from '../domain/canvasNodes';

// Preserve the hook's truncation: 3,900 + newline + 200 = 4,101 code units.
const MAX_MUSIC_PROMPT_CHARS = 4_100;

export function normalizeMusicPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= MAX_MUSIC_PROMPT_CHARS) return trimmed;
  const tailLength = 200;
  return `${trimmed.slice(0, MAX_MUSIC_PROMPT_CHARS - tailLength)}\n${trimmed.slice(-tailLength)}`;
}

/** String text wins, including an empty string; otherwise join legacy text segments. */
export function deriveAudioText(data: AudioNodeData): string {
  if (typeof data.text === 'string') return data.text;
  if (Array.isArray(data.segments)) {
    return data.segments
      .map((seg: AudioTextSegment) => (seg.type === 'text' ? seg.value : ''))
      .join('');
  }
  return '';
}

