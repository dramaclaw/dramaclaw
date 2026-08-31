// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CapabilityInputDefinition, GenerationCapability } from "./capabilityRegistry";
import { stringifyParamValue } from "./capabilityRegistry";

const C = "canvas.capabilities.common";
const K = "canvas.capabilities";

function commonRefs(): CapabilityInputDefinition[] {
  return [
    {
      key: "base_ref",
      labelKey: `${C}.inputs.base_ref.label`,
      required: false,
      acceptKinds: ["generic", "scene", "identity", "portrait", "prop", "sketch", "render"],
      descriptionKey: `${C}.inputs.base_ref.description`,
    },
    {
      key: "extra_refs",
      labelKey: `${C}.inputs.extra_refs.label`,
      required: false,
      acceptKinds: ["generic", "scene", "identity", "portrait", "prop", "sketch", "render"],
    },
  ];
}

const STYLE_PARAM = {
  key: "style",
  labelKey: `${C}.params.style.label`,
  type: "enum" as const,
  defaultValue: "supertale_production",
  options: [
    { value: "supertale_production", labelKey: `${C}.params.style.options.supertale_production` },
    { value: "cinematic_realistic", labelKey: `${C}.params.style.options.cinematic_realistic` },
    { value: "clean_sketch", labelKey: `${C}.params.style.options.clean_sketch` },
    { value: "spiderverse_mixed", labelKey: `${C}.params.style.options.spiderverse_mixed` },
  ],
};

const NOTES_PARAM = {
  key: "notes",
  labelKey: `${C}.params.notes.label`,
  type: "text" as const,
  defaultValue: "",
};

function suffix(params: Record<string, unknown>, nodePrompt?: string): string {
  const style = stringifyParamValue(params.style) || "supertale_production";
  const notes = stringifyParamValue(params.notes);
  return `

Style: ${style}.
${notes ? `Extra notes: ${notes}.` : ""}
${nodePrompt ? `Node note:\n${nodePrompt}` : ""}

Hard requirements:
- Production-ready SuperTale asset candidate.
- No text, watermark, UI frame, contact sheet, or collage unless explicitly requested.
- Preserve useful identity / scene / prop cues from references.`;
}

export const sceneMasterCandidateCapability: GenerationCapability = {
  id: "scene_master_candidate",
  nameKey: `${K}.scene_master_candidate.name`,
  shortNameKey: `${K}.scene_master_candidate.shortName`,
  category: "scene",
  descriptionKey: `${K}.scene_master_candidate.description`,
  outputKind: "scene_master",
  model: "openai/gpt-image-2",
  aspectRatio: "16:9",
  imageSize: "2K",
  inputs: commonRefs(),
  params: [
    { key: "scene_id", labelKey: `${C}.params.scene_id.label`, type: "text", defaultValue: "" },
    STYLE_PARAM,
    NOTES_PARAM,
  ],
  compose({ inputUrls, params, nodePrompt }) {
    const sceneId = stringifyParamValue(params.scene_id) || "the target scene";
    return {
      prompt: `Create a canonical scene master image candidate for ${sceneId}.

Represent the stable layout, mood, key architectural features, materials, and color palette of the scene.${suffix(params, nodePrompt)}`,
      referenceUrls: inputUrls,
      model: "openai/gpt-image-2",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "medium",
      outputKind: "scene_master",
    };
  },
};

export const scene360CandidateCapability: GenerationCapability = {
  id: "scene_360_candidate",
  nameKey: `${K}.scene_360_candidate.name`,
  shortNameKey: `${K}.scene_360_candidate.shortName`,
  category: "scene",
  descriptionKey: `${K}.scene_360_candidate.description`,
  outputKind: "scene_director_pano_360",
  model: "openai/gpt-image-2",
  aspectRatio: "2:1",
  imageSize: "4K",
  inputs: commonRefs(),
  params: [
    { key: "scene_id", labelKey: `${C}.params.scene_id.label`, type: "text", defaultValue: "" },
    STYLE_PARAM,
    NOTES_PARAM,
  ],
  compose({ inputUrls, params, nodePrompt }) {
    const sceneId = stringifyParamValue(params.scene_id) || "the target scene";
    return {
      prompt: `Create a 2:1 equirectangular 360 panorama candidate for ${sceneId}.

The panorama must be horizontally seamless and suitable as a 3GS / director-world environment reference.${suffix(params, nodePrompt)}`,
      referenceUrls: inputUrls,
      model: "openai/gpt-image-2",
      aspectRatio: "2:1",
      imageSize: "4K",
      quality: "medium",
      outputKind: "scene_director_pano_360",
    };
  },
};

