# HTML Node Generation Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route ordinary HTML node generation through the existing text-generation task while preserving Recipe generation for Skill and Workflow nodes.

**Architecture:** Keep `workflowHtmlRuntime` as the shared coordinator for input resolution, HTML validation, and Artifact persistence. Add a small ordinary-generation adapter that submits `/freezone/text/generate`, waits for its task result, and returns the generated string; select it only when the node has no explicit `workflowCatalog.recipeId`.

**Tech Stack:** React, TypeScript, Vitest, existing Freezone task API and HTML Artifact API.

## Global Constraints

- Do not add or modify backend HTTP interfaces.
- Preserve the `generate_html` node action for manual, Agent, and workflow callers.
- Preserve connected text, media URLs, dimensions, aspect ratios, and duration context.
- Continue to validate complete HTML before creating or updating an Artifact.
- Continue using Recipe generation when `workflowCatalog.recipeId` is explicitly present.

---

### Task 1: Route manual HTML generation through the ordinary text task

**Files:**
- Modify: `frontend/src/features/canvas/application/workflowHtmlRuntime.ts`
- Test: `frontend/src/features/canvas/application/workflowHtmlRuntime.test.ts`

**Interfaces:**
- Consumes: `submitFreezoneTextGenerate(projectId, payload)`, `awaitTaskCompletion(taskKey, projectId, options)`, and `fetchFreezoneTextGenerateResult(projectId, jobId)`.
- Produces: unchanged `executeWorkflowHtmlNode(nodeId, projectId, canvasId): Promise<WorkflowHtmlOutput>` behavior with metadata-based route selection.

- [ ] **Step 1: Write failing routing tests**

Mock the ordinary text task API and assert that a node without `workflowCatalog.recipeId` submits the assembled HTML prompt, awaits the returned task, reads the result, and does not call `generateWorkflowText`. Keep the existing workflow-node fixture and assert the inverse for a node with an explicit Recipe.

```ts
it('uses the ordinary text task for a manually created HTML node', async () => {
  mocks.state.nodes[0].data = {prompt: 'Build a page'};
  await executeWorkflowHtmlNode('page', 'p', 'c');
  expect(mocks.submitText).toHaveBeenCalledWith('p', expect.objectContaining({
    prompt: expect.stringContaining('Build a page'),
    canvasId: 'c',
    nodeId: 'page',
  }));
  expect(mocks.generateRecipe).not.toHaveBeenCalled();
});

it('keeps explicit workflow HTML nodes on Recipe generation', async () => {
  await executeWorkflowHtmlNode('page', 'p', 'c');
  expect(mocks.generateRecipe).toHaveBeenCalledTimes(1);
  expect(mocks.submitText).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd frontend && pnpm test --run src/features/canvas/application/workflowHtmlRuntime.test.ts
```

Expected: the manual-node test fails because the runtime injects `html-page` and calls Recipe generation.

- [ ] **Step 3: Implement the ordinary-generation adapter and route selection**

Build one execution prompt from the existing user prompt, HTML requirements, media JSON, text-reference JSON, and connected text. If an explicit Recipe ID exists, call `generateWorkflowText` exactly as today. Otherwise:

```ts
const ref = await submitFreezoneTextGenerate(projectId, {
  prompt: executionPrompt,
  canvasId,
  nodeId,
});
await awaitTaskCompletion(ref.task_key, projectId, {taskType: ref.task_type});
const result = await fetchFreezoneTextGenerateResult(projectId, ref.job_id);
return result.generated_text;
```

Remove the implicit `{workflowCatalog: {recipeId: 'html-page'}}` fallback. Feed the returned string through the existing Markdown-fence cleanup, complete-document validation, version guard, and Artifact save code.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
cd frontend && pnpm test --run src/features/canvas/application/workflowHtmlRuntime.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit the routing change**

```bash
git add frontend/src/features/canvas/application/workflowHtmlRuntime.ts frontend/src/features/canvas/application/workflowHtmlRuntime.test.ts
git commit -m "fix(html): separate manual generation from recipes"
```

### Task 2: Verify failure and reference behavior

**Files:**
- Modify: `frontend/src/features/canvas/application/workflowHtmlRuntime.test.ts`
- Modify only if a test exposes a defect: `frontend/src/features/canvas/application/workflowHtmlRuntime.ts`

**Interfaces:**
- Consumes: the routing behavior implemented in Task 1.
- Produces: regression coverage for ordinary-task failures, invalid HTML, and connected input context.

- [ ] **Step 1: Add failing edge-case tests**

Add assertions that the ordinary request contains exact connected media URLs, size metadata, mention mappings, and connected text. Add one test returning prose instead of a complete HTML document and assert that Artifact create/save is not called. Add one test rejecting the ordinary task and assert the previous Artifact identity remains unchanged.

```ts
it('rejects invalid ordinary text output before saving an Artifact', async () => {
  mocks.state.nodes[0].data = {prompt: 'Build a page'};
  mocks.fetchText.mockResolvedValueOnce({generated_text: 'Here is your page', model: 'writer'});
  await expect(executeWorkflowHtmlNode('page', 'p', 'c')).rejects.toThrow(/complete HTML/);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test and verify RED where behavior is missing**

Run:

```bash
cd frontend && pnpm test --run src/features/canvas/application/workflowHtmlRuntime.test.ts
```

Expected: any missing prompt-context or failure-preservation behavior fails with the corresponding assertion.

- [ ] **Step 3: Make the smallest correction required by the failing assertions**

Keep prompt assembly in one helper inside `workflowHtmlRuntime.ts`. Do not add retries or a new backend field. Keep Artifact persistence after validation so invalid output cannot be saved.

- [ ] **Step 4: Run focused and adjacent tests**

Run:

```bash
cd frontend && pnpm test --run src/features/canvas/application/workflowHtmlRuntime.test.ts src/features/html-artifacts/HtmlArtifactNode.test.tsx src/features/html-artifacts/commands.test.ts
```

Expected: all selected suites pass.

- [ ] **Step 5: Run TypeScript validation**

Run:

```bash
cd frontend && pnpm exec tsc -b --pretty false
```

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 6: Commit any remaining test or correction changes**

```bash
git add frontend/src/features/canvas/application/workflowHtmlRuntime.ts frontend/src/features/canvas/application/workflowHtmlRuntime.test.ts
git commit -m "test(html): cover ordinary generation failures"
```

