# Visual Style Preset Design

This directory is the single source of truth for built-in project visual style presets.
Each preset is a production look package, not just a media switch.

## Core Model

A preset should encode:

- Medium: live action, 2D anime, 3D Guoman, etc.
- Visual finish: lens feel, lighting behavior, rendering quality, texture, and grade.
- Light genre tone: only when it is part of the chosen production look.

A preset must not override the concrete content of the story. Exact era, location, wardrobe, architecture, technology, props, character origin, and action come from beat, scene, character, and prop descriptions.

## Field Semantics

`label` is the product-facing name. It may describe the intended look in familiar user language, but it is not injected into generation prompts and must not act as a hidden content fallback. For example, the built-in `guoman_fantasy` preset keeps the familiar `3D玄幻国漫` label while its prompt controls only the 3D Guoman rendering medium and finish.

Content bias inside a preset may only be conditional genre tone, never a hard rule or a fallback source for concrete entities. Exact facial traits, expression, temperament, ethnicity, age, costume, identity, props, and environment details belong to character/scene/prop content. Explicit descriptions and reference images always win.

`style_tag` is the short, high-signal anchor injected near every generated panel. It should describe medium and grade, not era or story content. Avoid words like `PERIOD`, `REPUBLICAN`, `ERA`, `DYNASTY`, `MODERN`, `ANCIENT`, `DRAMA`, `民国`, or `古装` in `style_tag`.

Because `style_tag` is repeated on every panel and is not visible to the user, an era/content word here silently overrides legitimate content (a flashback phone, a Western suit, a pre-apocalypse clean scene) on every frame. That is exactly the covert-injection failure this design avoids. It is consumed in two places, both of which inherit this constraint:

- `generators/prompt_builder.py` — appended to each Panel header in render mode: `- **Panel N** [loc] [tod] [STYLE_TAG]:`.
- `generators/voxel_restyle.py` — the target look for the voxel→realistic restyle. Its empty-`style_tag` fallback must stay neutral (e.g. `PHOTOREALISTIC`); it must NOT fall back to `label`, since labels like `写实古装剧` / `民国年代剧` carry era words.

`style_instructions` explains how to shoot, render, light, grade, and texture the image. It may include conditional genre flavor such as "when the beat or scene context calls for it", but it must explicitly defer concrete content to beat, scene, character, and prop descriptions.

`avoid_instructions` should guard medium and quality: no wrong rendering medium, no watermarks, no broken anatomy, no plastic skin, no overprocessed HDR. It must not hard-ban story content such as modern objects, foreign people, mixed ethnicity, traversal-story details, or non-default cultures.

## Ethnicity And Origin

Ethnicity is only a fallback for unspecified people. If character descriptions, reference images, or beat context specify nationality, ethnicity, region, or mixed origin, generation must follow that explicit description instead of the project default.

## Custom And Auto-Analyzed Styles

Built-in presets in this directory are global and read-only. Projects can also define custom styles, stored per project in `project_config.json` under `custom_styles` (see `services/style_service.py`). `StyleService.get_style()` looks up custom first, then falls back to the built-in preset, so a custom style with the same id shadows a preset — but only inside that one project.

Every rule above applies equally to custom styles, including ones generated automatically from reference images by `generators/style_analyzer.py`. The analyzer must produce a `style_tag` that obeys the medium/grade-only constraint and the forbidden-word list; otherwise auto-created styles reintroduce covert era injection through the per-panel tag. A custom style may set `base` to inherit a preset's fields.

## Adding A New Preset

When adding a preset:

1. Keep the JSON preset as the source of truth; do not add hardcoded fallback copies in code.
2. Choose a precise `label` that matches any intentional content bias.
3. Keep `style_tag` short and focused on medium/grade.
4. Make `style_instructions` defer to beat/scene/entity content.
5. Keep `avoid_instructions` limited to medium and quality constraints.
6. Add or update tests that protect the preset list and `style_tag` semantics.
