"""Drive voice-design pages against an isolated deployment with Playwright.

Default checks never submit generation. --candidate-evidence replays the exact
already completed API operation, so browser verification does not spend again.
Unsupported or unexecuted cases fail explicitly; screenshots are not PASS.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import traceback
import subprocess
from urllib.parse import quote
from uuid import uuid4

from playwright.sync_api import BrowserContext, Page, expect, sync_playwright
import httpx

from voice_design import digest, require_local, self_check, write_json

ALL_CASES = tuple(f"U{number:02}" for number in range(1, 13))


def login(context: BrowserContext, base_url: str) -> None:
    # Normal login endpoints establish HttpOnly cookies. The profile marker is
    # the same optimistic routing state written by the login forms, not a token.
    username = os.environ.get("VOICE_DESIGN_TEST_USERNAME", "")
    password = os.environ.get("VOICE_DESIGN_TEST_PASSWORD", "")
    if username and password:
        response = context.request.post(f"{base_url}/api/v1/auth/login", data={"username": username, "password": password})
        if response.status != 200:
            raise RuntimeError(f"product login HTTP {response.status}")
        profile = response.json()["data"]
        marker = {"username": profile["username"], "displayName": profile["username"], "role": profile["role"]}
        context.add_init_script("localStorage.setItem('supertale-auth', " + json.dumps(json.dumps({"state": marker, "version": 0})) + ")")


def prepare_fixtures(context: BrowserContext, args: argparse.Namespace) -> dict:
    if not args.test_gateway_url:
        raise ValueError("fixture preparation requires the non-forwarding deterministic gateway")
    response = context.request.get(f"{args.admin_base_url}/admin/feature-credit-prices")
    prices = response.json()
    if not any(price["feature_key"] == "freezone.audio_speech" for price in prices):
        response = context.request.post(f"{args.admin_base_url}/admin/feature-credit-prices", data={
            "feature_key": "freezone.audio_speech", "label": "S5 deterministic speech", "unit": "character",
            "params": {"unit_chars": 100}, "unit_cost": 1, "enabled": True,
        })
        if response.status != 200:
            raise RuntimeError(f"fixture speech price HTTP {response.status}")
    tag = uuid4().hex[:10]
    username, password = f"s5c11_{tag}", uuid4().hex
    response = context.request.post(f"{args.admin_base_url}/admin/users", data={
        "username": username, "password": password, "role": "worker", "initial_credits": 1000,
    })
    if response.status != 200:
        raise RuntimeError(f"fixture user HTTP {response.status}")
    user_id = response.json()["id"]
    response = context.request.post(f"{args.base_url}/api/v1/auth/login", data={"username": username, "password": password})
    if response.status != 200:
        raise RuntimeError(f"fixture login HTTP {response.status}")
    context.add_init_script("localStorage.setItem('supertale-auth', " + json.dumps(json.dumps({"state": {"username": username, "displayName": username, "role": "worker"}, "version": 0})) + ")")
    response = context.request.post(f"{args.base_url}/api/v1/projects", data={"name": f"s5_c11_{tag}"})
    if response.status != 200 or response.json().get("ok") is not True:
        raise RuntimeError(f"fixture project HTTP {response.status}")
    args.project = response.json()["data"]["project_id"]
    args.fixture_username = username
    args.fixture_project_name = f"s5_c11_{tag}"
    args.character = f"S5验收{tag}"
    response = context.request.post(f"{args.base_url}/api/v1/projects/{args.project}/characters", data={
        "name": args.character, "role": "supporting", "gender": "male", "age_group": "elder",
    })
    if response.status != 200 or response.json().get("ok") is not True:
        raise RuntimeError(f"fixture character HTTP {response.status}")
    return {"project": args.project, "character": args.character, "username": username, "user_id": user_id}


def run_u12(browser, args):
    """Exercise local platform/organization pricing without any generation request.

    Uses a supplied browser storage state for the platform session.
    Organization and member sessions start without inherited browser state.
    Every invocation creates its own organization, users, and projects.
    The global feature price is restored in finally; caller coordinates its window.
    """
    import json
    import os
    from pathlib import Path
    import secrets
    from urllib.parse import urlsplit
    from uuid import uuid4

    from playwright.sync_api import expect

    base = args.base_url.rstrip("/")
    admin_base = args.admin_base_url.rstrip("/")
    for address in (base, admin_base):
        if urlsplit(address).hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("U12 only permits a local isolated deployment")
    artifacts = Path(args.artifacts_dir)
    artifacts.mkdir(parents=True, exist_ok=True)
    contexts = []
    submissions = []
    tag = uuid4().hex[:10]
    password = secrets.token_urlsafe(24)
    fixture = {
        "org_name": "s5u12_" + tag,
        "admin": "s5u12a_" + tag,
        "member": "s5u12m_" + tag,
        "standalone": "s5u12p_" + tag,
        "character": "U12验收" + tag,
    }
    evidence = {"status": "running", "fixture": fixture, "assertions": []}

    def write_evidence():
        path = artifacts / "U12-evidence.json"
        path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        path.chmod(0o600)

    def api(context, method, path, body=None, *, admin=False, idempotent=False):
        if method != "GET" and ("/voice-design/" in path or "/beats/" in path):
            raise RuntimeError("U12 forbids generation requests")
        headers = {"Idempotency-Key": "u12-" + uuid4().hex} if idempotent else {}
        response = context.request.fetch(
            (admin_base if admin else base) + path, method=method, data=body, headers=headers
        )
        if not response.ok:
            raise RuntimeError(f"U12 {method} {path} HTTP {response.status}")
        return response.json() if response.body() else None

    def new_context(username=None):
        context = browser.new_context(
            locale="zh-CN", viewport={"width": 1400, "height": 1100},
            storage_state=args.storage_state if username is None else None,
        )
        context.add_init_script("localStorage.setItem('i18nextLng','zh-CN')")
        contexts.append(context)

        def guard(route):
            if route.request.method == "POST":
                submissions.append(route.request.url)
                route.abort("blockedbyclient")
            else:
                route.continue_()

        context.route("**/voice-design/candidates", guard)
        names = (
            "VOICE_DESIGN_TEST_USERNAME",
            "VOICE_DESIGN_TEST_PASSWORD",
        )
        previous = {name: os.environ.get(name) for name in names}
        try:
            os.environ["VOICE_DESIGN_TEST_USERNAME"] = username or ""
            os.environ["VOICE_DESIGN_TEST_PASSWORD"] = password if username else ""
            login(context, base)
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
        return context

    def quote(context, project, catalog_id):
        return api(context, "GET", f"/api/v1/projects/{project}/voice-design/quote?surface=supertale&catalog_id={catalog_id}")

    def open_price(page, path, all_tab=False):
        page.goto(admin_base + path)
        if all_tab:
            page.get_by_role("button", name="全部", exact=True).click()
        row = page.get_by_role("row").filter(has_text="audio.voice_design")
        expect(row).to_be_visible()
        row.get_by_role("button", name="编辑", exact=True).click()
        return page.get_by_role("dialog")

    try:
        platform = new_context()
        created = api(
            platform,
            "POST",
            "/admin/orgs",
            {
                "name": fixture["org_name"],
                "initial_credits": 1000,
                "first_admin": {
                    "mode": "create",
                    "username": fixture["admin"],
                    "password": password,
                },
            },
            admin=True,
            idempotent=True,
        )
        fixture["org_id"] = created["org_id"]
        for key in ("member", "standalone"):
            user = api(
                platform,
                "POST",
                "/admin/users",
                {
                    "username": fixture[key],
                    "password": password,
                    "role": "worker",
                    "initial_credits": 0 if key == "member" else 100,
                },
                admin=True,
            )
            fixture[key + "_id"] = user["id"]
        api(
            platform,
            "POST",
            f"/admin/orgs/{fixture['org_id']}/members",
            {"mode": "existing", "user_id": fixture["member_id"], "initial_credits": 100},
            admin=True,
            idempotent=True,
        )
        org_context = new_context(fixture["admin"])
        member_context = new_context(fixture["member"])
        standalone = new_context(fixture["standalone"])
        for context, key in ((member_context, "project"), (standalone, "standalone_project")):
            created = api(context, "POST", "/api/v1/projects", {"name": "s5u12_" + key + "_" + tag})
            fixture[key] = created["data"]["project_id"]
        api(
            member_context,
            "POST",
            f"/api/v1/projects/{fixture['project']}/characters",
            {
                "name": fixture["character"],
                "role": "supporting",
                "gender": "male",
                "age_group": "elder",
            },
        )
        models = api(member_context, "GET", f"/api/v1/projects/{fixture['project']}/voice-design/models")["data"]["models"]
        assert {model["model"] for model in models} == {"voice-enrollment", "qwen-voice-design", "seed-audio-1.0"}
        initial = {model["catalog_id"]: quote(member_context, fixture["project"], model["catalog_id"])["data"] for model in models}
        evidence["organization_initial_quotes"] = initial
        org_page = org_context.new_page()
        form = open_price(org_page, "/org-admin/pricing", all_tab=True)
        for index, model in enumerate(models):
            form.get_by_role("spinbutton", name=re.compile("^" + re.escape(model["label"]) + " ")).fill(str(7 + index))
        with org_page.expect_response(lambda r: "/org/admin/feature-prices" in r.url and r.request.method in {"POST", "PUT"}) as saved:
            form.get_by_role("button", name="保存", exact=True).click()
        assert saved.value.status == 200
        evidence["organization_saved_price"] = saved.value.json()
        expect(form).not_to_be_visible()
        evidence["organization_page_alerts"] = org_page.get_by_role("alert").all_text_contents()
        assert not evidence["organization_page_alerts"], "organization pricing page contains a read error"
        evidence["organization_quotes"] = {}
        for index, model in enumerate(models):
            result = quote(member_context, fixture["project"], model["catalog_id"])["data"]
            assert result["cost"] == 7 + index and result["model"] == model
            evidence["organization_quotes"][model["catalog_id"]] = result
        org_page.screenshot(path=str(artifacts / "U12-organization-price.png"), full_page=True)
        evidence["assertions"].append("organization All UI saves distinct catalog prices; each real project quote keeps its catalog/model snapshot")
        prices = api(platform, "GET", "/admin/feature-credit-prices", admin=True)
        original = next(row for row in prices if row["feature_key"] == "audio.voice_design")
        original_body = {key: original[key] for key in ("feature_key", "label", "params", "unit", "unit_cost", "enabled", "media_model_prices")}
        evidence["original_platform_price"] = original_body
        try:
            platform_page = platform.new_page()
            form = open_price(platform_page, "/feature-credits")
            for index, model in enumerate(models):
                form.get_by_role("spinbutton", name=re.compile("^" + re.escape(model["label"]) + " ")).fill(str(11 + index))
            with platform_page.expect_response(lambda r: "/admin/feature-credit-prices/" in r.url and r.request.method == "PUT") as saved:
                form.get_by_role("button", name="保存", exact=True).click()
            assert saved.value.status == 200
            evidence["platform_saved_price"] = saved.value.json()
            expect(form).not_to_be_visible()
            for index, model in enumerate(models):
                assert quote(standalone, fixture["standalone_project"], model["catalog_id"])["data"]["cost"] == 11 + index
                assert quote(member_context, fixture["project"], model["catalog_id"])["data"]["cost"] == 7 + index
            platform_page.screenshot(path=str(artifacts / "U12-platform-all-price.png"), full_page=True)
        finally:
            restored = api(platform, "PUT", "/admin/feature-credit-prices/" + original["id"], original_body, admin=True)
            assert {(row["catalog_id"], row["unit_cost"], row["enabled"]) for row in restored["media_model_prices"]} == {(row["catalog_id"], row["unit_cost"], row["enabled"]) for row in original["media_model_prices"]}
        for model in models:
            assert quote(standalone, fixture["standalone_project"], model["catalog_id"])["data"]["cost"] == initial[model["catalog_id"]]["cost"]
        evidence["assertions"].append("platform All UI per-catalog prices affect standalone quotes; organization overrides win; all original platform tiers restored")
        product = member_context.new_page()
        product.goto(base + f"/projects/{fixture['project']}/characters")
        product.get_by_text(fixture["character"], exact=True).first.click()
        product.get_by_role("button", name="按描述生成", exact=True).first.click()
        voice = product.get_by_role("dialog", name="按描述生成声线")
        selected = models[0]
        selector = voice.get_by_role("combobox", name="生成模型", exact=True)
        selector.click()
        product.get_by_role("option", name=selected["label"], exact=True).click()
        expect(selector.locator('[data-slot="select-value"]')).to_have_text(selected["label"])
        voice.get_by_label("音色描述", exact=True).fill("沉稳清晰的男性声音，稍慢语速")
        voice.get_by_label("试听文本", exact=True).fill("今天的天气很好，我们沿着河边慢慢走回家。")
        expect(voice.get_by_role("button", name="生成试听", exact=True)).to_be_enabled()
        expect(voice.get_by_text("本次生成：7 积分 / 次", exact=True)).to_be_visible()
        org_models = api(platform, "GET", f"/admin/orgs/{fixture['org_id']}/media-models?media_type=audio", admin=True)
        design = next(row for row in org_models if row["catalog_id"] == selected["catalog_id"])
        api(platform, "PUT", f"/admin/orgs/{fixture['org_id']}/media-models/{design['catalog_id']}", {"visibility": "disabled", "expected_version": design["version"]}, admin=True)
        response = member_context.request.get(base + f"/api/v1/projects/{fixture['project']}/voice-design/quote?surface=supertale&catalog_id={selected['catalog_id']}")
        assert response.status == 503
        evidence["disabled_quote"] = response.json()
        remaining = api(member_context, "GET", f"/api/v1/projects/{fixture['project']}/voice-design/models")["data"]["models"]
        evidence["remaining_models"] = remaining
        assert {model["catalog_id"] for model in remaining} == {model["catalog_id"] for model in models[1:]}
        product.wait_for_timeout(31000)
        member_context.set_offline(True)
        member_context.set_offline(False)
        expect(voice.get_by_role("button", name="生成试听", exact=True)).to_be_disabled(timeout=15000)
        expect(selector.locator('[data-slot="select-value"]')).to_have_text("所选模型已不可用，仍可试听和保存已有候选。")
        product.screenshot(path=str(artifacts / "U12-model-disabled.png"), full_page=True)
        selector.click()
        product.get_by_role("option", name=remaining[0]["label"], exact=True).click()
        expect(selector.locator('[data-slot="select-value"]')).to_have_text(remaining[0]["label"])
        expect(voice.get_by_role("button", name="生成试听", exact=True)).to_be_enabled()
        assert not submissions, "U12 attempted a generation submission"
        evidence["generation_submissions"] = len(submissions)
        evidence["assertions"].append("single catalog disable rejects its quote, retains other models; reconnect refresh disables invalid selection without fallback; explicit valid selection recovers; zero generation submissions")
        evidence["status"] = "passed"
        write_evidence()
        return evidence["assertions"]
    except Exception as error:
        evidence["status"] = "failed"
        evidence["error_type"] = type(error).__name__
        write_evidence()
        raise
    finally:
        for context in contexts:
            context.close()


class Acceptance:
    def __init__(self, page: Page, args: argparse.Namespace):
        self.page, self.args = page, args
        self.submissions = 0
        self.candidate_ids: list[str] = []
        self.ready = None
        self.slot_before = None
        self.drop_next_create = False
        self.create_bodies = {}
        self.quotes = {}
        if args.test_gateway_url:
            deployed = json.loads(args.deployment_env.read_text()) if args.deployment_env else {}
            gateway = require_local(args.test_gateway_url)
            if deployed.get("NEWAPI_BASE_URL") != gateway + "/v1" or deployed.get("VOICE_DESIGN_TEST_REPLAY") != "1":
                raise ValueError("deterministic requests require matching isolated deployment configuration")
            for role in ("product", "worker"):
                pid = int((args.deployment_env.parent / f"{role}.pid").read_text())
                # Inspect only in memory; process environments contain secrets.
                running = subprocess.check_output(["ps", "eww", "-p", str(pid), "-o", "command="], text=True)
                actual = re.search(r"(?:^|\s)NEWAPI_BASE_URL=([^\s]+)", running)
                edition = re.search(r"(?:^|\s)ST_EDITION=([^\s]+)", running)
                replay = re.search(r"(?:^|\s)VOICE_DESIGN_TEST_REPLAY=([^\s]+)", running)
                if not actual or actual.group(1) != gateway + "/v1" or not edition or edition.group(1) != "ee" or not replay or replay.group(1) != "1":
                    raise RuntimeError(f"{role} is not running the isolated EE test gateway configuration")
            marker = httpx.get(gateway + "/healthz").json()
            if marker.get("kind") != "voice-design-deterministic":
                raise ValueError("expected the non-forwarding deterministic gateway")
        self.replay = json.loads(args.candidate_evidence.read_text())["candidate"] if args.candidate_evidence else None
        if self.replay and self.replay["status"] != "ready":
            raise ValueError("candidate evidence must contain a ready operation")
        page.route("**/voice-design/candidates", self.guard_generation)

    def guard_generation(self, route) -> None:
        if route.request.method != "POST":
            route.continue_()
            return
        self.submissions += 1
        body = route.request.post_data_json
        self.candidate_ids.append(body["request_id"])
        if self.args.test_gateway_url:
            expected = self.model_snapshot(body["catalog_id"])
            if body["config_digest"] != expected["config_digest"]:
                raise AssertionError("create digest differs from model/quote snapshot")
            self.create_bodies[body["request_id"]] = body
        if self.args.test_gateway_url:
            if self.drop_next_create:
                self.drop_next_create = False
                route.fetch()
                route.abort("failed")
                return
            route.continue_()
            return
        if not self.replay:
            route.abort("blockedbyclient")
            return
        # The server checks the persisted request digest; changing the source or
        # input cannot turn this replay into a second model request.
        body = route.request.post_data_json
        model = self.replay.get("model")
        if model is None:
            route.abort("blockedbyclient")
            raise RuntimeError("historical candidate without a model snapshot is GET-only")
        body.update(catalog_id=model["catalog_id"], config_digest=model["config_digest"], request_id=self.replay["candidate_id"], description=self.replay["description"],
                    preview_text=self.replay["preview_text"], language=self.replay["language"], surface="supertale")
        route.continue_(post_data=json.dumps(body), headers=route.request.headers | {"content-type": "application/json"})

    def gateway(self, mode: str | None = None) -> dict:
        if not self.args.test_gateway_url:
            raise RuntimeError("this branch requires the isolated deterministic gateway")
        if mode:
            httpx.post(self.args.test_gateway_url + "/control", json={"mode": mode}).raise_for_status()
        return httpx.get(self.args.test_gateway_url + "/healthz").json()

    def api(self, suffix: str):
        return self.page.context.request.get(f"{self.args.base_url}/api/v1/projects/{quote(self.args.project, safe='')}{suffix}")

    def samples(self):
        response = self.api(f"/characters/{quote(self.args.character, safe='')}/voice-samples")
        if response.status != 200:
            raise RuntimeError(f"voice samples HTTP {response.status}")
        return response.json()["data"]["slots"]

    def models(self):
        response = self.api("/voice-design/models")
        if response.status != 200:
            raise RuntimeError(f"model list HTTP {response.status}")
        return response.json()["data"]["models"]

    def model_snapshot(self, catalog_id):
        return next(model for model in self.models() if model["catalog_id"] == catalog_id)

    def select_model(self, dialog, catalog_id):
        selector = dialog.get_by_role("combobox", name="生成模型", exact=True)
        expect(selector).to_be_enabled()
        selected = self.model_snapshot(catalog_id)
        selector.click()
        self.page.get_by_role("option", name=selected["label"], exact=True).click()
        expect(selector.locator('[data-slot="select-value"]')).to_have_text(selected["label"])
        quote_url = "/voice-design/quote?surface=supertale&catalog_id=" + quote(catalog_id, safe="")
        response = self.api(quote_url)
        if response.status != 200:
            raise RuntimeError(f"selected quote HTTP {response.status}")
        self.quotes[catalog_id] = response.json()["data"]
        snapshot = self.quotes[catalog_id]["model"]
        if snapshot != self.model_snapshot(catalog_id):
            raise AssertionError("model list and quote differ")
        expect(dialog.get_by_text("本次请求模型：" + snapshot["model"], exact=True)).to_be_visible()
        return snapshot

    def assert_model_menu(self, dialog, width):
        selector = dialog.get_by_role("combobox", name="生成模型", exact=True)
        models = self.models()
        original = next(model for model in models if model["label"] == selector.locator('[data-slot="select-value"]').inner_text())
        selector.click()
        menu = self.page.get_by_role("listbox")
        expect(menu).to_be_visible()
        expect(menu.get_by_role("option")).to_have_count(len(models))
        for model in models:
            expect(menu.get_by_role("option", name=model["label"], exact=True)).to_be_visible()
        popup = self.page.locator('[data-slot="select-content"][data-open]')
        popup.evaluate("e => Promise.all(e.getAnimations().map(animation => animation.finished))")
        trigger_box = selector.bounding_box()
        menu_box = popup.bounding_box()
        font_size = self.page.get_by_role("option").first.evaluate("e => getComputedStyle(e).fontSize")
        assert trigger_box and menu_box
        assert abs(menu_box["width"] - trigger_box["width"]) <= 1, {"trigger": trigger_box, "menu": menu_box}
        assert 0 <= menu_box["x"] and menu_box["x"] + menu_box["width"] <= width
        assert trigger_box["y"] + trigger_box["height"] <= menu_box["y"] <= trigger_box["y"] + trigger_box["height"] + 8
        assert font_size == "12px"
        assert not self.page.evaluate("document.documentElement.scrollWidth > innerWidth")
        self.page.screenshot(path=str(self.args.artifacts_dir / f"U10-model-menu-{width}.png"))
        self.page.keyboard.press("Escape")
        expect(menu).not_to_be_visible()
        expect(dialog).to_be_visible()
        expect(selector).to_be_focused()
        selector.press("ArrowDown")
        expect(menu).to_be_visible()
        expect(menu.get_by_role("option", name=original["label"], exact=True)).to_be_focused()
        self.page.keyboard.press("End")
        expect(menu.get_by_role("option", name=models[-1]["label"], exact=True)).to_be_focused()
        self.page.keyboard.press("Enter")
        expect(selector.locator('[data-slot="select-value"]')).to_have_text(models[-1]["label"])
        expect(menu).not_to_be_visible()
        self.select_model(dialog, original["catalog_id"])
        return {"viewport_width": width, "trigger": trigger_box, "menu": menu_box, "option_font_size": font_size, "keyboard_selection_and_escape": True}

    def assert_metadata(self, dialog):
        self.page.wait_for_function("""() => {
            const a = document.querySelector('audio[aria-label="生成的试听音频"]');
            return a && Number.isFinite(a.duration) && a.duration > 0 && a.readyState >= 1
                && a.paused && a.currentTime === 0;
        }""")
        return dialog.get_by_label("生成的试听音频", exact=True).evaluate("a => ({duration:a.duration, readyState:a.readyState, paused:a.paused, currentTime:a.currentTime})")

    def fill(self, dialog, description="沉稳清晰的男性声音，稍慢语速") -> None:
        dialog.get_by_label("音色描述", exact=True).fill(description)
        dialog.get_by_label("试听文本", exact=True).fill("今天的天气很好，我们沿着河边慢慢走回家。")

    def generate(self, dialog, *, success=True):
        with self.page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith("/voice-design/candidates")) as response:
            dialog.get_by_role("button", name=re.compile("^(生成试听|重新生成)$")).click()
        if response.value.status not in {200, 202}:
            raise RuntimeError(f"generation HTTP {response.value.status}")
        candidate_id = response.value.json()["data"]["candidate_id"]
        candidate = self.settled(candidate_id)
        if success:
            expect(dialog.get_by_role("button", name="播放试听", exact=True)).to_be_enabled(timeout=20000)
            if candidate["status"] != "ready":
                raise AssertionError("candidate did not become ready")
            self.ready = candidate
        else:
            if candidate["status"] not in {"failed", "unknown"}:
                raise AssertionError("expected a terminal generation failure")
            expect(dialog.get_by_role("alert")).to_be_visible(timeout=20000)
        return candidate_id

    def settled(self, candidate_id):
        deadline = time.monotonic() + 25
        while True:
            candidate = self.api(f"/voice-design/candidates/{candidate_id}").json()["data"]
            if candidate["status"] != "generating":
                return candidate
            if time.monotonic() >= deadline:
                raise TimeoutError("candidate did not settle")
            self.page.wait_for_timeout(200)

    def characters(self) -> None:
        self.page.goto(f"{self.args.base_url}/projects/{quote(self.args.project, safe='')}/characters")
        expect(self.page.get_by_text(self.args.character, exact=True).first).to_be_visible()
        self.page.get_by_text(self.args.character, exact=True).first.click()
        expect(self.page.get_by_role("button", name="按描述生成", exact=True).first).to_be_enabled(timeout=15000)

    def open_voice(self, index: int = 0):
        self.page.get_by_role("button", name="按描述生成", exact=True).nth(index).click()
        dialog = self.page.get_by_role("dialog", name="按描述生成声线")
        expect(dialog).to_be_visible()
        return dialog

    def close_voice(self) -> None:
        self.page.get_by_role("dialog", name="按描述生成声线").get_by_role("button", name="关闭", exact=True).click()

    def U01(self) -> list[str]:
        expected = (
            ("幼年（可选覆盖）", "child", "幼年"),
            ("青年（可选覆盖）", "youth", "青年"),
            ("中年（可选覆盖）", "middle", "中年"),
            ("老年（默认 · 必填）", "default", "默认（兜底）"),
        )
        original_character = self.args.character
        self.args.character = original_character + "-U01"
        response = self.page.context.request.post(
            f"{self.args.base_url}/api/v1/projects/{self.args.project}/characters",
            data={"name": self.args.character, "role": "supporting", "gender": "male", "age_group": "elder"},
        )
        if response.status != 200 or response.json().get("ok") is not True:
            self.args.character = original_character
            raise RuntimeError("could not create the isolated U01 character")
        try:
            self.characters()
            entries = self.page.get_by_role("button", name="按描述生成", exact=True)
            expect(entries).to_have_count(len(expected))
            labels = []
            evidence = []
            for index, (age_label, action_slot, action_label) in enumerate(expected):
                card = entries.nth(index).locator("../..")
                expect(card.get_by_text(age_label, exact=True)).to_be_visible()
                expect(card.get_by_role("button", name="上传声音样本", exact=True)).to_be_enabled()
                expect(card.get_by_role("button", name="录音", exact=True)).to_be_enabled()
                dialog = self.open_voice(index)
                expect(dialog.locator('[data-slot="dialog-description"]')).to_have_text(
                    f"保存位置：{self.args.character} · {action_label}"
                )
                save = dialog.get_by_role("button", name=f"保存到{action_label}", exact=True)
                expect(save).to_be_disabled()
                self.fill(dialog)
                self.gateway("success")
                candidate_id = self.generate(dialog)
                before = self.samples()
                with self.page.expect_response(lambda response: response.request.method == "POST" and "/voice-samples/" in response.url and response.url.endswith("/save-generated")) as saved:
                    save.click()
                response = saved.value
                expected_path = f"/characters/{quote(self.args.character, safe='')}/voice-samples/{action_slot}/save-generated"
                if response.status != 200 or not response.url.endswith(expected_path):
                    raise AssertionError(f"{age_label} submitted the wrong actionSlot; expected {action_slot}")
                body = response.request.post_data_json
                if body["candidate_id"] != candidate_id or body["replace_existing"] is not False:
                    raise AssertionError("card save changed its candidate or replacement policy")
                actual = response.json()["data"]
                if actual["slot"] != action_slot or actual["sha256"] != self.ready["sha256"]:
                    raise AssertionError("actual saved slot/SHA differs from the card action")
                expect(dialog).not_to_be_visible()
                after = self.samples()
                for old in before:
                    if old["slot"] != action_slot:
                        current = next(slot for slot in after if slot["slot"] == old["slot"])
                        if any(current[key] != old[key] for key in ("path", "sha256", "updated_at")):
                            raise AssertionError("card save changed a non-target slot")
                evidence.append({"age_label": age_label, "actionSlot": action_slot, "request": body, "save": actual})
                labels.append(f"{age_label}; dialog actionSlot={action_slot}; actual save.slot={actual['slot']}")
            write_json(self.args.artifacts_dir / "U01-card-slots.json", {"cards": evidence})
            return labels
        finally:
            self.args.character = original_character

    def canvas(self) -> None:
        page = self.page
        page.goto(f"{self.args.base_url}/projects/{self.args.project}/freezone")
        page.get_by_role("button", name="添加节点", exact=True).click()
        page.get_by_role("button", name="音频", exact=True).click()
        node = page.locator(".react-flow__node-audioNode").first
        expect(node).to_be_attached()
        self.node_id = node.get_attribute("data-id")
        if page.get_by_role("button", name="回到节点", exact=True).is_visible():
            page.get_by_role("button", name="回到节点", exact=True).click()
        node.click()

    def node_data(self):
        return self.page.evaluate("async id => { const { useCanvasStore } = await import('/src/stores/canvasStore.ts'); return useCanvasStore.getState().nodes.find(n => n.id === id).data; }", self.node_id)

    def voice_picker(self, entry: str):
        page = self.page
        if entry == "node":
            # Exercise the public node action consumed by the real AudioNode.
            node = page.locator(f'.react-flow__node[data-id="{self.node_id}"]')
            node.click()
            if self.node_data().get("voiceRef"):
                page.evaluate("async id => { const { dispatchNodeAction } = await import('/src/features/canvas/application/nodeActionResult.ts'); dispatchNodeAction({nodeId:id, action:'open_voice_picker', parameters:{initialTab:'mine'}, requestId:crypto.randomUUID()}); }", self.node_id)
            else:
                node.get_by_role("button", name="选择声线", exact=True).click()
        elif entry == "panel":
            page.locator(f'.react-flow__node[data-id="{self.node_id}"]').click()
            page.get_by_title("音色设置", exact=True).click()
            page.get_by_title("选择声线", exact=True).click()
        elif entry == "board":
            page.get_by_role("button", name="故事板", exact=True).click()
            page.get_by_role("button", name="音频1", exact=True).last.click()
            page.get_by_role("button", name=re.compile("^(选择|更换)自定义声线$")).click()
        else:
            raise ValueError(entry)
        expect(page.get_by_role("heading", name="音色选择", exact=True)).to_be_visible()
        page.get_by_role("button", name="我的音色", exact=True).click()

    def close_picker(self, entry: str):
        self.page.get_by_title("关闭", exact=True).click()
        if entry == "board":
            self.page.get_by_role("button", name="工作流", exact=True).click()

    def canvas_entries(self, *, empty: bool) -> None:
        for entry in ("node", "panel", "board"):
            self.voice_picker(entry)
            if empty:
                expect(self.page.get_by_text("暂无可用音色，快去克隆你的新音色吧～", exact=True)).to_be_visible()
            else:
                expect(self.page.get_by_text(self.account_voice_name, exact=True).last).to_be_visible()
            self.page.get_by_role("button", name="按描述生成", exact=True).click()
            dialog = self.page.get_by_role("dialog", name="按描述生成声线")
            expect(dialog.get_by_label("音色名称", exact=True)).to_be_visible()
            self.page.screenshot(path=str(self.args.artifacts_dir / f"U02-{entry}-{'empty' if empty else 'nonempty'}.png"))
            self.close_voice()
            self.close_picker(entry)

    def U02(self) -> list[str]:
        self.canvas()
        self.canvas_entries(empty=True)
        return ["empty my-voices: real AudioNode action, operations panel and asset-board entry open shared account dialog; nonempty repeat is U08"]

    def U03(self) -> list[str]:
        self.characters()
        dialog = self.open_voice()
        description = dialog.get_by_label("音色描述", exact=True)
        preview = dialog.get_by_label("试听文本", exact=True)
        generate = dialog.get_by_role("button", name=re.compile("^(生成试听|重新生成)$"))
        before = self.submissions
        for text, sample in (("", "中" * 15), ("中" * 501, "中" * 15), ("中", "中" * 14), ("中", "中" * 61)):
            description.fill(text)
            preview.fill(sample)
            expect(generate).to_be_disabled()
        description.fill("😀" * 500)
        preview.fill("😀" * 15)
        expect(dialog.get_by_text("500/500", exact=True)).to_be_visible()
        expect(dialog.get_by_text("15/60", exact=True)).to_be_visible()
        expect(generate).to_be_enabled()
        preview.fill("中" * 60)
        expect(generate).to_be_enabled()
        if self.submissions != before:
            raise AssertionError("invalid form sent a generation request")
        self.close_voice()
        return ["invalid lengths disabled; Unicode counts and valid 500/15/60 boundaries; zero generation requests"]

    def U04(self) -> list[str]:
        self.characters()
        self.slot_before = self.samples()
        dialog = self.open_voice()
        models = self.models()
        if {model["model"] for model in models} != {"voice-enrollment", "qwen-voice-design", "seed-audio-1.0"}:
            raise AssertionError("expected all three design models and no ordinary speech")
        snapshots = []
        for model in models:
            selected = self.select_model(dialog, model["catalog_id"])
            self.fill(dialog)
            before = self.gateway("slow")["calls"]
            generate = dialog.get_by_role("button", name=re.compile("^(生成试听|重新生成)$"))
            generate.click()
            expect(dialog.get_by_text("正在生成，关闭弹窗不会取消任务。", exact=True)).to_be_visible()
            expect(generate).to_be_disabled()
            expect(dialog.get_by_role("combobox", name="生成模型", exact=True)).to_be_disabled()
            expect(dialog.get_by_role("button", name=re.compile("^保存到"))).to_be_disabled()
            expect(dialog.get_by_role("button", name="播放试听", exact=True)).to_be_enabled(timeout=20000)
            candidate_id = self.last_candidate_id()
            self.ready = self.settled(candidate_id)
            if self.ready["status"] != "ready" or self.ready["model"] != selected:
                raise AssertionError("candidate snapshot differs from models/quote")
            submitted = self.create_bodies[candidate_id]
            if (submitted["catalog_id"], submitted["config_digest"]) != (selected["catalog_id"], selected["config_digest"]):
                raise AssertionError("create did not freeze selected catalog/digest")
            gateway = self.gateway()
            if gateway["calls"] != before + 1:
                raise AssertionError("duplicate upstream generation")
            upstream = gateway["requests"][-1]
            if upstream["model"] != selected["model"]:
                raise AssertionError("gateway executed a different model")
            if selected["mode"] == "resource":
                if upstream["endpoint"] != "/v1/audio/voice-designs" or upstream["target_model"] != selected["target_model"]["model"]:
                    raise AssertionError("resource target/endpoint differs from snapshot")
                if upstream["voice_prompt"] != submitted["description"] or upstream["preview_text"] != submitted["preview_text"]:
                    raise AssertionError("resource prompt differs from submitted input")
                expect(dialog.get_by_text("目标模型：" + selected["target_model"]["model"], exact=True)).to_be_visible()
            else:
                if upstream["endpoint"] != "/v1/audio/speech" or upstream["instructions"] != submitted["description"] or upstream["input"] != submitted["preview_text"]:
                    raise AssertionError("prompted speech request differs from submitted input")
                if any(key in upstream for key in ("voice", "target_model")):
                    raise AssertionError("prompted speech included a voice/target")
                expect(dialog.get_by_text(re.compile("^目标模型："))).to_have_count(0)
            if selected["execution_mode"] != "test_replay":
                raise AssertionError("fixture was not marked as explicit replay")
            expect(dialog.get_by_text("请求模型：" + selected["model"], exact=True)).to_be_visible()
            expect(dialog.get_by_text("测试回放，未调用真实模型", exact=True)).to_have_count(2)
            self.assert_metadata(dialog)
            snapshots.append({"model": selected, "quote": self.quotes[selected["catalog_id"]], "create": submitted, "gateway": upstream, "candidate": self.ready})
            self.page.screenshot(path=str(self.args.artifacts_dir / ("U04-" + selected["model"] + ".png")))
            self.gateway("bad_audio")
            invalid = self.generate(dialog, success=False)
            if self.settled(invalid)["failure"]["code"] != "provider_bad_audio":
                raise AssertionError("unreadable preview was accepted")
            if selected["mode"] == "prompted_speech":
                self.gateway("json_local")
                rejected = self.generate(dialog, success=False)
                if self.settled(rejected)["failure"]["code"] != "provider_bad_audio":
                    raise AssertionError("local JSON audio URL passed SSRF boundary")
            self.gateway("short")
            self.generate(dialog)
            expect(dialog.get_by_text(re.compile("用于视频参考建议"))).to_have_count(0)
            self.gateway("long")
            self.generate(dialog)
            expect(dialog.get_by_text(re.compile("用于视频参考建议"))).to_be_visible()
            if not 5 < self.ready["duration_seconds"] < 7:
                raise AssertionError("long human-speech fixture was not six seconds")
        write_json(self.args.artifacts_dir / "U04-model-snapshots.json", {"models": snapshots})
        return ["all three model/quote/create/gateway/candidate snapshots match; explicit replay labels; binary speech success, local JSON URL rejected; real short/long human audio and bad media for each model"]

    def last_candidate_id(self) -> str:
        if not hasattr(self, "candidate_ids") or not self.candidate_ids:
            raise RuntimeError("no observed candidate request")
        return self.candidate_ids[-1]

    def U05(self) -> list[str]:
        if not self.ready:
            raise RuntimeError("run U04 first to establish a ready candidate")
        dialog = self.page.get_by_role("dialog", name="按描述生成声线")
        before = self.gateway()["calls"]
        description = dialog.get_by_label("音色描述", exact=True).input_value()
        preview = dialog.get_by_label("试听文本", exact=True).input_value()
        metadata = self.assert_metadata(dialog)
        self.close_voice()
        dialog = self.open_voice()
        self.assert_metadata(dialog)
        self.close_voice()
        self.page.route("**/voice-design/candidates/*/audio", lambda route: route.abort("failed"), times=1)
        dialog = self.open_voice()
        expect(dialog.get_by_role("button", name="重试试听", exact=True)).to_be_enabled()
        expect(dialog.get_by_label("音色描述", exact=True)).to_have_value(description)
        expect(dialog.get_by_label("试听文本", exact=True)).to_have_value(preview)
        dialog.get_by_role("button", name="重试试听", exact=True).click()
        audio = dialog.get_by_label("生成的试听音频", exact=True)
        self.page.wait_for_function("() => { const a = document.querySelector('audio[aria-label=\"生成的试听音频\"]'); return a && !a.paused && a.currentTime > 0.1; }")
        audio.focus()
        self.page.keyboard.press("Space")
        self.page.wait_for_function("() => document.querySelector('audio[aria-label=\"生成的试听音频\"]').paused")
        dialog.get_by_role("button", name="播放试听", exact=True).click()
        self.page.wait_for_function("() => !document.querySelector('audio[aria-label=\"生成的试听音频\"]').paused")
        if self.gateway()["calls"] != before:
            raise AssertionError("playback called the provider")
        self.page.screenshot(path=str(self.args.artifacts_dir / "U05-playback.png"))
        write_json(self.args.artifacts_dir / "U05-metadata.json", metadata)
        return ["finite eager metadata before play, paused/time zero, reopen; real authenticated audio fetch failure/retry, input preservation, play/pause/replay, zero provider calls"]

    def U06(self) -> list[str]:
        if not self.ready:
            raise RuntimeError("run U04 first")
        dialog = self.page.get_by_role("dialog", name="按描述生成声线")
        before = self.samples()
        previous = self.ready["candidate_id"]
        self.gateway("provider_error")
        self.fill(dialog, "重新生成失败时保留输入和上一条成功试听")
        self.generate(dialog, success=False)
        expect(dialog.get_by_role("button", name="播放试听", exact=True)).to_be_enabled()
        expect(dialog.get_by_label("音色描述", exact=True)).to_have_value("重新生成失败时保留输入和上一条成功试听")
        if self.api(f"/voice-design/candidates/{previous}").json()["data"]["status"] != "ready":
            raise AssertionError("previous ready result was lost")
        self.page.screenshot(path=str(self.args.artifacts_dir / "U06-failed-input-retained.png"))
        self.gateway("success")
        self.generate(dialog)
        if self.samples() != before:
            raise AssertionError("regeneration changed a configured voice")
        return ["deterministic upstream success/failure; previous sample and exact input retained; all formal slots unchanged"]

    def U07(self) -> list[str]:
        if not self.ready:
            raise RuntimeError("run U04 first")
        dialog = self.page.get_by_role("dialog", name="按描述生成声线")
        before = self.samples()
        child = next(slot for slot in before if slot["slot"] == "child")
        if child["path"]:
            raise RuntimeError("use a new dedicated test character; refusing to replace occupied child slot")
        saves = []
        self.page.on("request", lambda request: saves.append(request.post_data_json) if request.method == "POST" and request.url.endswith("/child/save-generated") else None)
        with self.page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith("/child/save-generated")) as response:
            dialog.get_by_role("button", name="保存到幼年", exact=True).click()
        if response.value.status != 200:
            raise RuntimeError(f"save HTTP {response.value.status}")
        expect(dialog).not_to_be_visible()
        if len(saves) != 1 or saves[0]["replace_existing"] is not False:
            raise AssertionError("save submitted more than once or replaced an occupied slot")
        after = self.samples()
        if next(slot for slot in after if slot["slot"] == "child")["sha256"] != self.ready["sha256"]:
            raise AssertionError("saved slot SHA differs from candidate")
        for old in before:
            if old["slot"] != "child":
                current = next(slot for slot in after if slot["slot"] == old["slot"])
                if any(current[key] != old[key] for key in ("path", "sha256", "updated_at")):
                    raise AssertionError("save changed another slot")
        self.page.screenshot(path=str(self.args.artifacts_dir / "U07-empty-slot-saved.png"))
        dialog = self.open_voice()
        self.gateway("success")
        self.generate(dialog)
        dialog.get_by_role("button", name="保存到幼年", exact=True).click()
        confirm = self.page.get_by_role("alertdialog")
        expect(confirm.get_by_text("替换已有声线？", exact=True)).to_be_visible()
        confirm.get_by_role("button", name="取消", exact=True).click()
        if len(saves) != 1:
            raise AssertionError("cancelled replacement sent a save request")
        self.close_voice()
        # A separate writer fills an empty youth slot after the form reads it.
        # The UI must receive the real CAS conflict and retain its candidate.
        dialog = self.open_voice(1)
        self.fill(dialog)
        self.generate(dialog)
        youth = next(slot for slot in self.samples() if slot["slot"] == "youth")
        if youth["path"]:
            raise RuntimeError("refusing to replace occupied CAS fixture slot")
        response = self.page.context.request.post(f"{self.args.base_url}/api/v1/projects/{self.args.project}/characters/{quote(self.args.character, safe='')}/voice-samples/youth/save-generated", data={
            "save_request_id": str(uuid4()), "candidate_id": self.ready["candidate_id"],
            "expected_slot": {key: youth[key] for key in ("path", "sha256", "updated_at")}, "replace_existing": False,
        })
        if response.status != 200:
            raise RuntimeError(f"CAS fixture writer HTTP {response.status}")
        with self.page.expect_response(lambda response: response.url.endswith("/youth/save-generated")) as response:
            dialog.get_by_role("button", name="保存到青年", exact=True).click()
        if response.value.status != 409:
            raise AssertionError("concurrent writer did not produce a real slot conflict")
        expect(dialog.get_by_role("alert")).to_be_visible()
        expect(dialog.get_by_text("已保存到目标位置，可重新生成试听。", exact=True)).to_have_count(0)
        expect(dialog.get_by_role("button", name="播放试听", exact=True)).to_be_enabled()
        self.page.screenshot(path=str(self.args.artifacts_dir / "U07-real-slot-conflict.png"))
        self.close_voice()
        return ["empty-slot publish SHA/binding checks; occupied-slot confirmation cancelled without request; real concurrent-writer CAS 409 retained result"]

    def U08(self) -> list[str]:
        if not hasattr(self, "node_id"):
            raise RuntimeError("run U02 first")
        self.page.goto(f"{self.args.base_url}/projects/{self.args.project}/freezone")
        expect(self.page.locator(f'[data-id="{self.node_id}"].react-flow__node')).to_be_attached()
        self.page.get_by_role("button", name="缩放选项", exact=True).click()
        zoom = self.page.get_by_role("textbox", name="缩放比例", exact=True)
        zoom.fill("100")
        zoom.press("Enter")
        self.voice_picker("node")
        before = self.node_data().get("voiceRef")
        self.page.get_by_role("button", name="按描述生成", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="按描述生成声线")
        self.fill(dialog)
        self.account_voice_name = "S5生成音色" + uuid4().hex[:6]
        dialog.get_by_label("音色名称", exact=True).fill(self.account_voice_name)
        self.gateway("success")
        self.generate(dialog)
        with self.page.expect_response(lambda response: response.url.endswith("/freezone/audio/voices/save-generated")) as response:
            dialog.get_by_role("button", name="保存到我的音色", exact=True).click()
        if response.value.status != 200:
            raise RuntimeError(f"account save HTTP {response.value.status}")
        expect(dialog).not_to_be_visible()
        expect(self.page.get_by_text(self.account_voice_name, exact=True)).to_be_visible()
        if self.node_data().get("voiceRef") != before:
            raise AssertionError("saving silently selected the account voice")
        row = self.page.get_by_text(self.account_voice_name, exact=True).locator("..").first
        row.get_by_role("button", name="选择", exact=True).click()
        self.page.wait_for_function("async id => { const { useCanvasStore } = await import('/src/stores/canvasStore.ts'); return useCanvasStore.getState().nodes.find(n=>n.id===id).data.voiceRef?.scope==='user_custom'; }", arg=self.node_id)
        data = self.node_data()
        if data["speechMode"] != "clone" or data["voiceLabel"] != self.account_voice_name:
            raise AssertionError("explicit voice selection did not update the node")
        self.canvas_entries(empty=False)
        # Read the next real browser submission body, then block it before the
        # business API: the four-call paid budget must never be spent again.
        captured = []
        self.page.route("**/freezone/audio/speech", lambda route: (captured.append(route.request.post_data_json), route.abort("blockedbyclient")))
        self.page.evaluate("async id => { const { useCanvasStore } = await import('/src/stores/canvasStore.ts'); const { dispatchNodeAction } = await import('/src/features/canvas/application/nodeActionResult.ts'); useCanvasStore.getState().updateNodeData(id,{text:'这是一段用于验证音色引用的文本。'}); dispatchNodeAction({nodeId:id,action:'generate_audio',requestId:crypto.randomUUID()}); }", self.node_id)
        deadline = time.monotonic() + 10
        while not captured and time.monotonic() < deadline:
            self.page.wait_for_timeout(100)
        if not captured or captured[0]["speech_mode"] != "clone" or captured[0]["voice_ref"]["scope"] != "user_custom":
            raise AssertionError("next speech submission lacks the explicit account voice reference")
        return ["account save/list persisted, selection unchanged until explicit click, nonempty three-entry replay; next real speech body clone/user_custom captured and blocked before API"]

    def U09(self) -> list[str]:
        if not self.args.prepare_fixtures:
            raise RuntimeError("lifecycle fixtures require a new dedicated test project")
        self.characters()
        dialog = self.open_voice(2)
        self.fill(dialog, "连接中断后仍应保留的声线描述")
        before_calls = self.gateway("slow")["calls"]
        before_submissions = self.submissions
        self.drop_next_create = True
        self.page.route("**/voice-design/candidates/*", lambda route: route.abort("failed"), times=1)
        dialog.get_by_role("button", name="生成试听", exact=True).click()
        expect(dialog.get_by_role("button", name="查询原任务", exact=True)).to_be_visible()
        expect(dialog.get_by_role("combobox", name="生成模型", exact=True)).to_be_disabled()
        dialog.get_by_role("button", name="查询原任务", exact=True).click()
        expect(dialog.get_by_role("button", name="播放试听", exact=True)).to_be_enabled(timeout=20000)
        if self.submissions != before_submissions + 1 or self.gateway()["calls"] != before_calls + 1:
            raise AssertionError("response loss or task query resubmitted generation")
        expect(dialog.get_by_label("音色描述", exact=True)).to_have_value("连接中断后仍应保留的声线描述")
        candidate_id = self.last_candidate_id()
        deployed = json.loads(self.args.deployment_env.read_text())
        state_root = Path(deployed["NOVELVIDEO_STATE_DIR"]).resolve()
        if not state_root.is_relative_to(Path("/tmp").resolve()):
            raise RuntimeError("refusing to modify a lifecycle fixture outside /tmp")
        database = state_root / self.args.fixture_username / self.args.fixture_project_name / "voice-design/candidates.sqlite3"
        # Advance only this newly created fixture's clock. The following media
        # request must hit the real API's expiry/read/save boundary.
        with sqlite3.connect(database) as connection:
            result = connection.execute("UPDATE candidates SET expires_at=0 WHERE candidate_id=?", (candidate_id,))
            if result.rowcount != 1:
                raise AssertionError("expiry fixture did not address exactly one candidate")
        self.close_voice()
        dialog = self.open_voice(2)
        expect(dialog.get_by_text("试听已过期，请重新生成。", exact=True)).to_be_visible()
        expect(dialog.get_by_role("button", name="保存到中年", exact=True)).to_be_disabled()
        expect(dialog.get_by_label("音色描述", exact=True)).to_have_value("连接中断后仍应保留的声线描述")
        self.page.screenshot(path=str(self.args.artifacts_dir / "U09-expired.png"))
        self.close_voice()
        return ["accepted response lost, original task queried without resubmission; isolated expiry fixture yields real API 410 and disables save with inputs retained; configuration unavailable branch is U12"]

    def U10(self) -> list[str]:
        self.characters()
        menu_evidence = []
        for width in (1440, 768):
            self.page.set_viewport_size({"width": width, "height": 900})
            dialog = self.open_voice()
            menu_evidence.append(self.assert_model_menu(dialog, width))
            description = dialog.get_by_label("音色描述", exact=True)
            description.fill("保留输入" + "中" * 496)
            dialog.get_by_label("试听文本", exact=True).fill("今天的天气很好，我们沿着河边慢慢走回家。")
            overflow = dialog.evaluate("e => e.scrollWidth > e.clientWidth")
            if overflow:
                raise AssertionError(f"dialog overflows at {width}px")
            for _ in range(8):
                self.page.keyboard.press("Tab")
                self.page.wait_for_function("() => document.activeElement?.closest('[role=dialog]') || document.activeElement?.matches('[data-radix-focus-guard], [data-base-ui-focus-guard]')", timeout=1000)
            self.page.screenshot(path=str(self.args.artifacts_dir / f"U10-{width}.png"))
            self.close_voice()
            expect(self.page.get_by_role("button", name="按描述生成", exact=True).first).to_be_focused()
            dialog = self.open_voice()
            expect(dialog.get_by_label("音色描述", exact=True)).to_have_value("保留输入" + "中" * 496)
            self.close_voice()
        write_json(self.args.artifacts_dir / "U10-model-menu.json", menu_evidence)
        dialog = self.open_voice()
        models = self.models()
        for model in models:
            self.select_model(dialog, model["catalog_id"])
            self.fill(dialog, "目录独立草稿" + model["model"])
            self.gateway("success")
            self.generate(dialog)
            expect(dialog.get_by_text("请求模型：" + model["model"], exact=True)).to_be_visible()
        before_switch_calls = self.gateway()["calls"]
        for model in reversed(models):
            self.select_model(dialog, model["catalog_id"])
            expect(dialog.get_by_label("音色描述", exact=True)).to_have_value("目录独立草稿" + models[-1]["model"])
            expect(dialog.get_by_text("请求模型：" + model["model"], exact=True)).to_be_visible()
            self.assert_metadata(dialog)
        if self.gateway()["calls"] != before_switch_calls:
            raise AssertionError("switching back generated a new candidate")
        self.close_voice()
        self.open_voice(1)
        expect(self.page.get_by_label("音色描述", exact=True)).not_to_have_value("保留输入" + "中" * 496)
        self.close_voice()
        dialog = self.open_voice()
        self.fill(dialog, "旧目标仍在运行的请求")
        self.gateway("slow")
        dialog.get_by_role("button", name=re.compile("^(生成试听|重新生成)$")).click()
        expect(dialog.get_by_text("正在生成，关闭弹窗不会取消任务。", exact=True)).to_be_visible()
        expect(dialog.get_by_role("combobox", name="生成模型", exact=True)).to_be_disabled()
        old_id = self.last_candidate_id()
        self.close_voice()
        dialog = self.open_voice(1)
        self.fill(dialog, "切换后新目标自己的描述")
        if self.settled(old_id)["status"] != "ready":
            raise AssertionError("old target's fixture did not finish")
        expect(dialog.get_by_label("音色描述", exact=True)).to_have_value("切换后新目标自己的描述")
        expect(dialog.get_by_text(f"保存位置：{self.args.character} · 青年", exact=True)).to_be_visible()
        expect(dialog.get_by_role("button", name="保存到青年", exact=True)).to_be_disabled()
        self.close_voice()
        dialog = self.open_voice(2)
        self.fill(dialog, "保存期间锁定同一目标全部模型")
        self.gateway("success")
        self.generate(dialog)
        held = []
        pattern = "**/voice-samples/middle/save-generated"
        self.page.route(pattern, lambda route: held.append(route))
        dialog.get_by_role("button", name="保存到中年", exact=True).click()
        expect(dialog.get_by_role("button", name="正在保存…", exact=True)).to_be_visible()
        expect(dialog.get_by_role("combobox", name="生成模型", exact=True)).to_be_disabled()
        self.close_voice()
        dialog = self.open_voice(2)
        expect(dialog.get_by_role("combobox", name="生成模型", exact=True)).to_be_disabled()
        if len(held) != 1:
            raise AssertionError("pending save was submitted more than once")
        response = held[0].fetch()
        if response.status != 200:
            raise AssertionError("pending save fixture failed")
        held[0].fulfill(response=response)
        self.page.unroute(pattern)
        expect(dialog).not_to_be_visible()
        return ["1440/768 matching menu/trigger widths, 12px options, viewport bounds, keyboard selection/Escape and focus; shared inputs and per-catalog results restored without new calls; generating/unknown/saving selection locks; late old-target result isolation; pending-save survives close/reopen and saves once"]

    def U11(self) -> list[str]:
        page = self.page
        models = self.models()
        response = page.context.request.get(self.args.admin_base_url + "/admin/media-models?media_type=audio")
        if response.status != 200:
            raise RuntimeError(f"admin catalog HTTP {response.status}")
        catalog = response.json()
        ordinary = next(model for model in catalog if model["gateway_model"] == "cosyvoice-v3.5-flash")
        fixtures = [next(row for row in catalog if row["catalog_id"] == model["catalog_id"]) for model in models] + [ordinary]
        page.goto(f"{self.args.admin_base_url}/media-models")
        page.get_by_role("combobox").first.click()
        page.get_by_role("option", name="音频", exact=True).click()
        for model in fixtures:
            row = page.get_by_role("row").filter(has_text=model["label"])
            row.get_by_role("button", name="编辑", exact=True).click()
            dialog = page.get_by_role("dialog")
            purpose = model["config"].get("voiceDesignMode") or model["config"]["request"]["endpoint"]
            expect(dialog.get_by_role("combobox", name="音频端点", exact=True)).to_have_attribute("value", purpose)
            if purpose == "audio/voice-designs":
                expect(dialog.locator("#mm-targetModel")).to_have_attribute("value", model["config"]["targetModel"])
            else:
                expect(dialog.locator("#mm-targetModel")).to_have_count(0)
            with page.expect_response(lambda response: response.request.method == "PUT" and "/admin/media-models/" in response.url) as saved:
                dialog.get_by_role("button", name="保存", exact=True).click()
            if saved.value.status != 200:
                raise AssertionError("admin audio mode save failed")
            persisted = saved.value.json()
            if persisted["config"] != model["config"]:
                raise AssertionError("admin form changed audio mode/target configuration")
            expect(dialog).not_to_be_visible(timeout=10000)
            row.get_by_role("button", name="编辑", exact=True).click()
            expect(page.get_by_role("dialog").get_by_role("combobox", name="音频端点", exact=True)).to_have_attribute("value", purpose)
            page.screenshot(path=str(self.args.artifacts_dir / ("U11-" + model["gateway_model"] + ".png")))
            page.get_by_role("dialog").get_by_role("button", name="取消", exact=True).click()
        page.get_by_role("button", name="新增模型", exact=True).click()
        dialog = page.get_by_role("dialog")
        dialog.get_by_role("combobox", name="类型", exact=True).click()
        page.get_by_role("option", name="音频", exact=True).click()
        dialog.get_by_role("textbox").nth(0).fill("S19 invalid target")
        dialog.get_by_role("textbox").nth(1).fill("voice-enrollment")
        dialog.get_by_role("combobox", name="音频端点", exact=True).click()
        page.get_by_role("option", name="声线设计", exact=True).click()
        dialog.get_by_role("button", name="保存", exact=True).click()
        expect(dialog.get_by_role("alert")).to_be_visible()
        for kind in ("image", "video"):
            dialog.get_by_role("combobox", name="类型", exact=True).click()
            page.get_by_role("option", name="图片" if kind == "image" else "视频", exact=True).click()
            expect(dialog.get_by_role("combobox", name="音频端点", exact=True)).to_have_count(0)
            expect(dialog.locator("#mm-targetModel")).to_have_count(0)
        dialog.get_by_role("button", name="取消", exact=True).click()
        return ["Qwen/Cosy resources, Seed prompted and ordinary speech save/reopen preserve configuration; invalid target rejected; image/video exclude audio fields"]

    def run_case(self, case: str) -> list[str]:
        method = getattr(self, case, None)
        if method is None:
            raise RuntimeError(f"{case} has not been executed by this script")
        return method()

    def U12(self) -> list[str]:
        return run_u12(self.page.context.browser, self.args)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--self-check", action="store_true", help="verify local guards without network")
    result.add_argument("--base-url", default=os.environ.get("VOICE_DESIGN_TEST_BASE_URL", "http://127.0.0.1:18912"))
    result.add_argument("--admin-base-url", default=os.environ.get("VOICE_DESIGN_TEST_ADMIN_BASE_URL", "http://127.0.0.1:18913"))
    result.add_argument("--project", default=os.environ.get("VOICE_DESIGN_TEST_PROJECT"))
    result.add_argument("--character", default=os.environ.get("VOICE_DESIGN_TEST_CHARACTER", "验收角色"))
    result.add_argument("--cases", nargs="+", choices=ALL_CASES, default=list(ALL_CASES))
    result.add_argument("--artifacts-dir", type=Path, default=Path("/tmp/voice-design-ui"))
    result.add_argument("--storage-state", type=Path, help="private existing login session; never copied into artifacts")
    result.add_argument("--candidate-evidence", type=Path, help="ready result from voice_design.py, reused without provider calls")
    result.add_argument("--test-gateway-url", help="non-forwarding deterministic gateway; separate from the paid ledger")
    result.add_argument("--deployment-env", type=Path, help="private isolated deployment config proving the test gateway selection")
    result.add_argument("--prepare-fixtures", action="store_true", help="create a dedicated local test user/project/character for a repeatable no-fee run")
    result.add_argument("--design-label", default="S5 声线设计")
    result.add_argument("--speech-label", default="S5 CosyVoice")
    result.add_argument("--headed", action="store_true")
    return result


def main() -> int:
    args = parser().parse_args()
    if args.self_check:
        self_check()
        return 0
    args.base_url = require_local(args.base_url)
    args.admin_base_url = require_local(args.admin_base_url)
    if not args.project:
        raise ValueError("--project is required")
    args.artifacts_dir.mkdir(parents=True, exist_ok=True)
    results = {}
    started = time.monotonic()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=not args.headed)
        context = browser.new_context(locale="zh-CN", viewport={"width": 1280, "height": 900}, storage_state=args.storage_state)
        context.add_init_script("localStorage.setItem('i18nextLng','zh-CN')")
        login(context, args.base_url)
        acceptance = Acceptance(context.new_page(), args)
        fixtures = prepare_fixtures(context, args) if args.prepare_fixtures else {"project": args.project, "character": args.character}
        for case in args.cases:
            case_started = time.monotonic()
            try:
                notes = acceptance.run_case(case)
                results[case] = {"status": "passed", "assertions": notes}
            except Exception as error:
                # Error text may include DOM data, never server response bodies.
                results[case] = {"status": "failed", "error_type": type(error).__name__, "error": next(iter(str(error).splitlines()), type(error).__name__)}
                error_path = args.artifacts_dir / f"{case}-error.txt"
                error_path.write_text(traceback.format_exc())
                error_path.chmod(0o600)
                acceptance.page.screenshot(path=str(args.artifacts_dir / f"{case}-failed.png"))
            print(f"{case}: {results[case]['status']}", flush=True)
            results[case]["elapsed_seconds"] = round(time.monotonic() - case_started, 3)
        browser.close()
    write_json(args.artifacts_dir / "results.json", {"cases": results, "fixtures": fixtures, "provider": "deterministic" if args.test_gateway_url else "no-new-generation", "elapsed_seconds": round(time.monotonic() - started, 3), "code_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(), "script_sha256": digest(Path(__file__).read_bytes()), "working_diff_sha256": digest(subprocess.check_output(["git", "diff", "HEAD", "--binary"])), "index_tree": subprocess.check_output(["git", "write-tree"], text=True).strip()})
    passed = all(value["status"] == "passed" for value in results.values())
    if passed:
        print("VERIFY-OK (real browser; no paid model calls)")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
