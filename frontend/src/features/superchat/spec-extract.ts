// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { Spec as SpecRenderSpec } from "dramaclaw-spec-render";
import type { ChatMessage } from "@/features/superchat/types";
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from "i18next";


function uiSpecTagRegex(): RegExp {
  return /<ui-spec\b[^>]*>([\s\S]*?)<\/ui-spec>/gi;
}

function parseUiSpecTagBody(body: string): { specs: UiSpec[]; value: unknown | null } {
  const nestedSpecs = parseSpecsFromText(body);
  if (nestedSpecs.length > 0) {
    return { specs: nestedSpecs, value: null };
  }

  const value = safeJsonParse(body.trim());
  if (Array.isArray(value)) {
    const specs = value
      .map((item) => coerceUiSpec(item))
      .filter((item): item is UiSpec => Boolean(item));
    if (specs.length === value.length && specs.length > 0) {
      return { specs, value: null };
    }
  }
  const spec = coerceUiSpec(value);
  if (spec) return { specs: [spec], value: null };
  return { specs: [], value };
}

function extractUiSpecTagBlocks(
  text: string,
  onSpec: (spec: UiSpec) => void,
  onJson: (value: unknown) => void,
): string {
  return text.replace(uiSpecTagRegex(), (match, body: string) => {
    const nestedStart = match.toLowerCase().lastIndexOf("<ui-spec");
    const parsed = nestedStart > 0
      ? parseUiSpecTagBody(match.slice(nestedStart))
      : parseUiSpecTagBody(body);

    for (const spec of parsed.specs) {
      onSpec(spec);
    }
    if (parsed.value !== null) {
      onJson(parsed.value);
    }
    return "";
  });
}

export type StructuredBlock = {
  id: string;
  label: string;
  value: unknown;
};

export type UiSpec = SpecRenderSpec & {
  root: string;
  elements: Record<string, unknown>;
};

export function isUiSpec(value: unknown): value is UiSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as Record<string, unknown>;
  return (
    typeof spec.root === "string"
    && spec.elements !== null
    && typeof spec.elements === "object"
    && !Array.isArray(spec.elements)
    && (spec.type === undefined || typeof spec.type === "string")
  );
}

export function hasStructuredContent(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const value = message as Record<string, unknown>;
  if (coerceUiSpec(value)) return true;
  if (value.type === "ui_spec" && coerceUiSpec(value.spec)) return true;

  const content = value.content;
  if (!Array.isArray(content)) {
    return typeof content === "string" && parseSpecsFromText(content).length > 0;
  }

  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const item = block as Record<string, unknown>;
    if (item.type === "ui_spec" && coerceUiSpec(item.spec)) return true;
    return ["text", "content", "result", "output"].some((key) => {
      const text = item[key];
      return typeof text === "string" && parseSpecsFromText(text).length > 0;
    });
  });
}

