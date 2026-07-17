// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 系统各功能使用的 LLM 映射定义。
// 每个功能对应后端一个 *_MODEL 环境变量，前端允许用户为其覆盖模型。
// 思考强度（*_THINKING_LEVEL）与 provider 不在前端配置，后端保留默认。

export interface FeatureModelDef {
  /** 稳定 id，对应后端 *_MODEL 环境变量前缀，如 GLOBAL_VIDEO_OPTIMIZER。 */
  id: string;
  /** 后端默认模型名，用作下拉「默认」项的展示与初始可用模型池。 */
  defaultModel: string;
  /** 该功能会向上游 LLM 发送图片，需要选择支持视觉输入的模型。 */
  requiresVision?: boolean;
}

export interface FeatureModelGroup {
  /** 分组 key，用于拼接 i18n： settings.modelConfig.featureModels.groups.<key>。 */
  key: string;
  features: readonly FeatureModelDef[];
}

export const FEATURE_MODEL_GROUPS: readonly FeatureModelGroup[] = [
  {
    key: "chat",
    features: [{ id: "HERMES", defaultModel: "DC-hermes-LLM" }],
  },
  {
    key: "shot",
    features: [
      {
        id: "GLOBAL_VIDEO_OPTIMIZER",
        defaultModel: "DC-video-prompt-optimizer-LLM",
        requiresVision: true,
      },
      { id: "SEEDANCE2_PROMPT_COMPOSER", defaultModel: "DC-seedance2-prompt-composer-LLM" },
    ],
  },
  {
    key: "sketch",
    features: [
      {
        id: "GLOBAL_VIDEO_IDENTITY_DETECTOR",
        defaultModel: "DC-video-identity-detector-LLM",
        requiresVision: true,
      },
    ],
  },
  {
    key: "episode",
    features: [
      { id: "IDENTITY_PLANNER_CAST", defaultModel: "DC-identity-cast-planner-LLM" },
      { id: "IDENTITY_PLANNER_ANALYSIS", defaultModel: "DC-identity-analysis-planner-LLM" },
      { id: "IDENTITY_PLANNER_APPEARANCE", defaultModel: "DC-identity-appearance-writer-LLM" },
      { id: "LITERAL_BEAT_META", defaultModel: "DC-literal-beat-meta-LLM" },
      { id: "EPISODE_SCENE_PLANNER", defaultModel: "DC-episode-scene-planner-LLM" },
      { id: "EPISODE_PROP_PLANNER", defaultModel: "DC-episode-prop-planner-LLM" },
    ],
  },
  {
    key: "sceneLibrary",
    features: [{ id: "SCENE_BUILD", defaultModel: "DC-scene-builder-LLM" }],
  },
  {
    key: "freezone",
    features: [
      { id: "FREEZONE_TRANSLATION", defaultModel: "DC-freezone-translator-LLM" },
      { id: "FREEZONE_STORY_SCRIPT", defaultModel: "DC-freezone-story-script-writer-LLM" },
      {
        id: "FREEZONE_VISION",
        defaultModel: "DC-freezone-vision-LLM",
        requiresVision: true,
      },
    ],
  },
  {
    key: "style",
    features: [
      {
        id: "STYLE_ANALYZER",
        defaultModel: "DC-style-analyzer-LLM",
        requiresVision: true,
      },
    ],
  },
  {
    key: "contentRewrite",
    features: [{ id: "CONTENT_REWRITER", defaultModel: "DC-content-rewriter-LLM" }],
  },
  {
    key: "screenplay",
    features: [{ id: "SCREENPLAY_NORMALIZER", defaultModel: "DC-screenplay-normalizer-LLM" }],
  },
  {
    key: "assetCompile",
    features: [
      { id: "EPISODE_SCENE_RECONCILE", defaultModel: "DC-episode-scene-reconciler-LLM" },
      { id: "NARRATED_SCENE_ASSET", defaultModel: "DC-narrated-scene-asset-planner-LLM" },
    ],
  },
  {
    key: "directorWorld",
    features: [{ id: "STAGING_PROP", defaultModel: "DC-staging-prop-planner-LLM" }],
  },
  {
    key: "novelImport",
    features: [{ id: "COGNEE", defaultModel: "DC-cognee-LLM" }],
  },
];

const FEATURE_MODEL_BY_ID = new Map(
  FEATURE_MODEL_GROUPS.flatMap((group) => group.features.map((feature) => [feature.id, feature])),
);

function productFeature(id: string): FeatureModelDef {
  const feature = FEATURE_MODEL_BY_ID.get(id);
  if (!feature) throw new Error(`Unknown feature model id: ${id}`);
  return feature;
}

/**
 * 设置界面的产品入口分组。这里只决定展示位置；系统默认模型顺序、渠道映射
 * 和后端环境变量仍由 FEATURE_MODEL_GROUPS 决定，避免界面改名影响运行逻辑。
 */
export const FEATURE_MODEL_PRODUCT_GROUPS: readonly FeatureModelGroup[] = [
  {
    key: "xiahua",
    features: [
      productFeature("FREEZONE_TRANSLATION"),
      productFeature("FREEZONE_STORY_SCRIPT"),
      productFeature("FREEZONE_VISION"),
      productFeature("STAGING_PROP"),
    ],
  },
  {
    key: "xialiao",
    features: [productFeature("CONTENT_REWRITER"), productFeature("SCREENPLAY_NORMALIZER")],
  },
  { key: "xiatan", features: [productFeature("SCENE_BUILD")] },
  {
    key: "xiajing",
    features: [
      productFeature("GLOBAL_VIDEO_OPTIMIZER"),
      productFeature("SEEDANCE2_PROMPT_COMPOSER"),
      productFeature("GLOBAL_VIDEO_IDENTITY_DETECTOR"),
      productFeature("IDENTITY_PLANNER_CAST"),
      productFeature("IDENTITY_PLANNER_ANALYSIS"),
      productFeature("IDENTITY_PLANNER_APPEARANCE"),
      productFeature("LITERAL_BEAT_META"),
      productFeature("EPISODE_SCENE_PLANNER"),
      productFeature("EPISODE_PROP_PLANNER"),
      productFeature("EPISODE_SCENE_RECONCILE"),
      productFeature("NARRATED_SCENE_ASSET"),
    ],
  },
  { key: "xiadao", features: [productFeature("HERMES")] },
  { key: "xiage", features: [productFeature("STYLE_ANALYZER")] },
];

/** 所有功能的默认模型（去重），用作「可用模型」池的预填值。 */
export const DEFAULT_AVAILABLE_MODELS: readonly string[] = Array.from(
  new Set(FEATURE_MODEL_GROUPS.flatMap((g) => g.features.map((f) => f.defaultModel)))
);

const FEATURE_DEFAULT_MODEL_BY_ID: Record<string, string> = Object.fromEntries(
  FEATURE_MODEL_GROUPS.flatMap((g) => g.features.map((f) => [f.id, f.defaultModel]))
);

export function getFeatureDefaultModel(id: string): string | undefined {
  return FEATURE_DEFAULT_MODEL_BY_ID[id];
}
