// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// AiGateway implementation that talks to SuperTale's `/api/v1/projects/<project_id>/freezone/*`
// endpoints.
//
// Protocol mapping:
//   - 0 references            → POST /freezone/gen   (text → image)
//   - 1+ references           → POST /freezone/edit  (1st = base, rest = extra)
//   - submit returns task_key → poll project-scoped task SSE for completion
//   - on completion → fetch /freezone/jobs/<type>/<id>/result for the URL
//
// Provider/model routing (v1.1):
//   - upstream node payload's `model` field is split on '/' → (provider, model)
//     e.g. "openai/gpt-image-2" → provider="openai", model="gpt-image-2"
//   - if no '/' → entire string treated as model, provider left as null
//     (backend falls back to NANOBANANA_PROVIDER env)
//   - extraParams.quality is forwarded for openai gpt-image-2

import {
  fetchFreezoneJobResult,
  submitFreezoneEdit,
  submitFreezoneGen,
  type FreezoneProvider,
  type FreezoneJobRef,
} from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";
import { readUrl } from "@/lib/url-params";
import {
  mergeShotMetadata,
  parseInlineShotBlock,
  renderShotMetadataForPrompt,
  useShotMetadataStore,
} from "@/features/freezone/shotMetadataStore";
import {
  parseReferenceRoles,
  renderReferenceRolesForPrompt,
  reorderReferencesByRole,
} from "@/features/freezone/referenceRoles";
import { composeCapability } from "@/features/freezone/capabilities/capabilityRegistry";
import { getFreezoneCanvasMetadata } from "@/features/freezone/canvasMetadataContext";
import type {
  AiGateway,
  GenerateImagePayload,
} from "../application/ports";

interface ProviderModel {
  provider: FreezoneProvider | null;
  model: string | null;
}

/** Split frontend model strings into SuperTale's provider/model pair. */
const PLACEHOLDER_MODEL_TOKENS = new Set(["default", "auto", ""]);
const SUPPORTED_PROVIDERS = new Set<FreezoneProvider>([
  "huimeng",
  "openai",
  "openrouter",
]);

function splitProviderModel(input: string | undefined | null): ProviderModel {
  if (!input) return { provider: null, model: null };
  const idx = input.indexOf("/");
  if (idx <= 0) {
    return { provider: null, model: input };
  }
  const providerToken = input.slice(0, idx);
  const provider = SUPPORTED_PROVIDERS.has(providerToken as FreezoneProvider)
    ? (providerToken as FreezoneProvider)
    : null;
  const rawModel = input.slice(idx + 1);
  // SuperTale-specific model files use placeholder tokens like
  // "openrouter/default" or "huimeng/default" so the backend can fall back
  // to NANOBANANA_MODEL env. Strip those so we don't ship a bogus model name.
  const model = PLACEHOLDER_MODEL_TOKENS.has(rawModel.toLowerCase())
    ? null
    : rawModel;
  return { provider, model };
}

function readQuality(payload: GenerateImagePayload): string | null {
  const q = payload.extraParams?.quality;
  return typeof q === "string" ? q : null;
}

interface JobRecord {
  ref: FreezoneJobRef;
  projectId: string;
  promise: Promise<string>;
  status: "queued" | "running" | "succeeded" | "failed";
  result?: string;
  error?: string;
}

const jobs = new Map<string, JobRecord>();

function currentProjectId(): string {
  const p = readUrl().project;
  if (!p) {
    throw new Error("No project selected — open Freezone with ?p=<project_id>");
  }
  return p;
}

/** Active canvas id for per-node history; mirrors App.tsx's URL default. */
function currentCanvasId(): string {
  return readUrl().canvas ?? "default";
}

/** SuperTale's API uses "1:1" / "16:9" etc — pass through. */
function toAspectRatio(payload: GenerateImagePayload): string {
  return payload.aspectRatio || "1:1";
}

/** Normalize the frontend image-size enum (e.g. "1K") to SuperTale's
 * `image_size` field. We accept anything; backend currently uses "0.5K"/"1K"/"2K"/"4K". */
function toImageSize(payload: GenerateImagePayload): string {
  const raw = (payload.size || "2K").toString();
  return raw;
}