export function looksLikeStructuredRenderText(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  return (
    /<ui-spec\b/i.test(trimmed)
    || /json[-_]?render/i.test(trimmed)
    || /```(?:json|json-render|ui-spec|spec)\b/i.test(trimmed)
    || /```\s*(?:j|js|jso|json|json-|json-r|json-re|json-ren|json-rend|json-rende)/i.test(trimmed)
    || /^```\s*[\[{]/i.test(trimmed)
    || /^[\[{]/.test(trimmed)
  );
}

export function extractStructuredBlocks(message: Pick<ChatMessage, "text" | "raw">): {
  displayText: string;
  blocks: StructuredBlock[];
} {
  const blocks: StructuredBlock[] = [];
  const seenSpecs = new Set<string>();

  for (const spec of extractSpecsFromRaw(message.raw)) {
    addBlock(blocks, seenSpecs, "ui-spec", spec);
  }

  let displayText = message.text;
  displayText = extractUiSpecTagBlocks(
    displayText,
    (spec) => addBlock(blocks, seenSpecs, "ui-spec", spec),
    (value) => blocks.push({ id: `json-${blocks.length}`, label: "json", value }),
  );

  displayText = displayText.replace(/```(?:json-render|ui-spec|json|spec)?\s*([\s\S]*?)```/gi, (match, body: string) => {
    if (!body.trim()) return "";

    const taggedSpecs = parseSpecsFromText(body);
    if (taggedSpecs.length > 0) {
      for (const spec of taggedSpecs) {
        addBlock(blocks, seenSpecs, "ui-spec", spec);
      }
      return "";
    }

    const value = safeJsonParse(body.trim());
    if (value === null) return match;
    const spec = coerceUiSpec(value);
    if (spec) {
      addBlock(blocks, seenSpecs, "ui-spec", spec);
    } else {
      blocks.push({ id: `json-${blocks.length}`, label: "json", value });
    }
    return "";
  });

  const trimmed = displayText.trim();
  if (blocks.length === 0 && /^[{[]/.test(trimmed)) {
    const value = safeJsonParse(trimmed);
    if (value !== null) {
      const spec = coerceUiSpec(value);
      if (spec) {
        addBlock(blocks, seenSpecs, "ui-spec", spec);
      } else {
        blocks.push({ id: "json-root", label: "json", value });
      }
      displayText = "";
    }
  }

  return { displayText: displayText.trim(), blocks };
}

function safeJsonParse(input: string): unknown | null {
  const trimmed = input.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const repaired = repairTrailingJsonClosers(trimmed);
    if (!repaired || repaired === trimmed) return null;
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

function repairTrailingJsonClosers(input: string): string | null {
  if (!input || !/^[{[]/.test(input)) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of input) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (expected !== char) return null;
    }
  }

  if (inString || stack.length === 0 || stack.length > 3) return null;
  return input + stack.reverse().join("");
}

function coerceUiSpec(value: unknown): UiSpec | null {
  if (isUiSpec(value)) return normalizeUiSpec(value);
  return coerceLooseCharacterShowcase(value) ?? coerceLooseKeyframeVideo(value);
}

function normalizeUiSpec(spec: UiSpec): UiSpec {
  return normalizeCharacterShowcaseSpec(normalizeLegacyComponentProps(spec));
}

function normalizeLegacyComponentProps(spec: UiSpec): UiSpec {
  const elements = Object.fromEntries(
    Object.entries(spec.elements).map(([id, element]) => {
      if (!isRecord(element)) return [id, element];
      const type = stringValue(element.type);
      const props = isRecord(element.props) ? { ...element.props } : {};
      const legacyText = stringValue(props.children);

      if (legacyText) {
        if ((type === "Text" || type === "Heading") && stringValue(props.content) === "") {
          props.content = legacyText;
          delete props.children;
        } else if (type === "Badge" && stringValue(props.label) === "") {
          props.label = legacyText;
          delete props.children;
        }
      }

      if (type === "Stack" && stringValue(props.direction) === "" && typeof props.row === "boolean") {
        props.direction = props.row ? "row" : "column";
      }

      return [
        id,
        {
          ...element,
          props,
          children: Array.isArray(element.children) ? element.children : [],
        },
      ];
    }),
  );
  return { ...spec, elements };
}

function normalizeCharacterShowcaseSpec(spec: UiSpec): UiSpec {
  if (spec.type !== "character_showcase") return spec;
  const elements = Object.fromEntries(
    Object.entries(spec.elements).map(([id, element]) => {
      if (!isRecord(element) || element.type !== "Image") return [id, element];
      const props = isRecord(element.props) ? element.props : {};
      return [
        id,
        {
          ...element,
          props: {
            ...props,
            maxWidth: 158,
            aspectRatio: "3/4",
            fit: props.fit ?? "cover",
          },
          children: Array.isArray(element.children) ? element.children : [],
        },
      ];
    }),
  );
  return { ...spec, elements };
}

function coerceLooseCharacterShowcase(value: unknown): UiSpec | null {
  if (!isRecord(value)) return null;
  if (value.type !== "character_showcase" || !Array.isArray(value.children)) {
    return null;
  }

  const props = isRecord(value.props) ? value.props : {};
  const elements: Record<string, unknown> = {
    root: {
      type: "Stack",
      props: { direction: "row", gap: 12 },
      children: [],
    },
  };
  const imageIds: string[] = [];

  value.children.forEach((child, index) => {
    if (!isRecord(child)) return;
    const childProps = isRecord(child.props) ? child.props : {};
    const image = isRecord(childProps.image) ? childProps.image : {};
    const name =
      stringValue(childProps.name) || i18n.t("superchat.spec.characterFallback", { index: index + 1 });
    const role = stringValue(childProps.role);
    const description = stringValue(childProps.description);
    const src = stringValue(image.src);

    if (!src && !name && !description) return;

    const id = `role_${index + 1}_img`;
    imageIds.push(id);
    elements[id] = {
      type: "Image",
      props: {
        src: src || `st-unresolved:role-${index + 1}`,
        alt: stringValue(image.alt) || name,
        maxWidth: 158,
        aspectRatio: "3/4",
        fit: "cover",
        overlayTitle: name,
        overlayDescription: description || role,
        overlayPosition: "bottom",
        overlayVariant: "gradient-dark",
        detailSections: [
          ...(role ? [{ label: i18n.t("superchat.spec.roleLabel"), value: role }] : []),
          ...(description
            ? [{ label: i18n.t("superchat.spec.descriptionLabel"), value: description }]
            : []),
        ],
      },
      children: [],
    };
  });

  if (imageIds.length === 0) return null;
  (elements.root as { children: string[] }).children = imageIds;

  return {
    type: "character_showcase",
    root: "root",
    elements,
    metadata: {
      title: stringValue(props.title),
      subtitle: stringValue(props.subtitle),
      coercedFrom: "legacy-character-card",
    },
  } as UiSpec;
}

type LooseVideoEntry = {
  src: string;
  poster?: string;
  title?: string;
  description?: string;
  status?: string;
};

function coerceLooseKeyframeVideo(value: unknown): UiSpec | null {
  if (!isRecord(value)) return null;
  if (value.type !== "keyframe_video") return null;

  const props = isRecord(value.props) ? value.props : {};
  const title = stringValue(props.title) || stringValue(value.title);
  const subtitle = stringValue(props.subtitle)
    || stringValue(props.description)
    || stringValue(value.subtitle)
    || stringValue(value.description);
  const status = stringValue(props.status) || stringValue(value.status);
  const progress = numberValue(props.progress ?? value.progress);
  const videos = collectLooseVideoEntries(value);

  if (videos.length > 0) {
    const elements: Record<string, unknown> = {
      root: {
        type: "Card",
        props: {
          ...(title ? { title } : {}),
          ...(subtitle ? { description: subtitle } : {}),
        },
        children: ["videos"],
      },
      videos: {
        type: "Stack",
        props: { direction: "row", gap: 12 },
        children: [],
      },
    };
    const videoIds: string[] = [];

    videos.forEach((video, index) => {
      const id = `video_${index + 1}`;
      videoIds.push(id);
      elements[id] = {
        type: "Video",
        props: {
          src: video.src,
          ...(video.poster ? { poster: video.poster } : {}),
          controls: true,
          muted: true,
          size: "sm",
          maxWidth: 158,
          aspectRatio: "3/4",
          fit: "cover",
          overlayTitle: video.title || title || `#${index + 1}`,
          overlayDescription: video.description || video.status || subtitle,
        },
        children: [],
      };
    });

    (elements.videos as { children: string[] }).children = videoIds;

    return {
      type: "keyframe_video",
      root: "root",
      elements,
      metadata: {
        coercedFrom: "legacy-keyframe-video",
      },
    } as UiSpec;
  }

  const statusLabel = status || (progress !== null ? `${progress}%` : "");
  const children = [
    ...(statusLabel ? ["status"] : []),
    ...(progress !== null ? ["progress"] : []),
    ...(subtitle && !title ? ["subtitle"] : []),
  ];

  if (!title && children.length === 0) return null;

  return {
    type: "keyframe_video",
    root: "root",
    elements: {
      root: {
        type: "Card",
        props: {
          ...(title ? { title } : {}),
          ...(subtitle && title ? { description: subtitle } : {}),
        },
        children,
      },
      status: {
        type: "Badge",
        props: { label: statusLabel, variant: statusBadgeVariant(status) },
        children: [],
      },
      progress: {
        type: "Progress",
        props: { value: progress ?? 0 },
        children: [],
      },
      subtitle: {
        type: "Text",
        props: { content: subtitle },
        children: [],
      },
    },
    metadata: {
      coercedFrom: "legacy-keyframe-video",
    },
  } as UiSpec;
}

