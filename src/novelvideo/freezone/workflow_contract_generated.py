"""Generated from schemas/workflow/v1/stable-contract.json; do not edit."""

SOURCE_SHA256 = "22333a008ac8ec1d7aa427900daeb50354852af5e2789303840fd716b64b63fc"
WORKFLOW_CONTRACT_SCHEMA_VERSION = "freezone_workflow_contract.v1"
WORKFLOW_PLAN_SCHEMA_VERSION = "freezone_workflow_plan.v1"
WORKFLOW_INTENT_SCHEMA_VERSION = "freezone_workflow_intent.v1"
WORKFLOW_NODE_TYPES = [
    "textAnnotationNode",
    "scriptNode",
    "beatContextNode",
    "imageGenNode",
    "videoNode",
    "audioNode",
    "htmlArtifactNode",
    "videoComposeNode",
]
AGENT_CREATABLE_NODE_TYPES = [
    "uploadNode",
    "imageGenNode",
    "beatContextNode",
    "textAnnotationNode",
    "videoNode",
    "audioNode",
    "videoComposeNode",
    "scriptNode",
    "pano360ViewerNode",
    "threeDWorldNode",
    "skillNode",
    "htmlArtifactNode",
]
WORKFLOW_LINK_TYPES = [
    "context_for",
    "prompt_for",
    "dependency_for",
    "media_input_for",
    "derived_from",
    "composition_input_for",
]
GENERATION_ACTION_TYPES = [
    "generate_text",
    "generate_story_script",
    "generate_image",
    "generate_video",
    "generate_text_video",
    "generate_audio",
    "generate_3gs_world",
    "auto_compose_video",
]
MODEL_ALIASES_BY_NODE_TYPE = {
    "imageGenNode": {
        "nano-banana-2": "newapi_nanobanana2",
        "nanobanana2": "newapi_nanobanana2",
        "nano_banana_2": "newapi_nanobanana2",
        "gpt-image-2": "newapi_gpt_image2",
        "openai/gpt-image-2": "newapi_gpt_image2",
    },
    "videoNode": {
        "omni-flash": "newapi_seedance-2.0-fast",
        "omni_flash": "newapi_seedance-2.0-fast",
        "seedance_2_0_fast": "newapi_seedance-2.0-fast",
        "seedance-2.0-fast": "newapi_seedance-2.0-fast",
        "seedance-2.0": "newapi_seedance-2.0",
        "seedance-1.5-pro": "newapi_seedance-1.5-pro",
        "seedance-1.0-pro-fast": "newapi_seedance-1.0-pro-fast",
        "huimeng_seedance-2.0-fast": "newapi_seedance-2.0-fast",
        "huimeng_seedance-2.0": "newapi_seedance-2.0",
        "huimeng_seedance-1.5-pro": "newapi_seedance-1.5-pro",
        "huimeng_seedance-1.0-pro-fast": "newapi_seedance-1.0-pro-fast",
    },
}
RECIPE_ENVELOPE_CONTRACT = {
    "schema_version": "dramaclaw.recipe.v1",
    "required": [
        "id",
        "name",
        "output_kind",
        "action_keys",
        "system_prompt",
        "planning_prompt",
        "result_summary",
    ],
    "identifier_fields": ["id", "action_keys", "conflicts_with"],
    "version_fields": ["schema_version", "version"],
}