async function submitJob(
  payload: GenerateImagePayload,
): Promise<{ ref: FreezoneJobRef; projectId: string }> {
  const projectId = currentProjectId();
  const capabilityJob = payload.capabilityId
    ? composeCapability(payload.capabilityId, {
      inputUrls: payload.referenceImages ?? [],
      params: payload.capabilityParams ?? {},
      nodePrompt: payload.prompt,
      metadata: getFreezoneCanvasMetadata(),
    })
    : null;
  const effectivePrompt = capabilityJob?.prompt ?? payload.prompt;
  const effectiveRefs = capabilityJob?.referenceUrls ?? payload.referenceImages ?? [];
  // User selection from the bottom-left model/provider switcher wins over the
  // capability's hard-coded default — capabilities only provide the fallback
  // model so the node can run before the user picks anything.
  const effectiveModel = payload.model ?? capabilityJob?.model;
  const effectiveSize = payload.size ?? capabilityJob?.imageSize;
  const effectiveAspectRatio = payload.aspectRatio ?? capabilityJob?.aspectRatio;
  const { provider, model } = splitProviderModel(effectiveModel);
  const quality = readQuality(payload) ?? capabilityJob?.quality;

  // Shot metadata composition (v1.6η):
  //   1. Parse any inline `[shot]...[/shot]` block from the user's prompt — this
  //      is the per-node override.
  //   2. Merge with canvas-level shot metadata (per-node wins on conflict).
  //   3. Strip the inline block from the prompt body, then append rendered
  //      metadata so the model sees a single uniform "[镜头参数]" block.
  const { cleaned: afterShotClean, override: nodeShot } = parseInlineShotBlock(
    effectivePrompt,
  );
  const merged = mergeShotMetadata(
    useShotMetadataStore.getState().shot,
    nodeShot,
  );
  const shotSuffix = renderShotMetadataForPrompt(merged);

  // Reference roles (v1.6ζ):
  //   1. Parse any `[ref:N=role]` markers from the prompt (after shot block).
  //   2. Reorder references so character > pose > style > generic.
  //   3. Append a "reference roles" legend so the model uses each ref correctly.
  const { roles, cleaned: cleanedPrompt } = parseReferenceRoles(afterShotClean);
  const rawRefs = effectiveRefs.filter(Boolean);
  const { reordered: refs, rolesAfter } = reorderReferencesByRole(rawRefs, roles);
  const roleSuffix = renderReferenceRolesForPrompt(rolesAfter, refs.length);

  const finalPrompt = `${cleanedPrompt}${shotSuffix}${roleSuffix}`;

  const canvasId = currentCanvasId();
  if (refs.length === 0) {
    const ref = await submitFreezoneGen(projectId, {
      prompt: finalPrompt,
      aspectRatio: effectiveAspectRatio || toAspectRatio(payload),
      imageSize: effectiveSize || toImageSize(payload),
      referenceUrls: [],
      provider,
      model,
      modelId: payload.modelId,
      genMode: payload.generationMode,
      quality,
      canvasId,
      nodeId: payload.nodeId,
    });
    return { ref, projectId };
  }
  const [base, ...extras] = refs;
  const ref = await submitFreezoneEdit(projectId, {
    prompt: finalPrompt,
    baseUrl: base,
    extraReferenceUrls: extras,
    aspectRatio: effectiveAspectRatio || toAspectRatio(payload),
    imageSize: effectiveSize || toImageSize(payload),
    provider,
    model,
    modelId: payload.modelId,
    genMode: payload.generationMode,
    quality,
    canvasId,
    nodeId: payload.nodeId,
  });
  return { ref, projectId };
}

async function awaitJobAndFetchUrl(
  ref: FreezoneJobRef,
  projectId: string,
): Promise<string> {
  const completed = await awaitTaskCompletion(ref.task_key, projectId);
  // Backend writes the output URL into the result payload directly.
  const directUrl = (completed.result?.["output_url"] as string | undefined) || undefined;
  if (directUrl) return directUrl;
  const fallback = await fetchFreezoneJobResult(projectId, ref.task_type, ref.job_id);
  return fallback.url;
}

export const freezoneAiGateway: AiGateway = {
  async setApiKey() {
    // Cookie auth is shared with NiceGUI / supertale-fe; nothing to do.
  },

  async generateImage(payload) {
    const { ref, projectId } = await submitJob(payload);
    const url = await awaitJobAndFetchUrl(ref, projectId);
    return url;
  },

  async submitGenerateImageJob(payload) {
    const { ref, projectId } = await submitJob(payload);
    const promise = awaitJobAndFetchUrl(ref, projectId)
      .then((url) => {
        const rec = jobs.get(ref.job_id);
        if (rec) {
          rec.status = "succeeded";
          rec.result = url;
        }
        return url;
      })
      .catch((err: Error) => {
        const rec = jobs.get(ref.job_id);
        if (rec) {
          rec.status = "failed";
          rec.error = err.message;
        }
        throw err;
      });
    jobs.set(ref.job_id, { ref, projectId, promise, status: "running" });
    return ref.job_id;
  },

  async getGenerateImageJob(jobId) {
    const rec = jobs.get(jobId);
    if (!rec) {
      return { job_id: jobId, status: "not_found" };
    }
    if (rec.status === "succeeded") {
      return { job_id: jobId, status: "succeeded", result: rec.result };
    }
    if (rec.status === "failed") {
      return { job_id: jobId, status: "failed", error: rec.error };
    }
    return { job_id: jobId, status: rec.status };
  },
};
