export type MidjourneyReferenceMode =
  | "image_prompt"
  | "style_reference"
  | "omni_reference"
  | "edit"
  | "blend";

export interface MidjourneyActionButtonLike {
  custom_id: string;
  label: string;
}

export interface MidjourneyUpscaleCandidate {
  index: 1 | 2 | 3 | 4;
  label: `U${1 | 2 | 3 | 4}`;
  customId: string;
}

export interface MidjourneyTaskLike {
  task_id: string;
  operation: string;
  buttons: MidjourneyActionButtonLike[];
}

export function midjourneyTaskFromResult(
  result: unknown,
): MidjourneyTaskLike | null {
  if (!result || typeof result !== "object") return null;
  const task = (result as Record<string, unknown>).midjourney;
  if (!task || typeof task !== "object") return null;
  const value = task as Record<string, unknown>;
  if (typeof value.task_id !== "string" || typeof value.operation !== "string")
    return null;
  const buttons = Array.isArray(value.buttons)
    ? value.buttons.flatMap((button) => {
        if (!button || typeof button !== "object") return [];
        const item = button as Record<string, unknown>;
        return typeof item.custom_id === "string"
          ? [
              {
                custom_id: item.custom_id,
                label: typeof item.label === "string" ? item.label : "",
              },
            ]
          : [];
      })
    : [];
  return { task_id: value.task_id, operation: value.operation, buttons };
}

export interface MidjourneyUpscaleHistoryRecordLike {
  status: string;
  result?: Record<string, unknown>;
  midjourney_action?: {
    task_id?: string;
    custom_id?: string;
    operation?: string;
  };
}

const REFERENCE_MODES = new Set<MidjourneyReferenceMode>([
  "image_prompt",
  "style_reference",
  "omni_reference",
  "edit",
  "blend",
]);

function upscaleCandidateIndex(
  button: MidjourneyActionButtonLike,
): 1 | 2 | 3 | 4 | null {
  const labelMatch = button.label.trim().match(/^U([1-4])$/i);
  const customIdMatch = button.custom_id.match(
    /upsample(?::|[^0-9])*([1-4])(?:\D|$)/i,
  );
  const value = Number(labelMatch?.[1] ?? customIdMatch?.[1]);
  return value >= 1 && value <= 4 ? (value as 1 | 2 | 3 | 4) : null;
}

export function midjourneyUpscaleCandidates(
  buttons: MidjourneyActionButtonLike[] | undefined,
  supportedOperations: string[] | undefined,
): MidjourneyUpscaleCandidate[] {
  if (!supportedOperations?.includes("upscale")) return [];

  const byIndex = new Map<
    MidjourneyUpscaleCandidate["index"],
    MidjourneyUpscaleCandidate
  >();
  for (const button of buttons ?? []) {
    const index = upscaleCandidateIndex(button);
    if (index === null || byIndex.has(index)) continue;
    byIndex.set(index, {
      index,
      label: `U${index}`,
      customId: button.custom_id,
    });
  }
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

export function hasMidjourneyUpscaleCandidates(
  task: MidjourneyTaskLike | null | undefined,
): boolean {
  return midjourneyUpscaleCandidates(task?.buttons, ["upscale"]).length > 0;
}

export function resolveMidjourneyUpscaleSource<T extends MidjourneyTaskLike>(
  preservedSource: T | null | undefined,
  currentTask: T | null | undefined,
): T | null {
  if (
    preservedSource?.task_id &&
    hasMidjourneyUpscaleCandidates(preservedSource)
  ) {
    return preservedSource;
  }
  if (currentTask?.task_id && hasMidjourneyUpscaleCandidates(currentTask)) {
    return currentTask;
  }
  return null;
}

function historyImageUrl(
  result: Record<string, unknown> | undefined,
): string | null {
  for (const key of ["output_url", "image_url", "url"]) {
    const value = result?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function midjourneyUpscaleResultsFromHistory(
  records: MidjourneyUpscaleHistoryRecordLike[],
  sourceTaskId: string | null | undefined,
): Record<string, string> {
  if (!sourceTaskId) return {};
  const results: Record<string, string> = {};
  for (const record of records) {
    const action = record.midjourney_action;
    if (
      !["completed", "succeeded"].includes(record.status) ||
      action?.operation !== "upscale" ||
      action.task_id !== sourceTaskId ||
      !action.custom_id ||
      results[action.custom_id]
    ) {
      continue;
    }
    const url = historyImageUrl(record.result);
    if (url) results[action.custom_id] = url;
  }
  return results;
}

export function cachedMidjourneyUpscaleUrl(
  results: Record<string, string> | null | undefined,
  customId: string,
): string | null {
  const url = results?.[customId];
  return typeof url === "string" && url.length > 0 ? url : null;
}

export function availableMidjourneyReferenceModes(
  supportedOperations: string[] | undefined,
  configuredModes?: Array<string | number | boolean>,
  referenceCount?: number,
): MidjourneyReferenceMode[] {
  const supported = new Set(supportedOperations ?? ["imagine"]);
  const requested = configuredModes?.length
    ? configuredModes
        .map((value) => String(value).trim().toLowerCase())
        .filter((value): value is MidjourneyReferenceMode =>
          REFERENCE_MODES.has(value as MidjourneyReferenceMode),
        )
    : (["image_prompt", "edit", "blend"] as MidjourneyReferenceMode[]);
  return requested.filter((mode, index) => {
    if (requested.indexOf(mode) !== index) return false;
    if (referenceCount !== undefined) {
      if (referenceCount === 0) return false;
      if (mode === "blend" && referenceCount < 2) return false;
      if (mode === "omni_reference" && referenceCount !== 1) return false;
    }
    return supported.has(
      mode === "edit" || mode === "blend" ? mode : "imagine",
    );
  });
}

export function resolveMidjourneyReferenceMode(
  value: unknown,
  supportedOperations: string[] | undefined,
  configuredModes?: Array<string | number | boolean>,
  referenceCount?: number,
): MidjourneyReferenceMode {
  const available = availableMidjourneyReferenceModes(
    supportedOperations,
    configuredModes,
    referenceCount,
  );
  const requested = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (REFERENCE_MODES.has(requested as MidjourneyReferenceMode)) {
    const mode = requested as MidjourneyReferenceMode;
    if (available.includes(mode)) return mode;
  }
  return available[0] ?? "image_prompt";
}

export function midjourneyBillingOperation(
  adapter: string | null | undefined,
  referenceMode: unknown,
): "imagine" | "edit" | "blend" | null {
  if (adapter !== "relayclaw_midjourney") return null;
  const mode =
    typeof referenceMode === "string" ? referenceMode.trim().toLowerCase() : "";
  return mode === "edit" || mode === "blend" ? mode : "imagine";
}

export function midjourneyImageOperationError(
  operation: MidjourneyReferenceMode,
  referenceCount: number,
  hasPrompt: boolean,
): "prompt_required" | "edit_image_required" | "blend_images_required" | null {
  if (operation === "blend") {
    return referenceCount >= 2 ? null : "blend_images_required";
  }
  if (!hasPrompt) return "prompt_required";
  if (operation === "edit" && referenceCount < 1) return "edit_image_required";
  return null;
}
