"""Non-secret official defaults used when no local .env is present."""

OFFICIAL_NEWAPI_BASE_URL = "https://relayclaw.cdnfg.com/v1"

DEFAULT_COGNEE_LLM_PROVIDER = "newapi"
DEFAULT_COGNEE_LLM_MODEL = "DC-cognee-LLM"
DEFAULT_COGNEE_EMBEDDING_PROVIDER = "newapi"
DEFAULT_COGNEE_EMBEDDING_MODEL = "DC-cognee-embedding"
DEFAULT_COGNEE_EMBEDDING_DIM = "1024"
DEFAULT_EMBEDDING_BATCH_SIZE = "10"

DEFAULT_FREEZONE_TRANSLATION_MODEL = "brainclaw"
DEFAULT_FREEZONE_TEXT_WRITER_MODEL = "brainclaw"
DEFAULT_FREEZONE_STORY_SCRIPT_MODEL = "brainclaw"
DEFAULT_FREEZONE_RECIPE_COMPILER_MODEL = "brainclaw"
DEFAULT_FREEZONE_VISION_MODEL = "brainclaw"
DEFAULT_VIDEO_PROMPT_OPTIMIZER_MODEL = "brainclaw"

DEFAULT_TEXT_MODEL_BY_ENV = {
    "HERMES_MODEL": "brainclaw",
    "GLOBAL_VIDEO_OPTIMIZER_MODEL": DEFAULT_VIDEO_PROMPT_OPTIMIZER_MODEL,
    "KEYFRAME_PROMPT_MODEL": DEFAULT_VIDEO_PROMPT_OPTIMIZER_MODEL,
    "SEEDANCE2_PROMPT_COMPOSER_MODEL": "brainclaw",
    "GLOBAL_VIDEO_IDENTITY_DETECTOR_MODEL": "brainclaw",
    "IDENTITY_PLANNER_CAST_MODEL": "brainclaw",
    "IDENTITY_PLANNER_ANALYSIS_MODEL": "brainclaw",
    "IDENTITY_PLANNER_APPEARANCE_MODEL": "brainclaw",
    "LITERAL_BEAT_META_MODEL": "brainclaw",
    "SCENE_BUILD_MODEL": "brainclaw",
    "EPISODE_SCENE_PLANNER_MODEL": "brainclaw",
    "EPISODE_PROP_PLANNER_MODEL": "brainclaw",
    "FREEZONE_TRANSLATION_MODEL": DEFAULT_FREEZONE_TRANSLATION_MODEL,
    "FREEZONE_TEXT_WRITER_MODEL": DEFAULT_FREEZONE_TEXT_WRITER_MODEL,
    "FREEZONE_STORY_SCRIPT_MODEL": DEFAULT_FREEZONE_STORY_SCRIPT_MODEL,
    "FREEZONE_RECIPE_COMPILER_MODEL": DEFAULT_FREEZONE_RECIPE_COMPILER_MODEL,
    "FREEZONE_VISION_MODEL": DEFAULT_FREEZONE_VISION_MODEL,
    "STYLE_ANALYZER_MODEL": "brainclaw",
    "CONTENT_REWRITER_MODEL": "brainclaw",
    "SCREENPLAY_NORMALIZER_MODEL": "brainclaw",
    "EPISODE_SCENE_RECONCILE_MODEL": "brainclaw",
    "NARRATED_SCENE_ASSET_MODEL": "brainclaw",
    "STAGING_PROP_MODEL": "brainclaw",
    "COGNEE_LLM_MODEL": DEFAULT_COGNEE_LLM_MODEL,
}

# Advanced custom mode preserves the historical NewAPI aliases. These are not
# official defaults: they are the stable model-mapping contract owned by a
# user's local NewAPI installation.
ADVANCED_TEXT_MODEL_BY_ENV = {
    "HERMES_MODEL": "DC-hermes-LLM",
    "GLOBAL_VIDEO_OPTIMIZER_MODEL": "DC-video-prompt-optimizer-LLM",
    "KEYFRAME_PROMPT_MODEL": "DC-video-prompt-optimizer-LLM",
    "SEEDANCE2_PROMPT_COMPOSER_MODEL": "DC-seedance2-prompt-composer-LLM",
    "GLOBAL_VIDEO_IDENTITY_DETECTOR_MODEL": "DC-video-identity-detector-LLM",
    "IDENTITY_PLANNER_CAST_MODEL": "DC-identity-cast-planner-LLM",
    "IDENTITY_PLANNER_ANALYSIS_MODEL": "DC-identity-analysis-planner-LLM",
    "IDENTITY_PLANNER_APPEARANCE_MODEL": "DC-identity-appearance-writer-LLM",
    "LITERAL_BEAT_META_MODEL": "DC-literal-beat-meta-LLM",
    "SCENE_BUILD_MODEL": "DC-scene-builder-LLM",
    "CHARACTER_BUILD_MODEL": "DC-character-builder-LLM",
    "EPISODE_SCENE_PLANNER_MODEL": "DC-episode-scene-planner-LLM",
    "EPISODE_PROP_PLANNER_MODEL": "DC-episode-prop-planner-LLM",
    "FREEZONE_TRANSLATION_MODEL": "DC-freezone-translator-LLM",
    "FREEZONE_TEXT_WRITER_MODEL": "DC-freezone-text-writer-LLM",
    "FREEZONE_STORY_SCRIPT_MODEL": "DC-freezone-story-script-writer-LLM",
    "FREEZONE_RECIPE_COMPILER_MODEL": "DC-freezone-recipe-compiler-LLM",
    "FREEZONE_VISION_MODEL": "DC-freezone-vision-LLM",
    "STYLE_ANALYZER_MODEL": "DC-style-analyzer-LLM",
    "CONTENT_REWRITER_MODEL": "DC-content-rewriter-LLM",
    "SCREENPLAY_NORMALIZER_MODEL": "DC-screenplay-normalizer-LLM",
    "EPISODE_SCENE_RECONCILE_MODEL": "DC-episode-scene-reconciler-LLM",
    "NARRATED_SCENE_ASSET_MODEL": "DC-narrated-scene-asset-planner-LLM",
    "STAGING_PROP_MODEL": "DC-staging-prop-planner-LLM",
    "COGNEE_LLM_MODEL": "DC-cognee-LLM",
}
