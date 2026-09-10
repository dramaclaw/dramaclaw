# HTML Node Generation Routing Design

## Problem

An HTML node created manually on the canvas currently receives an implicit
`html-page` Recipe when the user clicks its generate button. That sends an
ordinary node action through `/freezone/recipes/generate-text`. The behavior
differs from image, video, audio, and text nodes, where Recipe compilation is
used only when workflow metadata explicitly selects a Recipe.

This coupling makes a plain HTML node depend on the Recipe catalog and causes
ordinary generation to fail with Recipe-specific errors.

## Desired behavior

HTML generation follows the same routing rule as other generation nodes:

- A manually created node without `workflowCatalog.recipeId` uses the ordinary
  text-generation task.
- A Skill or Workflow node with `workflowCatalog.recipeId` uses the selected
  Recipe and preserves its Skill, Recipe pipeline, and product-operation
  context.
- Both routes resolve the same directly connected text and media inputs,
  require a complete HTML document, and use the same Artifact persistence,
  versioning, history, and canvas attachment logic.

## Design

`workflowHtmlRuntime` remains the coordinator for an HTML node action. It first
collects connected inputs and builds the HTML execution prompt containing:

- the user's node prompt;
- connected text content and mention mappings;
- exact image, video, and audio URLs;
- available dimensions, aspect ratios, and duration metadata;
- the requirement to return only a complete HTML document.

The coordinator then selects one of two generation adapters:

1. If the node has a non-empty `workflowCatalog.recipeId`, call the existing
   Recipe text-generation adapter. Workflow metadata remains unchanged.
2. Otherwise, submit the assembled execution prompt through the existing
   `/projects/{project}/freezone/text/generate` job, wait for completion, and
   read its generated text result. Do not invent or persist an `html-page`
   Recipe on the node.

After generation, both adapters return a string to the existing HTML cleanup
and validation stage. The coordinator removes an optional Markdown fence,
requires matching `<html>` and `</html>` tags, and only then creates or updates
the HTML Artifact.

The ordinary route uses the existing `freezone.text_generate` billing rule and
task lifecycle because it invokes the same text writer model. Recipe product
operations remain limited to workflow execution.

## Error handling

- Ordinary generation exposes the text task's useful failure message on the
  HTML node and does not create or update an Artifact.
- Recipe generation continues to expose Recipe-specific failures on workflow
  nodes.
- Invalid or incomplete model output fails before Artifact persistence.
- Regeneration keeps the previous Artifact identity and version when any
  generation or validation step fails.
- A successful model call still checks that the canvas and Artifact version
  have not changed before saving.

## Compatibility

Existing Skill and Workflow HTML nodes continue using their configured Recipe.
Existing manually created nodes that accidentally have no Recipe begin using
ordinary generation without a migration. Nodes that already contain an
explicit `workflowCatalog.recipeId` retain workflow behavior.

The `generate_html` canvas action remains the single external node action for
manual clicks, Agent commands, and workflow execution. Routing is an internal
decision based on node metadata.

## Verification

Focused frontend tests will prove that:

- a manual HTML node submits the ordinary text-generation task and never calls
  Recipe generation;
- a workflow HTML node with a Recipe still calls Recipe generation and never
  submits the ordinary text task;
- connected text and media metadata reach both routes;
- ordinary task results pass through HTML validation and Artifact saving;
- task failure and invalid HTML preserve the previous Artifact;
- the existing `generate_html` action lifecycle remains compatible with both
  manual and workflow callers.