function collectLooseVideoEntries(value: unknown): LooseVideoEntry[] {
  const entries: LooseVideoEntry[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;

    const entry = looseVideoEntryFromRecord(node);
    if (entry) {
      entries.push(entry);
    }

    if (Array.isArray(node.children)) {
      node.children.forEach(visit);
    }

    const props = isRecord(node.props) ? node.props : null;
    if (props && Array.isArray(props.children)) {
      props.children.forEach(visit);
    }
    if (props && Array.isArray(props.items)) {
      props.items.forEach(visit);
    }
    if (props && Array.isArray(props.videos)) {
      props.videos.forEach(visit);
    }
  };

  visit(value);

  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.src)) return false;
    seen.add(entry.src);
    return true;
  });
}

function looseVideoEntryFromRecord(record: Record<string, unknown>): LooseVideoEntry | null {
  const props = isRecord(record.props) ? record.props : {};
  const nestedVideo = isRecord(props.video)
    ? props.video
    : isRecord(record.video)
      ? record.video
      : null;
  const nestedMedia = isRecord(props.media)
    ? props.media
    : isRecord(record.media)
      ? record.media
      : null;
  const source = nestedVideo ?? nestedMedia ?? props;
  const src = firstString(
    source.src,
    source.url,
    source.video,
    source.video_url,
    source.videoUrl,
    props.src,
    props.url,
    record.src,
    record.url,
    record.video_url,
    record.videoUrl,
  );

  if (!src || !looksLikeVideoUrl(src)) return null;

  const poster = firstString(
    source.poster,
    source.image,
    source.image_url,
    source.imageUrl,
    props.poster,
    props.image,
    props.image_url,
    record.poster,
    record.image,
    record.image_url,
  );

  return {
    src,
    poster: poster || undefined,
    title: firstString(source.title, props.title, record.title) || undefined,
    description: firstString(
      source.description,
      source.subtitle,
      props.description,
      props.subtitle,
      record.description,
      record.subtitle,
    ) || undefined,
    status: firstString(source.status, props.status, record.status) || undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(Math.max(value, 0), 100);
  }
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, 0), 100);
}

