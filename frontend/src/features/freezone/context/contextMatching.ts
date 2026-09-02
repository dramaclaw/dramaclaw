// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 这三件套（contextMatching / contextPromptCompiler / contextOperations）目前没有任何
// 界面引用，reason / label 也直接拼进 contextPromptCompiler 那份锁中文的提示词。
// 等它真被挂到某个面板上时，这些串要一起入词条；在那之前整份免检。
// i18n-exempt-start
import type { MainlineContext } from "./mainlineContext";

export interface ContextMatch {
  matched: boolean;
  reason: string;
  beat?: MainlineContext;
  identities: MainlineContext[];
  scene?: MainlineContext;
  props: MainlineContext[];
  artifacts: MainlineContext[];
}

const EMPTY_MATCH: ContextMatch = {
  matched: false,
  reason: "缺少主线上下文，按普通图片处理",
  identities: [],
  props: [],
  artifacts: [],
};

function sameBeat(a: MainlineContext, b: MainlineContext): boolean {
  return (
    typeof a.episode === "number" &&
    typeof a.beat === "number" &&
    a.episode === b.episode &&
    a.beat === b.beat
  );
}

function findBeatContext(
  contexts: MainlineContext[],
  artifact: MainlineContext,
): MainlineContext | undefined {
  return contexts.find(
    (ctx) =>
      ctx.kind === "beat" &&
      sameBeat(ctx, artifact) &&
      typeof ctx.visualDescription === "string" &&
      ctx.visualDescription.trim().length > 0,
  );
}

function reasonForBeat(beat: MainlineContext, suffix: string): string {
  return `EP${beat.episode}/B${beat.beat} · ${suffix}`;
}

function findUsableBeatContext(contexts: MainlineContext[]): MainlineContext | undefined {
  return contexts.find(
    (ctx) =>
      ctx.kind === "beat" &&
      typeof ctx.episode === "number" &&
      typeof ctx.beat === "number" &&
      typeof ctx.visualDescription === "string" &&
      ctx.visualDescription.trim().length > 0,
  );
}

function artifactMatch(
  contexts: MainlineContext[],
  kind: "director_combined" | "selected_background",
  suffix: string,
): ContextMatch {
  const artifact = contexts.find((ctx) => ctx.kind === kind);
  if (!artifact) return { ...EMPTY_MATCH };
  const beat = findBeatContext(contexts, artifact);
  if (!beat) {
    return {
      ...EMPTY_MATCH,
      reason: "缺少镜头上下文，按普通图片处理",
      artifacts: [artifact],
    };
  }
  return {
    matched: true,
    reason: reasonForBeat(beat, suffix),
    beat,
    identities: contexts.filter((ctx) => ctx.kind === "identity"),
    scene: contexts.find((ctx) => ctx.kind === "scene"),
    props: contexts.filter((ctx) => ctx.kind === "prop"),
    artifacts: [artifact],
  };
}

function matchesIdentity(ctx: MainlineContext, required: Set<string>): boolean {
  const identityId = String(ctx.identityId || "").trim();
  const character = String(ctx.character || "").trim();
  return Boolean(
    (identityId && required.has(identityId)) ||
      (character && required.has(character)) ||
      (identityId && [...required].some((item) => identityId.startsWith(`${item}_`))),
  );
}

function matchesProp(ctx: MainlineContext, required: Set<string>): boolean {
  const propId = String(ctx.propId || "").trim();
  return Boolean(propId && required.has(propId));
}

function matchingContextForBeat(
  contexts: MainlineContext[],
  kind: "identity" | "scene" | "prop",
  beat: MainlineContext,
): MainlineContext[] {
  return contexts.filter((ctx) => {
    if (ctx.kind !== kind) return false;
    if (
      typeof ctx.episode === "number" &&
      typeof ctx.beat === "number" &&
      !sameBeat(ctx, beat)
    ) {
      return false;
    }
    return true;
  });
}

export function matchForDirectorCombinedToSketch(
  contexts: MainlineContext[],
): ContextMatch {
  return artifactMatch(contexts, "director_combined", "导演合成图可生成草图");
}

export function matchForSelectedBackgroundToSketch(
  contexts: MainlineContext[],
): ContextMatch {
  return artifactMatch(
    contexts,
    "selected_background",
    "当前背景可生成草图",
  );
}

export function matchForBeatToSketch(contexts: MainlineContext[]): ContextMatch {
  const beat = findUsableBeatContext(contexts);
  if (!beat) return { ...EMPTY_MATCH };
  return {
    matched: true,
    reason: reasonForBeat(beat, "Beat 可生成草图"),
    beat,
    identities: contexts.filter((ctx) => ctx.kind === "identity"),
    scene: contexts.find((ctx) => ctx.kind === "scene"),
    props: contexts.filter((ctx) => ctx.kind === "prop"),
    artifacts: [],
  };
}

export function matchForFrameGeneration(contexts: MainlineContext[]): ContextMatch {
  const sketch = contexts.find((ctx) => ctx.kind === "sketch");
  if (!sketch) return { ...EMPTY_MATCH };
  const beat = findBeatContext(contexts, sketch);
  if (!beat) {
    return {
      ...EMPTY_MATCH,
      reason: "缺少镜头上下文，按普通图片处理",
      artifacts: [sketch],
    };
  }

  const scene = matchingContextForBeat(contexts, "scene", beat).find((ctx) =>
    beat.sceneId ? ctx.sceneId === beat.sceneId : true,
  );
  const requiredIdentitySet = new Set(beat.detectedIdentities || []);
  const identities = matchingContextForBeat(contexts, "identity", beat).filter(
    (ctx) => requiredIdentitySet.size === 0 || matchesIdentity(ctx, requiredIdentitySet),
  );
  const requiredPropSet = new Set(beat.detectedProps || []);
  const props = matchingContextForBeat(contexts, "prop", beat).filter(
    (ctx) => requiredPropSet.size === 0 || matchesProp(ctx, requiredPropSet),
  );

  const parts = ["草图可生成分镜"];
  parts.push("身份/场景/道具由主线 DB 读取");
  if (identities.length) parts.push(`${identities.length} 个身份匹配`);
  if (scene) parts.push(`${scene.sceneId || "场景"}匹配`);
  if (props.length) parts.push(`${props.length} 个道具匹配`);

  return {
    matched: true,
    reason: reasonForBeat(beat, parts.join(" · ")),
    beat,
    identities,
    scene,
    props,
    artifacts: [sketch],
  };
}
// i18n-exempt-end
