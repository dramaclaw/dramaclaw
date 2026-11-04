"""Story tools follow the existing Freezone boundary; mainline keeps canvas management."""

from __future__ import annotations

import importlib.util
import json
import sys

import pytest

from novelvideo.chat import dramaclaw_mcp, story_tools
from novelvideo.chat import service as chat_service


STORY_ONLY_TOOLS = story_tools.STORY_TOOL_NAMES - {"dramaclaw_get_freezone_canvas"}
CANVAS_MANAGEMENT_TOOLS = {
    "dramaclaw_list_freezone_canvases",
    "dramaclaw_get_freezone_canvas",
    "dramaclaw_save_freezone_canvas",
    "dramaclaw_delete_freezone_canvas",
    "dramaclaw_create_freezone_canvas_from_preset",
    "dramaclaw_list_freezone_skills",
    "dramaclaw_run_freezone_skill",
    "dramaclaw_get_freezone_skill_result",
}


@pytest.fixture
def mainline(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "default")
    monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN", "test-token")
    monkeypatch.delenv("DRAMACLAW_AGENT_TOKEN_FILE", raising=False)
    monkeypatch.delenv("DRAMACLAW_CHAT_SURFACE", raising=False)
    monkeypatch.delenv("DRAMACLAW_AGENT_PROFILE", raising=False)
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_CACHE", {})
    monkeypatch.setattr(dramaclaw_mcp, "_PLUGIN_TOOL_CACHE", {})
    monkeypatch.setattr(dramaclaw_mcp, "_EXCLUDE_STORY_TOOLS", False)
    monkeypatch.delitem(sys.modules, "tools.registry", raising=False)
    monkeypatch.delitem(sys.modules, "tools", raising=False)
    dramaclaw_mcp._install_hermes_registry_shim()
    return dramaclaw_mcp._plugin("dramaclaw")


def test_mainline_does_not_load_or_register_story_handlers(mainline, monkeypatch):
    original = importlib.util.spec_from_file_location

    def reject_story(name, path, *args, **kwargs):
        assert not str(path).endswith("/interactive_story.py")
        return original(name, path, *args, **kwargs)

    monkeypatch.setattr(importlib.util, "spec_from_file_location", reject_story)
    plugin = dramaclaw_mcp._load_plugin("dramaclaw")
    registered = {}

    class Context:
        def register_tool(self, **kwargs):
            registered[kwargs["name"]] = kwargs["handler"]

    plugin.register(Context())
    assert not registered.keys() & STORY_ONLY_TOOLS
    assert CANVAS_MANAGEMENT_TOOLS <= registered.keys()
    assert set(dramaclaw_mcp._agent_tools()) == set(registered)


@pytest.mark.parametrize("name", sorted(STORY_ONLY_TOOLS))
async def test_mainline_rejects_direct_story_tool_call(mainline, name):
    with pytest.raises(ValueError, match="unknown DramaClaw tool"):
        await dramaclaw_mcp.call_tool(name, {})


@pytest.mark.parametrize("tool", ["get", "post", "patch", "delete"])
@pytest.mark.parametrize("path", [
    "/projects/project-a/interactive-stories",
    "/api/v1/projects/project-a/interactive-stories/story-a",
    "/projects/project-a/interactive-stories/story-a/validate",
    "/projects/project-a/interactive-stories/story-a/stage-confirmations",
    "/projects/project-a/interactive-story-outline?canvas_id=canvas-a",
    "/projects/project-a/interactive-story-outline/confirm",
    "/projects/project-a/interactive-story-progress",
    "/projects/project-a/canvases/canvas-a/stories/group-a/publication/prepare",
    "/api/v1/public-stories/public-a",
    "/api/v1/public-stories/public-a/versions/version-a/media/asset-a",
    "/projects/project-a/%69nteractive-stories/story-a",
    "/projects/project-a/interactive%2dstory-outline",
    "/projects/project-a//interactive-stories/story-a",
    "/projects/project-a/./interactive-stories/story-a",
])
async def test_generic_api_tools_cannot_reach_story_routes(mainline, monkeypatch, tool, path):
    def unexpected_network(*args, **kwargs):
        pytest.fail("mainline sent a story API request")

    monkeypatch.setattr(mainline, "urlopen", unexpected_network)
    arguments = {"path": path}
    # Both native Hermes handlers and MCP dispatch use this same HTTP boundary.
    native = json.loads(getattr(mainline, f"_handle_{tool}")(arguments))
    assert "interactive_story_canvas_only" in native["error"]
    result = await dramaclaw_mcp.call_tool(f"dramaclaw_{tool}", arguments)
    assert result.isError is True
    assert "interactive_story_canvas_only" in result.content[0].text


