// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { WORKFLOW_STABLE_CONTRACT } from "@/features/freezone/generated/workflowContract";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";

const videoAliases: Readonly<Record<string, string>> =
  WORKFLOW_STABLE_CONTRACT.model_aliases_by_node_type.videoNode;

/** Preserve catalog identity first; resolve legacy workflow aliases only when unambiguous. */
export function selectVideoModel(
  models: readonly ModelOption[],
  persistedModel: unknown,
): ModelOption | undefined {
  const requested = typeof persistedModel === "string" ? persistedModel.trim() : "";
  if (!requested) return models[0];

  const exact = models.find((model) => model.id === requested || model.catalogId === requested);
  if (exact) return exact;

  const canonical = videoAliases[requested];
  if (!canonical) return models[0];
  const matches = models.filter((model) =>
    videoAliases[model.id] === canonical ||
    model.apiModel === canonical ||
    videoAliases[model.apiModel] === canonical,
  );
  // A model name cannot choose between multiple configured provider routes.
  return matches.length > 1 ? undefined : matches[0] ?? models[0];
}