export const propRefCandidateCapability: GenerationCapability = {
  id: "prop_ref_candidate",
  nameKey: `${K}.prop_ref_candidate.name`,
  shortNameKey: `${K}.prop_ref_candidate.shortName`,
  category: "utility",
  descriptionKey: `${K}.prop_ref_candidate.description`,
  outputKind: "prop_ref",
  model: "openai/gpt-image-2",
  aspectRatio: "16:9",
  imageSize: "2K",
  inputs: commonRefs(),
  params: [
    { key: "prop_id", labelKey: `${C}.params.prop_id.label`, type: "text", defaultValue: "" },
    STYLE_PARAM,
    NOTES_PARAM,
  ],
  compose({ inputUrls, params, nodePrompt }) {
    const propId = stringifyParamValue(params.prop_id) || "the target prop";
    return {
      prompt: `Create a clean prop reference candidate for ${propId}.

Show the prop clearly with stable design, color, material, scale cues, and if useful a simple 3-view layout.${suffix(params, nodePrompt)}`,
      referenceUrls: inputUrls,
      model: "openai/gpt-image-2",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "medium",
      outputKind: "prop_ref",
    };
  },
};

export const renderRepairCandidateCapability: GenerationCapability = {
  id: "render_repair_candidate",
  nameKey: `${K}.render_repair_candidate.name`,
  shortNameKey: `${K}.render_repair_candidate.shortName`,
  category: "beat",
  descriptionKey: `${K}.render_repair_candidate.description`,
  outputKind: "director_render",
  model: "openai/gpt-image-2",
  aspectRatio: "16:9",
  imageSize: "2K",
  inputs: commonRefs(),
  params: [
    STYLE_PARAM,
    { key: "repair_focus", labelKey: `${K}.render_repair_candidate.params.repair_focus.label`, type: "text", defaultValue: "fix artifacts, faces, hands, props, background consistency" },
    NOTES_PARAM,
  ],
  compose({ inputUrls, params, nodePrompt }) {
    const focus = stringifyParamValue(params.repair_focus);
    return {
      prompt: `Repair the current beat render candidate.

Focus: ${focus || "fix visual artifacts while preserving composition"}.${suffix(params, nodePrompt)}`,
      referenceUrls: inputUrls,
      model: "openai/gpt-image-2",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "medium",
      outputKind: "director_render",
    };
  },
};

export const startFrameCandidateCapability: GenerationCapability = {
  id: "video_start_frame_candidate",
  nameKey: `${K}.video_start_frame_candidate.name`,
  shortNameKey: `${K}.video_start_frame_candidate.shortName`,
  category: "video",
  descriptionKey: `${K}.video_start_frame_candidate.description`,
  outputKind: "frame",
  model: "openai/gpt-image-2",
  aspectRatio: "16:9",
  imageSize: "2K",
  inputs: commonRefs(),
  params: [
    STYLE_PARAM,
    { key: "motion_setup", labelKey: `${K}.video_start_frame_candidate.params.motion_setup.label`, type: "text", defaultValue: "" },
    NOTES_PARAM,
  ],
  compose({ inputUrls, params, nodePrompt }) {
    const motion = stringifyParamValue(params.motion_setup);
    return {
      prompt: `Create a clean video start-frame candidate for the current beat.

${motion ? `Motion setup to imply: ${motion}.` : "Preserve the beat composition and make it suitable for video generation."}${suffix(params, nodePrompt)}`,
      referenceUrls: inputUrls,
      model: "openai/gpt-image-2",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "medium",
      outputKind: "frame",
    };
  },
};
