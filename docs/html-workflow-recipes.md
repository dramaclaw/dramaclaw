# HTML deliverables in Skills

A Skill's planning notes describe the business workflow, for example:

> 先完成产品文案和配图，再制作包含这些内容的产品介绍网页。

The webpage Recipe declares its output format as machine metadata:

```json
{
  "output_kind": "text",
  "output_format": "html"
}
```

`output_kind` selects the existing text generation service. `output_format` selects a saved HTML artifact as the deliverable. Recipes without this metadata retain their existing output behavior. HTML format is valid only for text Recipes.

Workflow Skill packages expose each Recipe's `node_type` and optional `output_format` to the planner. The ordinary intent compiler automatically maps the webpage Recipe to an HTML step. The planner lists consumed copy and generated media in `reference_inputs`; the compiler produces typed input edges, and execution waits for their real outputs before generating and saving the webpage. `depends_on` alone remains execution ordering for textual sources. HTML does not require technical canvas-command instructions in Skill prose.

The compiler uses the existing authorized Recipe and Artifact services. The saved node contains artifact identity and revision, while the HTML source belongs to Artifact storage. A failed or missing upstream output prevents execution; a save conflict preserves the existing revision. Repeated creates use a scoped idempotency key and recover a previously saved artifact when its response was lost.

Ordinary HTML generation stores the existing Freezone text task key and the Artifact save context on the node as soon as the task is accepted. Reloading the canvas resumes that task and performs only the remaining Artifact save. A failed save retains the task reference, so retrying the node fetches the same generated source and uses the same Artifact idempotency key instead of calling the model again. Recipe-backed text generation still uses the synchronous Recipe endpoint; its model request is not yet resumable across a page reload.

HTML uses the same node generation history shown by media nodes. A history entry contains only `artifact_id`, `version`, and `title`; the source remains in Artifact storage. Selecting a history result changes only that canvas node's `artifactVersion`. It does not create a new Artifact revision, charge for generation, or update another node that references the same Artifact. The Agent action `select_version` has the same behavior. The older Artifact `restore` API remains available for callers that intentionally want to copy historical source into a new revision.