function looksLikeVideoUrl(value: string): boolean {
  return /\.(mp4|webm|mov|m4v|ogg)(\?.*)?$/i.test(value)
    || value.startsWith("st-unresolved:video");
}

function statusBadgeVariant(status: string): string {
  const normalized = status.toLowerCase();
  // 下面比对的是后端 / 模型给的状态原文，不是界面文案，跟着界面语言走就认不出来了。
  // i18n-exempt-start
  if (["failed", "error", "失败"].some((item) => normalized.includes(item))) {
    return "danger";
  }
  if (["complete", "completed", "done", "完成"].some((item) => normalized.includes(item))) {
    return "success";
  }
  if (["running", "pending", "生成中", "处理中"].some((item) => normalized.includes(item))) {
    return "info";
  }
  // i18n-exempt-end
  return "default";
}

function addBlock(
  blocks: StructuredBlock[],
  seenSpecs: Set<string>,
  label: string,
  value: UiSpec,
) {
  const key = stableSpecKey(value);
  if (seenSpecs.has(key)) return;
  seenSpecs.add(key);
  blocks.push({ id: `${label}-${blocks.length}`, label, value });
}

function stableSpecKey(value: UiSpec): string {
  try {
    return JSON.stringify(value);
  } catch {
    return `${value.root}:${Object.keys(value.elements).join(",")}`;
  }
}

function extractSpecsFromRaw(raw: unknown): UiSpec[] {
  if (!raw || typeof raw !== "object") return [];
  const value = raw as Record<string, unknown>;
  const specs: UiSpec[] = [];

  const directSpec = coerceUiSpec(value);
  if (directSpec) {
    specs.push(directSpec);
  }
  const nestedSpec = value.type === "ui_spec" ? coerceUiSpec(value.spec) : null;
  if (nestedSpec) {
    specs.push(nestedSpec);
  }

  const content = value.content;
  if (!Array.isArray(content)) {
    for (const key of ["text", "content", "result", "output"]) {
      const item = value[key];
      if (typeof item === "string") {
        specs.push(...parseSpecsFromText(item));
      }
    }
    return specs;
  }

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    const blockSpec = item.type === "ui_spec" ? coerceUiSpec(item.spec) : null;
    if (blockSpec) {
      specs.push(blockSpec);
      continue;
    }
    for (const key of ["text", "content", "result", "output"]) {
      const text = item[key];
      if (typeof text === "string") {
        specs.push(...parseSpecsFromText(text));
      }
    }
  }

  return specs;
}

function parseSpecsFromText(text: string): UiSpec[] {
  const specs: UiSpec[] = [];
  for (const match of text.matchAll(uiSpecTagRegex())) {
    const value = safeJsonParse(match[1].trim());
    const spec = coerceUiSpec(value);
    if (spec) {
      specs.push(spec);
    }
  }

  return specs;
}
