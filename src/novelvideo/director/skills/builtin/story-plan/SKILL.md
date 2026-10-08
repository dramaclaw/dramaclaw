---
name: story-plan
description: Build or revise a complete TV Director story outline using short-drama planning methods and confirmed project settings. Not a screenplay or episode directory.
---

# Story outline

Read [method.md](method.md) for craft and delivery requirements, then the host input and [output schema](schemas/output.json). The schema is for new candidates, not permission to overwrite existing documents.

The foundation is short-drama `/plan`. Load the shipped references: [opening](references/opening-rules.md), [rhythm](references/rhythm-curve.md), [audience reward](references/satisfaction-matrix.md). User constraints and chosen structure override generic long-series defaults. Short-drama `/outline` is the downstream episode directory, not this outline.

Use [templates/request.md](templates/request.md) with frozen project input. Return one candidate. The application handles validation, display, costs and human adoption. Failed validation retains the answer without authorizing a paid retry. Provenance records observable TV Director behavior, not private source access.

For adaptation, also load [source grounding](references/source-grounding.md): distinguish enacted events, character claims and missing causal links before expanding the outline. Original stories do not load this source-fidelity reference.
