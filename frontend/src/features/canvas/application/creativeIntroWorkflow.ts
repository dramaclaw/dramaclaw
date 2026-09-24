// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import type {
  CreativeIntroBlendCapability,
  CreativeIntroBlendRange,
} from '@/features/canvas/application/creativeIntroBlend';

export const CREATIVE_INTRO_DESIGN_STYLES = [
  'minimal',
  'chineseCalligraphy',
  'literaryHandwriting',
  'anime',
  'cyberpunk',
  'gothicFantasy',
] as const;

export const CREATIVE_INTRO_MOTION_STYLES = [
  'blurFade',
  'particles',
  'glitch',
  'handwriting',
  'assemble',
  'impact',
] as const;

export type CreativeIntroDesignStyle = (typeof CREATIVE_INTRO_DESIGN_STYLES)[number];
export type CreativeIntroMotionStyle = (typeof CREATIVE_INTRO_MOTION_STYLES)[number];

const DESIGN_STYLE_PROMPTS: Record<CreativeIntroDesignStyle, string> = {
  minimal: 'minimal premium typography, restrained spacing, cinematic editorial design',
  chineseCalligraphy: 'expressive Chinese calligraphy, ink rhythm, elegant cinematic composition',
  literaryHandwriting: 'warm literary handwriting, intimate texture, poetic composition',
  anime: 'high-energy anime title treatment, bold readable lettering, dramatic composition',
  cyberpunk: 'cyberpunk title treatment, controlled neon accents, futuristic cinematic detail',
  gothicFantasy: 'gothic fantasy lettering, engraved detail, mysterious cinematic atmosphere',
};

const MOTION_STYLE_PROMPTS: Record<CreativeIntroMotionStyle, string> = {
  blurFade: 'emerge from soft blur into a crisp, stable title',
  particles: 'assemble from fine particles with controlled cinematic motion',
  glitch: 'appear through a brief digital glitch and settle cleanly',
  handwriting: 'draw on naturally stroke by stroke, then hold clearly',
  assemble: 'assemble from separate typographic pieces into the final title',
  impact: 'enter with one decisive impact and subtle secondary motion',
};

export interface CreativeIntroPlan {
  title: string;
  frameSec: number;
  designStyle: CreativeIntroDesignStyle;
  motionStyle: CreativeIntroMotionStyle;
}

export function buildCreativeIntroPrompts(plan: CreativeIntroPlan) {
  const exactTitle = JSON.stringify(plan.title.trim());
  return {
    designPrompt:
      `Create a cinematic opening title frame from the provided reference image. ` +
      `Render the exact title ${exactTitle}, with no extra words and no spelling changes. ` +
      `${DESIGN_STYLE_PROMPTS[plan.designStyle]}. Preserve the source characters, setting, ` +
      `composition, aspect ratio, and visual identity. Keep the title readable and production-ready.`,
    motionPrompt:
      `Animate the exact title ${exactTitle} as a five-second opening title shot. ` +
      `${MOTION_STYLE_PROMPTS[plan.motionStyle]}. Preserve the title spelling, source image identity, ` +
      `composition, and aspect ratio. End on a readable stable frame; do not add extra text.`,
  };
}

type AddNode = (
  type: CanvasNodeType,
  position: { x: number; y: number },
  data?: Record<string, unknown>,
) => string;

export interface CreativeIntroWorkflowDeps {
  addDerivedExportNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
    previewImageUrl?: string,
  ) => string | null;
  addNode: AddNode;
  addEdge: (source: string, target: string) => void;
  findNodePosition: (sourceNodeId: string, width: number, height: number) => { x: number; y: number };
  updateNodeData: (nodeId: string, data: Record<string, unknown>) => void;
  setSelectedNode: (nodeId: string | null) => void;
  requestFocusNode: (nodeId: string) => void;
}

export interface SpawnCreativeIntroInput {
  sourceNodeId: string;
  keyframeUrl: string;
  aspectRatio: string;
  plan: CreativeIntroPlan;
  labels: {
    keyframe: string;
    design: string;
    motion: string;
    clip: string;
  };
  blend?: {
    clipUrl: string;
    range: CreativeIntroBlendRange;
    capability: CreativeIntroBlendCapability;
  };
}

