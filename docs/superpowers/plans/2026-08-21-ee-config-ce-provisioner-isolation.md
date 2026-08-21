# EE Config and CE Provisioner Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the shared EE model-gateway config endpoint functional without calling or opening any CE-local settings database.

**Architecture:** Compose the endpoint response by effective edition: CE uses the existing provisioner builder, while EE returns a fixed disabled provisioner contract. Add a defensive guard to the low-level settings reader so accidental EE callers cannot reach SQLite.

**Tech Stack:** Python 3.12, FastAPI, pytest, TestClient, monkeypatch

---

## File map

- Modify `tests/test_model_gateway_settings.py`: add EE route isolation, low-level accessor isolation, and CE route control tests.
- Modify `src/novelvideo/api/routes/model_gateway.py`: add edition-aware provisioner status composition.
- Modify `src/novelvideo/model_gateway_settings.py`: prevent effective EE from calling `_read_all()`.

### Task 1: Add failing EE regression tests

**Files:**
- Modify: `tests/test_model_gateway_settings.py`
- Test: `tests/test_model_gateway_settings.py`

- [ ] **Step 1: Add the route isolation test**

```python
def test_ee_model_gateway_config_skips_ce_provisioner_and_settings(
    monkeypatch,
    tmp_path,
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane")
    monkeypatch.setenv("NEWAPI_BASE_URL", "https://ee-gateway.example/v1")
    monkeypatch.setenv("NEWAPI_API_KEY", "sk-ee-secret")
    monkeypatch.setattr(model_gateway.app_config, "NEWAPI_API_KEY", "sk-ee-secret")
    monkeypatch.setattr(
        model_gateway,
        "build_provisioner_status",
        lambda: pytest.fail("EE must not build CE provisioner status"),
    )
    monkeypatch.setattr(
        model_gateway_settings,
        "_connect",
        lambda: pytest.fail("EE must not open CE settings.db"),
    )
    app = FastAPI()
    app.include_router(model_gateway.router)

    response = TestClient(app).get("/model-gateway/config")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["effective"]["baseUrl"] == "https://ee-gateway.example/v1"
    assert data["provisioner"] == {
        "enabled": False,
        "adminBaseUrl": "",
        "dbConfigured": False,
        "database": {
            "configured": False,
            "available": False,
            "source": "unavailable",
        },
        "adminUsername": "",
        "relayTokenName": "",
        "providers": {},
        "providerChannels": [],
        "mediaModels": {},
        "embeddingModel": {},
        "relayBaseUrl": "",
    }
    assert not (tmp_path / "state").exists()
```

- [ ] **Step 2: Add the low-level defensive-boundary test**

```python
def test_ee_model_gateway_settings_reader_does_not_open_sqlite(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane")
    monkeypatch.setattr(
        model_gateway_settings,
        "_connect",
        lambda: pytest.fail("EE must not open CE settings.db"),
    )

    assert model_gateway_settings.get_model_gateway_settings() == {
        "model_gateway_mode": MODE_OFFICIAL
    }
    assert not (tmp_path / "state").exists()
```

- [ ] **Step 3: Run both tests and verify RED**

Run: `uv run pytest tests/test_model_gateway_settings.py::test_ee_model_gateway_config_skips_ce_provisioner_and_settings tests/test_model_gateway_settings.py::test_ee_model_gateway_settings_reader_does_not_open_sqlite -q`

Expected: the route test fails with `EE must not build CE provisioner status`; the reader test fails with `EE must not open CE settings.db`.

### Task 2: Implement the edition boundaries

**Files:**
- Modify: `src/novelvideo/api/routes/model_gateway.py:476`
- Modify: `src/novelvideo/model_gateway_settings.py:940`
- Test: `tests/test_model_gateway_settings.py`

- [ ] **Step 1: Add edition-aware provisioner status composition**

