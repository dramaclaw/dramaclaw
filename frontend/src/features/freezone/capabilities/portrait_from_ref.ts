// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { GenerationCapability } from "./capabilityRegistry";
import { stringifyParamValue } from "./capabilityRegistry";

const P = "canvas.capabilities.portrait_from_ref";
const M = "canvas.capabilities.character_multi_view_candidate";

export const portraitFromRefCapability: GenerationCapability = {
  id: "portrait_from_ref",
  nameKey: `${P}.name`,
  shortNameKey: `${P}.shortName`,
  category: "character",
  descriptionKey: `${P}.description`,
  outputKind: "identity",
  model: "openai/gpt-image-2",
  aspectRatio: "3:4",
  imageSize: "2K",
  inputs: [
    {
      key: "ref_image",
      labelKey: `${P}.inputs.ref_image.label`,
      required: true,
      acceptKinds: ["generic", "identity", "portrait", "render", "sketch"],
      descriptionKey: `${P}.inputs.ref_image.description`,
    },
    {
      key: "identity_ref",
      labelKey: `${P}.inputs.identity_ref.label`,
      required: false,
      acceptKinds: ["identity", "portrait"],
      descriptionKey: `${P}.inputs.identity_ref.description`,
    },
  ],
  params: [
    {
      key: "character",
      labelKey: `${P}.params.character.label`,
      type: "text",
      defaultValue: "",
      descriptionKey: `${P}.params.character.description`,
    },
    {
      key: "age_band",
      labelKey: `${P}.params.age_band.label`,
      type: "enum",
      defaultValue: "middle",
      options: [
        { value: "young", labelKey: `${P}.params.age_band.options.young` },
        { value: "middle", labelKey: `${P}.params.age_band.options.middle` },
        { value: "old", labelKey: `${P}.params.age_band.options.old` },
      ],
    },
    {
      key: "portrait_style",
      labelKey: `${P}.params.portrait_style.label`,
      type: "enum",
      defaultValue: "clean_production_portrait",
      options: [
        { value: "clean_production_portrait", labelKey: `${P}.params.portrait_style.options.clean_production_portrait` },
        { value: "cinematic_identity", labelKey: `${P}.params.portrait_style.options.cinematic_identity` },
        { value: "character_reference_sheet", labelKey: `${P}.params.portrait_style.options.character_reference_sheet` },
      ],
    },
    {
      key: "preserve",
      labelKey: `${P}.params.preserve.label`,
      type: "multiselect",
      defaultValue: ["face", "hair", "temperament"],
      options: [
        { value: "face", labelKey: `${P}.params.preserve.options.face` },
        { value: "hair", labelKey: `${P}.params.preserve.options.hair` },
        { value: "temperament", labelKey: `${P}.params.preserve.options.temperament` },
        { value: "outfit", labelKey: `${P}.params.preserve.options.outfit` },
      ],
    },
    {
      key: "outfit",
      labelKey: `${P}.params.outfit.label`,
      type: "text",
      defaultValue: "",
    },
    {
      key: "notes",
      labelKey: `${P}.params.notes.label`,
      type: "text",
      defaultValue: "",
    },
  ],
  compose({ inputUrls, params, nodePrompt }) {
    const character = stringifyParamValue(params.character) || "the target character";
    const ageBand = stringifyParamValue(params.age_band) || "middle";
    const style = stringifyParamValue(params.portrait_style) || "clean_production_portrait";
    const preserve = stringifyParamValue(params.preserve) || "face / temperament";
    const outfit = stringifyParamValue(params.outfit);
    const notes = stringifyParamValue(params.notes);

    const prompt = `Create a SuperTale character identity portrait candidate for ${character}.

Character phase:
- Age band: ${ageBand}.
- Asset style: ${style}.
- Preserve from references: ${preserve}.
${outfit ? `- Outfit direction: ${outfit}.` : ""}
${notes ? `- Extra requirements: ${notes}.` : ""}
${nodePrompt ? `\nNode note:\n${nodePrompt}` : ""}

Output requirements:
- Single clear character portrait, 3:4 aspect ratio.
- Keep face identity coherent and production-ready.
- No text, watermark, UI frame, or contact sheet.
- Clean background or simple cinematic background; do not create a busy scene.`;

    return {
      prompt,
      referenceUrls: inputUrls,
      model: "openai/gpt-image-2",
      aspectRatio: "3:4",
      imageSize: "2K",
      quality: "medium",
      outputKind: "identity",
    };
  },
};

