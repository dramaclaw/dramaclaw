# First-Frame Workflow Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `inputs.video_generation_mode = "firstFrame"` through the stable workflow intent contract and compiler so it reaches video nodes as `data.genMode`.

**Architecture:** Define the portable Plan-level video mode vocabulary once in `workflow_schema.py`. Reuse it for both JSON Schema generation and agent catalog validation, while leaving the broader runtime model-capability mapping independent.

**Tech Stack:** Python 3.11+, JSON Schema Draft 2020-12, pytest

## Global Constraints

- Keep provider/model capability validation dynamic and unchanged.
- Do not expose runtime-only `videoEdit` as a portable workflow preference.
- Do not change frontend controls, stored plan formats, or provider model definitions.
- Preserve rejection of unknown video generation modes.

---

## File Structure

- Modify `src/novelvideo/freezone/workflow_schema.py`: own and expose the ordered portable video generation mode tuple; derive the intent JSON Schema enum from it.
- Modify `src/novelvideo/freezone/agent_workflows/catalog.py`: import the shared tuple and validate portable workflow inputs against it.
- Modify `tests/test_workflow_plan.py`: cover schema acceptance and compiler propagation of `firstFrame`.

### Task 1: Share and extend the portable video generation vocabulary

**Files:**
- Modify: `tests/test_workflow_plan.py`
- Modify: `src/novelvideo/freezone/workflow_schema.py:20-35,823-832`
- Modify: `src/novelvideo/freezone/agent_workflows/catalog.py:15-18,1230-1237`

**Interfaces:**
- Produces: `PORTABLE_VIDEO_GENERATION_MODES: tuple[str, ...]` from `novelvideo.freezone.workflow_schema`.
- Consumes: `workflow_intent_json_schema() -> dict[str, Any]` and `compile_workflow_intent(intent: Any) -> dict[str, Any]`.

- [ ] **Step 1: Add a failing JSON Schema regression test**

Add this test near the existing workflow intent schema tests in `tests/test_workflow_plan.py`:

```python
def test_workflow_intent_schema_accepts_first_frame_video_mode():
    Draft202012Validator(workflow_intent_json_schema()).validate(
        {
            "skill_id": "text-to-image-video",
            "user_goal": "根据首帧生成视频",
            "inputs": {"video_generation_mode": "firstFrame"},
        }
    )
```

- [ ] **Step 2: Add a failing compiler propagation regression test**

Add this test near the portable generation input compiler tests in `tests/test_workflow_plan.py`:

```python
def test_compiler_propagates_first_frame_video_mode(monkeypatch):
    catalog = _load_catalog_module()
    _install_real_builtin_catalog(monkeypatch, catalog)

    compiled = catalog.compile_workflow_intent(
        {
            "skill_id": "text-to-image-video",
            "user_goal": "根据首帧生成视频",
            "inputs": {"video_generation_mode": "firstFrame"},
        }
    )

    assert compiled["ok"] is True, compiled
    video_nodes = [
        node for node in compiled["plan"]["nodes"]
        if node["node_type"] == "videoNode"
    ]
    assert video_nodes
    assert all(node["data"]["genMode"] == "firstFrame" for node in video_nodes)
```

- [ ] **Step 3: Run both new tests and verify RED**

Run:

```bash
uv run pytest \
  tests/test_workflow_plan.py::test_workflow_intent_schema_accepts_first_frame_video_mode \
  tests/test_workflow_plan.py::test_compiler_propagates_first_frame_video_mode -q
```

Expected: the schema test fails because `firstFrame` is absent from the enum, and the compiler test fails with `unsupported option: firstFrame`.

- [ ] **Step 4: Define the shared portable mode tuple and use it in the schema**

Add near the other public workflow contract constants in `workflow_schema.py`:

```python
PORTABLE_VIDEO_GENERATION_MODES = (
    "allReference",
    "firstFrame",
    "firstLastFrame",
    "imageReference",
    "imageToVideo",
    "textToVideo",
)
```

Replace the inline `video_generation_mode` enum with:

```python
"video_generation_mode": {
    "type": "string",
    "enum": list(PORTABLE_VIDEO_GENERATION_MODES),
},
```

- [ ] **Step 5: Reuse the shared tuple in catalog validation**

Extend the existing import in `catalog.py`:

```python
from novelvideo.freezone.workflow_schema import (
    PORTABLE_VIDEO_GENERATION_MODES,
    WORKFLOW_INTENT_SCHEMA_VERSION,
    WORKFLOW_PLAN_SCHEMA_VERSION,
)
```

Replace the duplicated `_PORTABLE_VIDEO_GENERATION_MODES` set with:

```python
_PORTABLE_VIDEO_GENERATION_MODES = frozenset(PORTABLE_VIDEO_GENERATION_MODES)
```

- [ ] **Step 6: Run the new tests and verify GREEN**

Run the command from Step 3.

Expected: `2 passed`.

- [ ] **Step 7: Run focused regression suites**

Run:

```bash
uv run pytest tests/test_workflow_plan.py tests/test_workflow_preflight.py -q
```

Expected: all tests pass, including the existing unknown-mode rejection and live model capability checks.

- [ ] **Step 8: Run repository hygiene checks**

Run:

```bash
git diff --check
pre-commit run --all-files
```

Expected: both commands exit successfully with no formatting or secret-scanning failures.

- [ ] **Step 9: Commit the implementation**

```bash
git add \
  src/novelvideo/freezone/workflow_schema.py \
  src/novelvideo/freezone/agent_workflows/catalog.py \
  tests/test_workflow_plan.py
git commit -m "fix(freezone): support first-frame workflow mode"
```

