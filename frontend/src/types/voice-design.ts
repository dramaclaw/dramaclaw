// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { z } from "zod";

export const voiceDesignSurfaceSchema = z.enum(["supertale", "canvas"]);
export type VoiceDesignSurface = z.infer<typeof voiceDesignSurfaceSchema>;
const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export const voiceDesignErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string(),
  retryable: z.boolean(),
  request_id: z.string(),
  details: z
    .object({
      field: z.string().nullish(),
      duration_seconds: z.number().nullish(),
      retry_after_seconds: z.number().nullish(),
    })
    .nullish(),
});
const modelFields = {
  catalog_id: z.string().min(1),
  label: z.string(),
  model: z.string().min(1),
  config_digest: z.string().regex(/^[0-9a-f]{64}$/),
  execution_mode: z.enum(["gateway", "test_replay"]),
};
export const voiceDesignModelSchema = z.discriminatedUnion("mode", [
  z.object({
    ...modelFields,
    mode: z.literal("resource"),
    target_model: z.object({
      catalog_id: z.string().min(1),
      model: z.string().min(1),
    }),
  }),
  z.object({
    ...modelFields,
    mode: z.literal("prompted_speech"),
    target_model: z.null(),
  }),
]);
export const voiceDesignModelsSchema = z.object({
  models: z.array(voiceDesignModelSchema),
});
export type VoiceDesignModel = z.infer<typeof voiceDesignModelSchema>;
export function matchesVoiceDesignModel(
  model: VoiceDesignModel | null,
  expected: Pick<VoiceDesignModel, "catalog_id" | "config_digest">,
): boolean {
  return (
    model?.catalog_id === expected.catalog_id &&
    model?.config_digest === expected.config_digest
  );
}
const candidateId = {
  candidate_id: z.string().uuid(),
  model: voiceDesignModelSchema.nullable(),
};
export const voiceDesignReadySchema = z.object({
  ...candidateId,
  status: z.literal("ready"),
  description: z.string(),
  preview_text: z.string(),
  language: z.enum(["zh", "en"]),
  preview_url: z
    .string()
    .regex(
      /^\/api\/v1\/projects\/[^/]+\/voice-design\/candidates\/[0-9a-f-]+\/audio$/,
    ),
  mime_type: z.literal("audio/mpeg"),
  duration_seconds: z.number().positive().max(15),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
});
export const voiceDesignCandidateSchema = z.discriminatedUnion("status", [
  z.object({ ...candidateId, status: z.literal("generating") }),
  voiceDesignReadySchema,
  z.object({
    ...candidateId,
    status: z.literal("failed"),
    failure: failureSchema,
  }),
  z.object({
    ...candidateId,
    status: z.literal("unknown"),
    failure: failureSchema,
  }),
  z.object({ ...candidateId, status: z.literal("expired") }),
]);
export const voiceDesignHistorySchema = z.object({
  candidates: z.array(voiceDesignReadySchema).max(5),
});
export const voiceDesignQuoteSchema = z.object({
  model: voiceDesignModelSchema,
  cost: z.number().nonnegative(),
  display: z.string(),
  unit: z.literal("call"),
  quantity: z.literal(1),
});
export type VoiceDesignCandidate = z.infer<typeof voiceDesignCandidateSchema>;
export type VoiceDesignReady = z.infer<typeof voiceDesignReadySchema>;
export interface VoiceDesignCreate {
  request_id: string;
  catalog_id: string;
  config_digest: string;
  surface: VoiceDesignSurface;
  description: string;
  preview_text: string;
  language: "zh";
}
export interface ExpectedVoiceSlot {
  path: string;
  sha256: string;
  updated_at: string;
}
export interface SaveGeneratedVoice {
  candidate_id: string;
  save_request_id: string;
}
export interface SaveGeneratedCharacterVoice extends SaveGeneratedVoice {
  expected_slot: ExpectedVoiceSlot;
  replace_existing: boolean;
}
export interface SaveGeneratedAccountVoice extends SaveGeneratedVoice {
  name: string;
}
export const generatedCharacterVoiceSchema = z.object({
  slot: z.enum(["default", "child", "youth", "middle", "elder"]),
  label: z.string(),
  path: z.string(),
  url: z.string(),
  sha256: z.string(),
  updated_at: z.string(),
  inherited_from_default: z.boolean(),
  required: z.boolean(),
});
