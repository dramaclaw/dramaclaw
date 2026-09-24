# Support `firstFrame` in workflow generation preferences

## Context

Freezone workflow plans can express a portable video generation preference through
`inputs.video_generation_mode`. That value is copied to each generated video node
as `data.genMode`, while the live model catalog remains responsible for deciding
whether the selected model supports the requested mode.

The stable workflow intent schema and the catalog compiler currently maintain
separate lists of portable modes. Both omit `firstFrame`, even though node
preflight maps it to the catalog capability `first_frame` and Seedance 2.0
advertises that capability. As a result, valid first-frame video workflows are
rejected before model preflight.

## Design

Define one ordered `PORTABLE_VIDEO_GENERATION_MODES` constant in
`workflow_schema.py`. It will contain the existing portable modes plus
`firstFrame`. The workflow intent JSON Schema will derive its enum from this
constant, and the agent workflow catalog compiler will import the same constant
for its portable-input validation.

The model capability mapping in `workflow_preflight.py` remains separate. It
translates public node values to provider catalog values and intentionally covers
runtime-only modes such as `videoEdit`; those modes should not automatically
become portable workflow preferences.

No stored plan migration is needed. The field is optional, and existing values
keep their current spelling and behavior.

## Data flow

1. An agent supplies `inputs.video_generation_mode = "firstFrame"`.
2. The stable workflow intent schema accepts the value from the shared portable
   mode list.
3. The catalog compiler validates the same value against that shared list.
4. Workflow compilation copies the preference to video nodes as
   `data.genMode = "firstFrame"`.
5. Runtime preflight translates it to `first_frame` and checks the selected live
   model catalog entry.

If a model does not support `first_frame`, runtime preflight continues to return
the existing `model_capability_unsupported` blocker.

## Tests

Add regression coverage in `tests/test_workflow_plan.py` for both public entry
points:

- The workflow intent JSON Schema accepts `firstFrame`.
- `compile_workflow_intent` accepts `firstFrame` and writes it to every generated
  video node's `data.genMode`.

Existing invalid-mode coverage remains in place to prove unknown values are still
rejected. Run the focused workflow-plan and workflow-preflight test suites after
the change.

## Scope

This change does not alter frontend controls, provider model definitions, or the
runtime meaning of any generation mode. It only aligns the portable Plan contract
with the already-supported node and catalog vocabulary.
