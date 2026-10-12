# Skill Import Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make three fresh imports complete reliably by replacing copied source quotes with program-owned evidence, retrying one transient request failure, and giving the bounded pipeline enough wall time to finish review.

**Architecture:** A new evidence module owns lossless Markdown segmentation and hydration. The quality pipeline asks models for segment IDs, retains exact source text internally, and uses one shared transient-error classifier around each transport submit. Existing call-count limits remain authoritative while the run deadline becomes 1800 seconds.

**Tech Stack:** Python 3.11+, Pydantic, markdown-it-py, asyncio, pytest/pytest-asyncio, PydanticAI/OpenAI exceptions.

## Global Constraints

- Provider request timeout remains 300 seconds.
- One initial submit plus at most one retry for timeout, connection, HTTP 429, or HTTP 5xx.
- Model-call limit remains 12; matching-call limit remains 4; every transport submit counts.
- Run timeout is 1800 seconds.
- Failed or incomplete content review remains non-installable.
- Evidence text always comes from exact source offsets; never accept a fuzzy paraphrase as a quote.

---

### Task 1: Lossless source evidence

**Files:**
- Create: `src/novelvideo/freezone/skill_import_evidence.py`
- Modify: `pyproject.toml`
- Modify: `uv.lock`
- Modify: `src/novelvideo/freezone/skill_import_retrieval.py`
- Test: `tests/test_skill_import_evidence.py`
- Test: `tests/test_skill_import_retrieval.py`

**Interfaces:**
- Produces: `SourceSegment(id: str, start: int, end: int, text: str, heading_path: list[str])`.
- Produces: `segment_source(source: str) -> list[dict]`.
- Produces: `hydrate_segment_quotes(segment_ids: list[str], segments: list[dict]) -> list[str]`.
- Changes analysis model output to `source_segment_ids: list[str]`; normalized internal tasks retain `source_quotes` populated by the program.

- [ ] **Step 1: Write failing segmentation tests**

Cover exact offsets, deterministic IDs, complete non-whitespace coverage, nested lists, fenced code, tables, HTML/XML blocks, duplicate text, CRLF, backticks/backslashes, Unicode, and a long unbroken line. Assert every segment satisfies `source[start:end] == text`.

- [ ] **Step 2: Run the evidence tests and verify RED**

Run: `uv run pytest tests/test_skill_import_evidence.py -q`
Expected: collection/import failure because `skill_import_evidence` does not exist.

- [ ] **Step 3: Implement the minimal segmenter**

Use markdown-it block token line maps, slice the original source rather than rendered token content, fill every uncovered non-empty range, and split only blocks above 1200 characters at newline/sentence/space boundaries. Assign ordered IDs `S0001`, `S0002`, and retain exact character offsets.

- [ ] **Step 4: Run evidence tests and verify GREEN**

Run: `uv run pytest tests/test_skill_import_evidence.py -q`
Expected: all evidence tests pass.

- [ ] **Step 5: Write failing analysis hydration tests**

Feed a source containing Markdown escapes and a model response containing only `source_segment_ids`. Assert one analysis submit succeeds, exact source quotes are hydrated, unknown IDs fail, and no copied quote is accepted from model output.

- [ ] **Step 6: Run the retrieval tests and verify RED**

Run: `uv run pytest tests/test_skill_import_retrieval.py -q`
Expected: failures because `ProductionTask` still requires model-authored `source_quotes`.

- [ ] **Step 7: Implement analysis evidence hydration**

Add a draft analysis schema that accepts segment IDs, validate one to six unique known IDs per task, hydrate exact quotes, and return the existing normalized `SourceAnalysis` shape to downstream search and generation. Include the evidence algorithm version in the source signature.

- [ ] **Step 8: Run focused tests and commit**

Run: `uv run pytest tests/test_skill_import_evidence.py tests/test_skill_import_retrieval.py tests/test_skill_import_quality.py -q`
Expected: all pass.

Commit: `feat: hydrate skill import evidence from source segments`

### Task 2: Final-review evidence IDs

**Files:**
- Modify: `src/novelvideo/freezone/skill_import_contracts.py`
- Modify: `src/novelvideo/freezone/skill_import_quality.py`
- Test: `tests/test_skill_import_quality.py`

**Interfaces:**
- Model-facing review findings use `source_segment_ids` for blockers.
- Persisted/public review findings retain exact `source_quote` hydrated from source offsets.

- [ ] **Step 1: Write failing review tests**

Return a blocker with a valid segment ID and assert the program writes the exact source quote. Add cases for unknown IDs, empty blocker evidence, advisory findings without evidence, and valid JSON pointers.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `uv run pytest tests/test_skill_import_quality.py -q`
Expected: review payload rejects the new segment-ID shape.

- [ ] **Step 3: Implement review hydration**

