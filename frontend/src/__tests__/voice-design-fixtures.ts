// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export const designModels = [
  {
    catalog_id: "qwen",
    label: "Qwen",
    model: "qwen-voice-design",
    mode: "resource",
    target_model: {
      catalog_id: "qwen-speech",
      model: "qwen3-tts-vd-2026-01-26",
    },
    config_digest: "a".repeat(64),
    execution_mode: "gateway",
  },
  {
    catalog_id: "cosy",
    label: "CosyVoice",
    model: "voice-enrollment",
    mode: "resource",
    target_model: { catalog_id: "cosy-speech", model: "cosyvoice-v3.5-flash" },
    config_digest: "b".repeat(64),
    execution_mode: "gateway",
  },
  {
    catalog_id: "seed",
    label: "Seed Audio",
    model: "seed-audio-1.0",
    mode: "prompted_speech",
    target_model: null,
    config_digest: "c".repeat(64),
    execution_mode: "test_replay",
  },
] as const;
