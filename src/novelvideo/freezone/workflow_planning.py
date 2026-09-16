"""Generation instructions separating workflow planning from Recipe execution."""

WORKFLOW_PLANNING_INSTRUCTIONS = (
    "Workflow planning produces topology, Recipe identities, dependencies, confirmed "
    "generation parameters, and short node task briefs, not finished production content. "
    "Write each node prompt as one or two concise sentences stating its task, scope, "
    "required upstream outputs, and references. Preserve user-supplied story facts, "
    "dialogue, source text, and explicit creative requirements; do not replace or "
    "truncate user material. Do not invent complete scripts, detailed shot-by-shot "
    "storyboards, dialogue, camera choreography, sound cues, or final image/video "
    "generation prompts before their upstream production stages have executed. "
    "Runtime Recipe compilation combines the task brief with actual upstream outputs, "
    "the selected Recipe pipeline, confirmed parameters, and reference media to produce "
    "the executable prompt. For example, a video task brief can say: generate the first "
    "shot group from the upstream storyboard using the linked character and scene "
    "anchors. Plan all required stages and independent assets, but do not pretend "
    "their future generated content is already known."
)
