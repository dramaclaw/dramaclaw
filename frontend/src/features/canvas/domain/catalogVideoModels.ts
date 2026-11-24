// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { WORKFLOW_STABLE_CONTRACT } from "@/features/freezone/generated/workflowContract";
import type { ModelOption } from "@/features/canvas/domain/modelOptions";

const videoAliases: Readonly<Record<string, string>> =
  WORKFLOW_STABLE_CONTRACT.model_aliases_by_node_type.videoNode;

// These IDs can still be saved in a canvas or in the user's last-used preference.
// A retired choice must not silently submit a different, potentially billable model.
const retiredSelections = new Set([
  "seedance-1.0-pro", "seedance-1.0-pro-fast", "seedance-1.5-pro",
  "seedance_fast", "seedance_pro", "seedance_pro_silent",
  "huimeng_seedance10_fast", "huimeng_seedance15_pro",
]);

export function isRetiredVideoSelection(id: string): boolean {
  const key = id.trim().toLowerCase();
  return retiredSelections.has(key) ||
    retiredSelections.has((videoAliases[key] ?? key).replace(/^(?:newapi|huimeng|huimengi)[_/]/, ""));
}

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
  if (isRetiredVideoSelection(requested)) return undefined;
  if (!canonical) return models[0];
  const matches = models.filter((model) =>
    videoAliases[model.id] === canonical ||
    model.apiModel === canonical ||
    videoAliases[model.apiModel] === canonical,
  );
  // A model name cannot choose between multiple configured provider routes.
  return matches.length > 1 ? undefined : matches[0] ?? models[0];
}
