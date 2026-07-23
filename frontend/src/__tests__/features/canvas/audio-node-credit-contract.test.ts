// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  "src/features/canvas/nodes/AudioOperationsPanel.tsx",
  "utf8",
);

describe("canvas audio generation credit contract", () => {
  it("quotes speech and music as separate product features", () => {
    expect(panelSource).toContain(
      "const AUDIO_SPEECH_FEATURE_KEY = 'freezone.audio_speech'",
    );
    expect(panelSource).toContain(
      "const AUDIO_MUSIC_FEATURE_KEY = 'freezone.audio_music'",
    );
    expect(panelSource).toContain(
      "isMusic ? AUDIO_MUSIC_FEATURE_KEY : AUDIO_SPEECH_FEATURE_KEY",
    );
    expect(panelSource).toContain("music_length_ms: musicLengthMs");
    expect(panelSource).toContain(
      "pricing_quantity: musicBillingSeconds",
    );
    expect(panelSource).not.toContain(
      "isMusic ? 'freezone_audio_music' : 'beat_tts'",
    );
  });

  it("shows and blocks on an unconfigured audio feature rule", () => {
    expect(panelSource).toContain(
      "audioCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(panelSource).toContain(
      "t('common.billingRuleNotConfiguredShort')",
    );
    expect(panelSource).toContain(
      "isGenerating || billingRuleMissing || effectivePrompt.length === 0",
    );
  });
});