Build the review schema from the current segment ID set, validate blocker IDs and bundle pointers, hydrate `source_quote`, and keep advisory behavior unchanged. Supply the ordered source segments to review instead of asking the model to copy an exact quote.

- [ ] **Step 4: Run tests and commit**

Run: `uv run pytest tests/test_skill_import_quality.py -q`
Expected: all pass.

Commit: `fix: preserve exact evidence in skill import reviews`

### Task 3: One bounded transient transport retry

**Files:**
- Modify: `src/novelvideo/freezone/skill_import_budget.py`
- Modify: `src/novelvideo/freezone/skill_import_quality.py`
- Test: `tests/test_skill_import_budget.py`
- Test: `tests/test_skill_import_quality.py`

**Interfaces:**
- Produces: `is_transient_model_error(exc: BaseException) -> bool`.
- The request loop records `contract_attempt` and `transport_attempt`; each call to `ImportBudget.generate` remains one charged submit.

- [ ] **Step 1: Write failing classifier tests**

Assert retryable results for timeout, OpenAI connection/timeout causes, HTTP 429, and HTTP 5xx. Assert false for HTTP 400/401/403, schema `ValueError`, cancellation, and the run-budget timeout.

- [ ] **Step 2: Write failing pipeline retry tests**

Make the first submit raise a retryable timeout and the second return valid JSON. Assert only the current request repeats, prior checkpoints are reused, diagnostics contain both transport attempts, and the budget reports two calls. Assert two transient failures propagate and non-transient failures never retry.

- [ ] **Step 3: Run tests and verify RED**

Run: `uv run pytest tests/test_skill_import_budget.py tests/test_skill_import_quality.py -q`
Expected: transient failures currently terminate after one submit.

- [ ] **Step 4: Implement the classifier and nested retry loop**

Inspect exception types/status codes and chained OpenAI causes rather than matching arbitrary prose. Allow exactly two transport attempts with a short bounded backoff. Keep the existing two contract-correction attempts separate; do not retry cancellation or budget exhaustion.

- [ ] **Step 5: Run tests and commit**

Run: `uv run pytest tests/test_skill_import_budget.py tests/test_skill_import_quality.py -q`
Expected: all retry, accounting, and diagnostics tests pass.

Commit: `fix: retry transient skill import model requests`

### Task 4: Thirty-minute bounded run and regression verification

**Files:**
- Modify: `src/novelvideo/freezone/skill_import_budget.py`
- Test: `tests/test_skill_import_budget.py`

**Interfaces:**
- `RUN_TIMEOUT_SECONDS = 1800`.
- Per-request timeout and call-count APIs remain unchanged.

- [ ] **Step 1: Change the budget assertion to 1800 and verify RED**

Run: `uv run pytest tests/test_skill_import_budget.py::test_default_limits -q`
Expected: failure showing the current value is 900.

- [ ] **Step 2: Set the run timeout to 1800 and verify GREEN**

Run: `uv run pytest tests/test_skill_import_budget.py -q`
Expected: all budget tests pass, including run-deadline cancellation.

- [ ] **Step 3: Run complete relevant regression and static checks**

Run the Skill import, Agent catalog, bundle, API, workflow contract, Ruff, diff-check, pre-commit secret scan, and workflow-agent contract suites used by the preceding branch verification.

Expected: no failures and no secret findings.

- [ ] **Step 4: Commit the budget change**

Commit: `fix: allow skill imports to finish bounded review`

### Task 5: Three fresh real imports and content inspection

**Files:**
- Update: `/tmp/dramaclaw-skill-import-reliability/quality-report.md`
- Generate: `/tmp/dramaclaw-skill-import-reliability/result-{1,2,3}.json`
- Generate: `/tmp/dramaclaw-skill-import-reliability/bundle-{1,2,3}.json`

**Interfaces:**
- Uses the project NewAPI configuration without logging credentials.
- Produces an evidence report with stage timings, attempts, retries, validation status, and manual bundle findings.

- [ ] **Step 1: Start three sequential cold imports**

Create a fresh record ID for each run, do not reuse checkpoints between runs, do not install, and do not invoke media providers. Log stage/request timing and transport-attempt metadata without prompts or secrets.

- [ ] **Step 2: Wait for all three terminal results**

Do not count structure-only output as success. Each result must complete content review with `quality_report.validated=true` and no blockers.

- [ ] **Step 3: Inspect every final bundle against the source**

Check both continuity modes, per-shot confirmation, last-frame validation, character reference layout, scene/prop assets, independent narration/BGM, hard cuts, language, remake start/end inputs, and reused Recipe prohibitions. Record warnings separately from hard conflicts.

- [ ] **Step 4: Report honestly and run final verification**

If any run fails, use the new diagnostics to identify the exact stage and continue debugging before claiming completion. If all pass, report 3 attempts, 3 successes, 0 failures together with timings and residual limitations.

Run final focused pytest, Ruff, `git diff --check`, contract check, and `git status --short` before completion.
