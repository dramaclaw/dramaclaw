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
    key: "xiahua",
    features: [
      { id: "FREEZONE_TRANSLATION", defaultModel: "DC-freezone-translator-LLM" },
      { id: "FREEZONE_STORY_SCRIPT", defaultModel: "DC-freezone-story-script-writer-LLM" },
      { id: "STAGING_PROP", defaultModel: "DC-staging-prop-planner-LLM" },
    ],
  },
  {
    key: "xialiao",
    features: [
      { id: "CONTENT_REWRITER", defaultModel: "DC-content-rewriter-LLM" },
      { id: "SCREENPLAY_NORMALIZER", defaultModel: "DC-screenplay-normalizer-LLM" },
    ],
  },
  {
    key: "xiatan",
    features: [{ id: "SCENE_BUILD", defaultModel: "DC-scene-builder-LLM" }],
  },
  {
    key: "xiajing",
    features: [
      {
        id: "GLOBAL_VIDEO_OPTIMIZER",
        defaultModel: "DC-video-prompt-optimizer-LLM",
        requiresVision: true,
      },
      { id: "SEEDANCE2_PROMPT_COMPOSER", defaultModel: "DC-seedance2-prompt-composer-LLM" },
      {
        id: "GLOBAL_VIDEO_IDENTITY_DETECTOR",
        defaultModel: "DC-video-identity-detector-LLM",
        requiresVision: true,
      },
      { id: "IDENTITY_PLANNER_CAST", defaultModel: "DC-identity-cast-planner-LLM" },
      { id: "IDENTITY_PLANNER_ANALYSIS", defaultModel: "DC-identity-analysis-planner-LLM" },
      { id: "IDENTITY_PLANNER_APPEARANCE", defaultModel: "DC-identity-appearance-writer-LLM" },
      { id: "LITERAL_BEAT_META", defaultModel: "DC-literal-beat-meta-LLM" },
      { id: "EPISODE_SCENE_PLANNER", defaultModel: "DC-episode-scene-planner-LLM" },
      { id: "EPISODE_PROP_PLANNER", defaultModel: "DC-episode-prop-planner-LLM" },
      { id: "EPISODE_SCENE_RECONCILE", defaultModel: "DC-episode-scene-reconciler-LLM" },
      { id: "NARRATED_SCENE_ASSET", defaultModel: "DC-narrated-scene-asset-planner-LLM" },
    ],
  },
  {
    key: "xiadao",
    features: [{ id: "HERMES", defaultModel: "DC-hermes-LLM" }],
  },
  {
    key: "xiage",
    features: [
      {
        id: "STYLE_ANALYZER",
        defaultModel: "DC-style-analyzer-LLM",
        requiresVision: true,
      },
    ],
  },
  {
    key: "novelImport",
    features: [{ id: "COGNEE", defaultModel: "DC-cognee-LLM" }],
  },
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