```python
def _provisioner_status() -> dict[str, Any]:
    if is_ce_effective():
        return build_provisioner_status()
    return {
        "enabled": False,
        "adminBaseUrl": "",
        "dbConfigured": False,
        "database": {
            "configured": False,
            "available": False,
            "source": "unavailable",
        },
        "adminUsername": "",
        "relayTokenName": "",
        "providers": {},
        "providerChannels": [],
        "mediaModels": {},
        "embeddingModel": {},
        "relayBaseUrl": "",
    }
```

Change the route field to:

```python
            "provisioner": _provisioner_status(),
```

- [ ] **Step 2: Add the defensive settings-reader guard**

```python
def get_model_gateway_settings() -> dict[str, str]:
    data = _read_all() if _uses_ce_gateway_settings() else {}
    data.setdefault("model_gateway_mode", MODE_OFFICIAL)
    return data
```

- [ ] **Step 3: Run the new EE tests and verify GREEN**

Run: `uv run pytest tests/test_model_gateway_settings.py::test_ee_model_gateway_config_skips_ce_provisioner_and_settings tests/test_model_gateway_settings.py::test_ee_model_gateway_settings_reader_does_not_open_sqlite -q`

Expected: `2 passed`.

### Task 3: Preserve CE behavior

**Files:**
- Modify: `tests/test_model_gateway_settings.py`
- Test: `tests/test_model_gateway_settings.py`

- [ ] **Step 1: Add a CE control test**

```python
def test_ce_model_gateway_config_uses_provisioner_builder(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    expected = {
        "enabled": True,
        "adminBaseUrl": "http://new-api:3000",
        "dbConfigured": True,
        "database": {"configured": True},
        "adminUsername": "root",
        "relayTokenName": "ce-runtime",
        "providers": {"openrouter": {}},
        "providerChannels": [],
        "mediaModels": {},
        "embeddingModel": {},
        "relayBaseUrl": "http://new-api:3000/v1",
    }
    monkeypatch.setattr(model_gateway, "build_provisioner_status", lambda: expected)
    app = FastAPI()
    app.include_router(model_gateway.router)

    response = TestClient(app).get("/model-gateway/config")

    assert response.status_code == 200
    assert response.json()["data"]["provisioner"] == expected
```

- [ ] **Step 2: Run the CE control test**

Run: `uv run pytest tests/test_model_gateway_settings.py::test_ce_model_gateway_config_uses_provisioner_builder -q`

Expected: PASS.

### Task 4: Verify and publish

**Files:**
- Verify: `src/novelvideo/api/routes/model_gateway.py`
- Verify: `src/novelvideo/model_gateway_settings.py`
- Verify: `tests/test_model_gateway_settings.py`

- [ ] **Step 1: Run focused regression and lint**

Run: `uv run pytest tests/test_model_gateway_settings.py -q`

Expected: all tests pass.

Run: `uv run ruff check src/novelvideo/api/routes/model_gateway.py src/novelvideo/model_gateway_settings.py tests/test_model_gateway_settings.py`

Expected: `All checks passed!`

- [ ] **Step 2: Run repository safety checks**

Run: `git diff --check`

Expected: exit 0.

Run: `gitleaks git --pre-commit --redact --staged --verbose`

Expected: `no leaks found`.

Run: `uv run python scripts/lint_banned_words.py`

Expected: `✓ 无禁用词。`

- [ ] **Step 3: Commit with DCO sign-off**

```bash
git add -- src/novelvideo/api/routes/model_gateway.py src/novelvideo/model_gateway_settings.py tests/test_model_gateway_settings.py
git commit -s -m "fix: isolate EE config from CE provisioner"
```

- [ ] **Step 4: Audit, push, and open a draft PR**

Run: `git log origin/staging..HEAD --format='%h %an <%ae>%n%B%n---'`

Expected: every commit has a matching `Signed-off-by` trailer.

Run: `git push -u origin fix/ee-config-no-ce-provisioner`

Create a draft PR with base `staging`, summarizing the EE route boundary, defensive settings-reader guard, and verification results.
