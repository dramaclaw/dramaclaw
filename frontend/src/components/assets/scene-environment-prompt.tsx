// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Scene `environment_prompt` is a single backend string that follows a fixed
 * "360 空间合同" template — seven headings the scene-reference-image generator
 * reads to understand each direction (see SuperTale
 * `cognee/pipeline.py: SCENE_ENRICHMENT_SYSTEM_PROMPT`). The backend has no
 * structured sub-fields, so this module is purely a frontend convenience: it
 * splits that one string into seven editable inputs (parse) and stitches them
 * back into the same labeled string on save (serialize).
 *
 * The serialized labels MUST stay Chinese (正面 / 背面 / …) regardless of UI
 * language — they are the contract the generator parses, not display text.
 * Only the four directional headings are strictly required by the backend
 * (`SCENE_ENVIRONMENT_REQUIRED_HEADINGS`); the rest round-trip best-effort.
 */

export type SceneEnvironmentSectionKey =
  | "front"
  | "left"
  | "right"
  | "back"
  | "light"
  | "material"
  | "forbidden";

interface SceneEnvironmentSection {
  key: SceneEnvironmentSectionKey;
  /** Contract label written into the serialized prompt. Chinese, do not localize. */
  label: string;
  /** i18n key for the input's visible label. */
  i18nKey: string;
}

// label 是写进序列化提示词的契约文字，跟界面语言无关；界面上显示的是 i18nKey。
// i18n-exempt-start
export const SCENE_ENVIRONMENT_SECTIONS: readonly SceneEnvironmentSection[] = [
  { key: "front", label: "正面", i18nKey: "assets.scenes.environment.front" },
  { key: "left", label: "左侧", i18nKey: "assets.scenes.environment.left" },
  { key: "right", label: "右侧", i18nKey: "assets.scenes.environment.right" },
  { key: "back", label: "背面", i18nKey: "assets.scenes.environment.back" },
  { key: "light", label: "光源", i18nKey: "assets.scenes.environment.light" },
  {
    key: "material",
    label: "材质/风格",
    i18nKey: "assets.scenes.environment.material",
  },
  {
    key: "forbidden",
    label: "禁止元素",
    i18nKey: "assets.scenes.environment.forbidden",
  },
] as const;
// i18n-exempt-end

export type SceneEnvironmentSections = Record<SceneEnvironmentSectionKey, string>;

const EMPTY_SECTIONS: SceneEnvironmentSections = {
  front: "",
  left: "",
  right: "",
  back: "",
  light: "",
  material: "",
  forbidden: "",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a labeled `environment_prompt` into its seven sections. A heading is
 * only recognized at the start of a line (`正面：…`), so the keyword appearing
 * mid-sentence won't be mistaken for a section boundary. Legacy / free-form
 * prompts without any heading are kept whole in `front` so nothing is lost.
 */
export function parseEnvironmentPrompt(
  prompt: string | null | undefined,
): SceneEnvironmentSections {
  const result: SceneEnvironmentSections = { ...EMPTY_SECTIONS };
  const text = (prompt ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return result;

  const labels = SCENE_ENVIRONMENT_SECTIONS.map((s) =>
    escapeRegExp(s.label),
  ).join("|");
  const headingRe = new RegExp(`(?:^|\\n)\\s*(${labels})\\s*[:：]`, "g");

  const hits: Array<{
    key: SceneEnvironmentSectionKey;
    labelStart: number;
    contentStart: number;
  }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(text)) !== null) {
    const section = SCENE_ENVIRONMENT_SECTIONS.find((s) => s.label === match![1]);
    if (!section) continue;
    hits.push({
      key: section.key,
      labelStart: match.index,
      contentStart: match.index + match[0].length,
    });
  }

  if (hits.length === 0) {
    result.front = text;
    return result;
  }

  for (let i = 0; i < hits.length; i += 1) {
    const end = i + 1 < hits.length ? hits[i + 1].labelStart : text.length;
    const content = text.slice(hits[i].contentStart, end).trim();
    const { key } = hits[i];
    // A repeated heading appends rather than overwrites — never drop content.
    result[key] = result[key] ? `${result[key]}\n${content}` : content;
  }

  // Anything before the first heading is preserved into the front section.
  const preamble = text.slice(0, hits[0].labelStart).trim();
  if (preamble) {
    result.front = result.front ? `${preamble}\n${result.front}` : preamble;
  }

  return result;
}

/**
 * Stitch the seven sections back into the labeled contract string. Empty
 * sections are omitted; the fullwidth colon matches the backend template.
 */
export function serializeEnvironmentPrompt(
  sections: SceneEnvironmentSections,
): string {
  return SCENE_ENVIRONMENT_SECTIONS.map((s) => ({
    label: s.label,
    value: (sections[s.key] ?? "").trim(),
  }))
    .filter((s) => s.value.length > 0)
    .map((s) => `${s.label}：${s.value}`)
    .join("\n");
}

export function SceneEnvironmentPromptFields({
  sections,
  onChange,
  textareaClassName,
}: {
  sections: SceneEnvironmentSections;
  onChange: (key: SceneEnvironmentSectionKey, value: string) => void;
  textareaClassName?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3">
      {SCENE_ENVIRONMENT_SECTIONS.map((section) => (
        <div key={section.key} className="grid gap-1.5">
          <Label className="text-xs font-normal text-muted-foreground">
            {t(section.i18nKey)}
          </Label>
          <Textarea
            rows={2}
            value={sections[section.key] ?? ""}
            onChange={(event) => onChange(section.key, event.target.value)}
            className={textareaClassName}
          />
        </div>
      ))}
    </div>
  );
}