@pytest.mark.parametrize("method,path", [
    ("GET", "/projects/project-a/episodes"),
    ("POST", "/projects/project-a/ingest/start"),
    ("GET", "/projects/project-a/freezone/canvases/canvas-a"),
    ("PUT", "/projects/project-a/freezone/canvases/canvas-a"),
    ("DELETE", "/projects/project-a/freezone/canvases/canvas-a"),
    ("POST", "/projects/project-a/freezone/skills/skill-a/run"),
    ("GET", "/projects/interactive-stories/episodes"),
])
def test_original_mainline_and_canvas_routes_still_reach_api(mainline, monkeypatch, method, path):
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://localhost:8780")
    requests = []

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"ok": true}'

    def send(request, **kwargs):
        requests.append(request)
        return Response()

    monkeypatch.setattr(mainline, "urlopen", send)
    assert mainline._request(method, path)["ok"] is True
    assert len(requests) == 1
    assert requests[0].full_url == "http://localhost:8780/api/v1" + path
    assert requests[0].method == method


def test_mainline_skill_sync_removes_old_story_copy_and_preserves_other_skills(monkeypatch, tmp_path):
    sources = []
    for name in ("dramaclaw", "interactive-story", "dramaclaw-workflows"):
        source = tmp_path / "source" / name
        source.mkdir(parents=True)
        (source / "SKILL.md").write_text(f"# {name}\n")
        sources.append((name, source))
    monkeypatch.setattr(chat_service, "_skill_sources", lambda: sources)
    skills = tmp_path / ".agents" / "skills"
    chat_service._sync_project_skills(skills, agent_profile="freezone:main")
    assert (skills / "interactive-story" / "SKILL.md").is_file()
    custom = skills / "my-private-skill" / "SKILL.md"
    custom.parent.mkdir()
    custom.write_text("User-owned content\n")

    chat_service._sync_project_skills(skills, agent_profile="main")

    assert not (skills / "interactive-story").exists()
    assert (skills / "dramaclaw" / "SKILL.md").is_file()
    assert (skills / "dramaclaw-workflows" / "SKILL.md").is_file()
    assert custom.read_text() == "User-owned content\n"
    manifest = json.loads((skills / ".dramaclaw-managed-skills.json").read_text())
    assert set(manifest["skills"]) == {"dramaclaw", "dramaclaw-workflows"}


async def test_mainline_cannot_advertise_or_read_stale_story_skill(mainline, monkeypatch, tmp_path):
    skills = tmp_path / ".agents" / "skills"
    story = skills / "interactive-story" / "SKILL.md"
    story.parent.mkdir(parents=True)
    story.write_text("# Interactive film creation\n")
    workflow = skills / "dramaclaw-workflows" / "SKILL.md"
    workflow.parent.mkdir()
    workflow.write_text("# Existing workflows\n")
    monkeypatch.setenv("DRAMACLAW_SKILLS_DIR", str(skills))

    resources = await dramaclaw_mcp.list_resources()
    assert {resource.name for resource in resources} == {"dramaclaw-workflows/SKILL.md"}
    with pytest.raises(ValueError, match="only available in the Freezone canvas"):
        await dramaclaw_mcp.read_resource(story.as_uri())

    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    resources = await dramaclaw_mcp.list_resources()
    assert "interactive-story/SKILL.md" in {resource.name for resource in resources}
    assert await dramaclaw_mcp.read_resource(story.as_uri())


def test_mainline_capability_scope_is_injected_without_changing_canvas_guidance():
    scope = chat_service._MAINLINE_ASSISTANT_SCOPE_INSTRUCTIONS
    for mode in ("default", "freezone_canvas"):
        instructions = chat_service._codex_developer_instructions(mode)
        prompt = chat_service._prompt_with_user_context(
            "local", "project-a", "你能做什么？", tool_mode=mode,
        )
        if mode == "default":
            assert scope in instructions
            assert scope in prompt
            assert "[DRAMACLAW_MAINLINE_SCOPE]" in prompt
        else:
            assert scope not in instructions
            assert scope not in prompt
            assert chat_service._CODEX_FMV_INTERACTIVE_STORY_INSTRUCTIONS in instructions