export const characterMultiViewCapability: GenerationCapability = {
  id: "character_multi_view_candidate",
  nameKey: `${M}.name`,
  shortNameKey: `${M}.shortName`,
  category: "character",
  descriptionKey: `${M}.description`,
  outputKind: "identity",
  model: "openai/gpt-image-2",
  aspectRatio: "16:9",
  imageSize: "2K",
  inputs: [
    {
      key: "character_ref",
      labelKey: `${M}.inputs.character_ref.label`,
      required: true,
      acceptKinds: ["generic", "identity", "portrait", "render", "sketch"],
      descriptionKey: `${M}.inputs.character_ref.description`,
    },
    {
      key: "style_ref",
      labelKey: `${M}.inputs.style_ref.label`,
      required: false,
      acceptKinds: ["generic", "identity", "portrait", "render", "sketch"],
      descriptionKey: `${M}.inputs.style_ref.description`,
    },
  ],
  params: [
    {
      key: "character",
      labelKey: `${M}.params.character.label`,
      type: "text",
      defaultValue: "",
      descriptionKey: `${M}.params.character.description`,
    },
    {
      key: "layout",
      labelKey: `${M}.params.layout.label`,
      type: "enum",
      defaultValue: "four_view",
      options: [
        { value: "three_view", labelKey: `${M}.params.layout.options.three_view` },
        { value: "four_view", labelKey: `${M}.params.layout.options.four_view` },
        { value: "nine_grid", labelKey: `${M}.params.layout.options.nine_grid` },
      ],
    },
    {
      key: "view_focus",
      labelKey: `${M}.params.view_focus.label`,
      type: "multiselect",
      defaultValue: ["front", "side", "back", "expression"],
      options: [
        { value: "front", labelKey: `${M}.params.view_focus.options.front` },
        { value: "side", labelKey: `${M}.params.view_focus.options.side` },
        { value: "back", labelKey: `${M}.params.view_focus.options.back` },
        { value: "expression", labelKey: `${M}.params.view_focus.options.expression` },
        { value: "pose", labelKey: `${M}.params.view_focus.options.pose` },
        { value: "outfit", labelKey: `${M}.params.view_focus.options.outfit` },
      ],
    },
    {
      key: "notes",
      labelKey: `${M}.params.notes.label`,
      type: "text",
      defaultValue: "",
    },
  ],
  compose({ inputUrls, params, nodePrompt }) {
    const character = stringifyParamValue(params.character) || "the target character";
    const layout = stringifyParamValue(params.layout) || "four_view";
    const viewFocus = stringifyParamValue(params.view_focus) || "front / side / back / expression";
    const notes = stringifyParamValue(params.notes);

    const layoutText =
      layout === "three_view"
        ? "a clean 3-view character reference sheet: front, side, back"
        : layout === "nine_grid"
          ? "a 3x3 character reference grid with consistent identity across expressions and poses"
          : "a clean 4-view character reference sheet: front, side, back, and expression/detail view";

    const prompt = `Create ${layoutText} for ${character}.

View focus: ${viewFocus}.
${notes ? `Extra requirements: ${notes}.` : ""}
${nodePrompt ? `\nNode note:\n${nodePrompt}` : ""}

Output requirements:
- Keep the same face identity, age, hairstyle, body proportion, outfit palette, and production style across all cells.
- Use a clean, readable contact-sheet layout suitable for SuperTale character assets.
- No text labels, watermark, UI frame, or unrelated background scene.
- If references conflict, prioritize the first reference image as identity source.`;

    return {
      prompt,
      referenceUrls: inputUrls,
      model: "openai/gpt-image-2",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "medium",
      outputKind: "identity",
    };
  },
};
