"""Generation instructions separating workflow planning from Recipe execution."""

GENERATION_PARAMETER_PLANNING_INSTRUCTIONS = (
    "When the user leaves the model unspecified or requests recommendations, use "
    "'recommended' only in intent.inputs.image_model / video_model for an Intent, "
    "or nodes[].data.model for a complete Plan. Never put model fields on Intent items. "
    "The server resolves recommendations against the user's visible catalog and validates "
    "compatible parameters before returning a preview for confirmation. Never put "
    "'recommended' in size, quality, or resolution and never select the first catalog entry. "
    "For an explicitly selected model, query freezone_get_node_create_schema with that "
    "model_id before choosing its supported options; do not invent quality or resolution "
    "values or reuse another model's options. Preserve all explicit user requirements. "
    "If no compatible recommendation exists, use the generation clarification flow; "
    "do not silently change constraints or bypass preflight, admission, or confirmation."
)

WORKFLOW_PLANNING_INSTRUCTIONS = (
    "Workflow planning produces topology, Recipe identities, dependencies, confirmed "
    "generation parameters, and short node task briefs, not finished production content. "
    "Write each node prompt as one or two concise sentences stating its task, scope, "
    "required upstream outputs, and references. Preserve user-supplied story facts, "
    "dialogue, source text, and explicit creative requirements; do not replace or "
    "truncate user material. Do not invent complete scripts, detailed shot-by-shot "
    "storyboards, dialogue, camera choreography, sound cues, or final image/video "
    "generation prompts before their upstream production stages have executed. "
    "A selected Skill may require a concrete action brief for draft review: author that "
    "brief as a planning constraint now, not an instruction to supply it later. Such a "
    "brief may exceed two sentences and does not claim upstream stages have executed. "
    "Runtime Recipe compilation combines the task brief with actual upstream outputs, "
    "the selected Recipe pipeline, confirmed parameters, and reference media to produce "
    "the executable prompt. For example, a video task brief can say: generate the first "
    "shot group from the upstream storyboard using the linked character and scene "
    "anchors. Plan all required stages and independent assets, but do not pretend "
    "their future generated content is already known. When the final result combines "
    "multiple video clips or video with audio, include one terminal videoComposeNode "
    "and connect each contributing video/audio node with composition_input_for. "
    "A single video output without composition does not need a videoComposeNode. "
    + GENERATION_PARAMETER_PLANNING_INSTRUCTIONS
)