/**
 * Builds an inspectable graph before any paid generation starts. Keeping this
 * orchestration independent from React also prevents the toolbar from becoming
 * a second generation lifecycle owner.
 */
export function spawnCreativeIntroWorkflow(
  deps: CreativeIntroWorkflowDeps,
  input: SpawnCreativeIntroInput,
) {
  const prompts = buildCreativeIntroPrompts(input.plan);
  const blendPrompt = input.blend
    ? ` Use the five-second source-video reference as the exact shot timing, camera motion, ` +
      `subject motion, scene continuity, and audio continuity. Integrate the supplied title-design ` +
      `image naturally into that footage instead of replacing the scene. The selected title ` +
      `keyframe occurs ${input.blend.range.keyframeOffsetSec.toFixed(2)} seconds after the source ` +
      `clip begins.`
    : '';
  const provenance = {
    sourceNodeId: input.sourceNodeId,
    title: input.plan.title.trim(),
    frameSec: input.plan.frameSec,
    designStyle: input.plan.designStyle,
    motionStyle: input.plan.motionStyle,
    ...(input.blend
      ? {
          blend: {
            ...input.blend.range,
            modelId: input.blend.capability.modelId,
            genMode: input.blend.capability.genMode,
          },
        }
      : {}),
  };

  const keyframeNodeId = deps.addDerivedExportNode(
    input.sourceNodeId,
    input.keyframeUrl,
    input.aspectRatio,
    input.keyframeUrl,
  );
  if (!keyframeNodeId) {
    throw new Error('Could not create the creative-intro keyframe node.');
  }
  deps.updateNodeData(keyframeNodeId, {
    displayName: input.labels.keyframe,
    creativeIntroPlan: { ...provenance, stage: 'keyframe' },
  });
  deps.addEdge(input.sourceNodeId, keyframeNodeId);

  const designNodeId = deps.addNode(
    CANVAS_NODE_TYPES.imageGen,
    deps.findNodePosition(keyframeNodeId, 480, 360),
    {
      displayName: input.labels.design,
      imageUrl: null,
      previewImageUrl: input.keyframeUrl,
      aspectRatio: input.aspectRatio,
      requestAspectRatio: input.aspectRatio,
      prompt: prompts.designPrompt,
      creativeIntroPlan: { ...provenance, stage: 'design' },
      user_spawned: true,
    },
  );
  deps.addEdge(keyframeNodeId, designNodeId);

  const clipNodeId = input.blend
    ? deps.addNode(
        CANVAS_NODE_TYPES.video,
        deps.findNodePosition(input.sourceNodeId, 580, 380),
        {
          displayName: input.labels.clip,
          videoUrl: input.blend.clipUrl,
          previewImageUrl: input.keyframeUrl,
          aspectRatio: input.aspectRatio,
          durationMs: 5_000,
          referenceOnly: true,
          creativeIntroPlan: { ...provenance, stage: 'sourceClip' },
          user_spawned: true,
        },
      )
    : null;
  if (clipNodeId) deps.addEdge(input.sourceNodeId, clipNodeId);

  const motionNodeId = deps.addNode(
    CANVAS_NODE_TYPES.video,
    deps.findNodePosition(designNodeId, 580, 380),
    {
      displayName: input.labels.motion,
      videoUrl: null,
      previewImageUrl: input.keyframeUrl,
      aspectRatio: input.aspectRatio,
      prompt: prompts.motionPrompt + blendPrompt,
      genMode: input.blend?.capability.genMode ?? 'imageReference',
      ...(input.blend
        ? {
            model: input.blend.capability.modelId,
            referenceOrder: [designNodeId, clipNodeId],
          }
        : {}),
      durationSec: 5,
      creativeIntroPlan: { ...provenance, stage: 'motion' },
      user_spawned: true,
    },
  );
  deps.addEdge(designNodeId, motionNodeId);
  if (clipNodeId) deps.addEdge(clipNodeId, motionNodeId);
  deps.setSelectedNode(designNodeId);
  deps.requestFocusNode(designNodeId);

  return { keyframeNodeId, designNodeId, clipNodeId, motionNodeId };
}
