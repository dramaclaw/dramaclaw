"""Per-user Hermes workspace initialization.

Owns one job: idempotently materialize ``state/{user}/.hermes/`` to be a
working HERMES_HOME — with sandbox-friendly tmpdir, repo-pinned skill
softlinks, a starter config.yaml, and an empty compatibility .env file.

Kept separate from chat_service.py so the latter stays small. Designed to be
safe to call on every HermesPool.spawn() (cheap when already initialized).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
from pathlib import Path

import yaml

_log = logging.getLogger(__name__)

DRAMACLAW_ROOT = Path(__file__).resolve().parents[3]
STATE_ROOT = DRAMACLAW_ROOT / "state"
DEFAULT_HERMES_SKILLS = {
    "dramaclaw",
    "sketch-correction-worker",
    "sketch-storyboard-director",
}
DEFAULT_HERMES_PLUGINS = {"dramaclaw"}
DEFAULT_HERMES_TOOLSETS = {"hermes-acp"}
FREEZONE_HERMES_SKILLS = {"freezone", "workflows"}
FREEZONE_HERMES_PLUGINS = {"freezone"}
_GENERATED_WORKFLOW_SKILL_MARKER = ".dramaclaw-workflow-skill.json"
FREEZONE_HERMES_PYTHON_HOOK_DIR = ".dramaclaw-python"
_warned_repo_state_fallback = False


_DEFAULT_HERMES_MODEL = "DC-hermes-LLM"
_DRAMACLAW_HERMES_PROVIDER_NAME = "dramaclaw"
_DRAMACLAW_HERMES_PROVIDER = f"custom:{_DRAMACLAW_HERMES_PROVIDER_NAME}"
_DRAMACLAW_HERMES_KEY_ENV = "NEWAPI_API_KEY"
_DEFAULT_HERMES_MODEL_API_MODE = "chat_completions"
_DEFAULT_HERMES_MODEL_CONTEXT_LENGTH = "131072"

_CONFIG_YAML_TEMPLATE = """# DramaClaw-managed hermes config.
# Toolset whitelist enforces L1 defense (no direct file write / shell).
#
# Edit with care; this file may be regenerated.
#
# Model routes through the selected NewAPI gateway (OpenAI-compatible), unified
# with the video/image generators. The endpoint is non-secret workspace config;
# DramaClaw injects the key into the worker process as NEWAPI_API_KEY and the
# OPENAI_API_KEY compatibility alias used by Hermes when restoring older
# custom-provider sessions.

custom_providers:
  - name: dramaclaw
    base_url: {base_url}
    key_env: NEWAPI_API_KEY
    api_mode: {api_mode}

model:
  default: {model}
  provider: custom:dramaclaw
  context_length: {context_length}   # skip the slow cold-start context-length probe

enabled_toolsets:
  - hermes-acp         # Repo plugins exposed through ACP
  - memory             # hermes built-in cross-session memory

plugins:
  enabled:
    - dramaclaw

display:
  tool_progress: verbose
  tool_progress_command: true

# Tools disabled at L1 so a sandbox bypass is layered with "no tool to misuse":
disabled_toolsets:
  - bash
  - shell
  - terminal
  - subprocess
  - file_write
  - file_read         # We allow read by sandbox; disable agent-side tool too
  - edit
  - write
  - read
  - glob
  - grep
"""

_FREEZONE_CONFIG_YAML_TEMPLATE = """# Freezone/虾画 hermes config.
# This profile intentionally enables only canvas-oriented tools.
# Model routes through the selected NewAPI gateway (OpenAI-compatible), unified
# with the video/image generators. DramaClaw injects the key into the worker
# process as NEWAPI_API_KEY and OPENAI_API_KEY for older restored custom
# sessions.

custom_providers:
  - name: dramaclaw
    base_url: {base_url}
    key_env: NEWAPI_API_KEY
    api_mode: {api_mode}

model:
  default: {model}
  provider: custom:dramaclaw
  context_length: {context_length}   # skip the slow cold-start context-length probe

enabled_toolsets:
  - hermes-acp
  - freezone-acp
  - memory

plugins:
  enabled:
    - freezone

agent:
  coding_context: "off"

tools:
  tool_search:
    enabled: auto
  skill_manage:
    enabled: "off"

display:
  tool_progress: verbose
  tool_progress_command: true

disabled_toolsets:
  - dramaclaw
  - dramaclaw-acp
  - bash
  - shell
  - terminal
  - subprocess
  - file_write
  - file_read
  - edit
  - write
  - read
  - glob
  - grep
"""


_DEFAULT_ENV_TEMPLATE = """# DramaClaw-managed Hermes workspace.
# Model credentials are synchronized from DramaClaw settings so Hermes profile
# secret scoping resolves the same gateway key as the API process.
"""

# Hermes core tools stripped from Freezone workers at tool-registry level (the
# sitecustomize hook below; hermes_pool passes the list via
# DRAMACLAW_HERMES_TOOL_DENY). No freezone skill uses any of these, their
# schemas cost ~7.6k input tokens on every model call, and read/search would
# reopen the plugin-source-diving hole. skill_view / skills_list / todo /
# memory / vision_analyze and the tool_search bridge tools stay enabled.
FREEZONE_HERMES_TOOL_DENY = (
    "delegate_task",
    "execute_code",
    "patch",
    "process",
    "read_file",
    "search_files",
    "session_search",
    "terminal",
    "write_file",
)

_FREEZONE_SITECUSTOMIZE_PY = '''"""DramaClaw-managed Freezone Hermes startup hooks."""

from __future__ import annotations

import os
import sys
import threading


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _denied_tool_names() -> frozenset[str]:
    names = set()
    if _truthy(os.environ.get("DRAMACLAW_DISABLE_HERMES_SKILL_MANAGE")):
        names.add("skill_manage")
    for part in os.environ.get("DRAMACLAW_HERMES_TOOL_DENY", "").split(","):
        part = part.strip()
        if part:
            names.add(part)
    return frozenset(names)


def _warn_red(message: str) -> None:
    print(f"\\033[31mDramaClaw Freezone warning: {message}\\033[0m", file=sys.stderr)


def _pop_registered_tool(registry, name: str) -> None:
    try:
        registry.deregister(name)
    except Exception:
        tools = getattr(registry, "_tools", None)
        lock = getattr(registry, "_lock", None)
        if isinstance(tools, dict):
            if lock is None:
                tools.pop(name, None)
            else:
                with lock:
                    tools.pop(name, None)


def _verify_denied_tools_removed(registry, denied) -> list[str]:
    """Startup self-check: warn in red only when a denied tool survived."""
    tools = getattr(registry, "_tools", None)
    if not isinstance(tools, dict):
        _warn_red("cannot verify denied-tool cleanup: registry._tools unavailable")
        return []
    leftover = sorted(set(denied) & set(tools))
    if leftover:
        _warn_red(
            "denied Hermes tools still registered after startup: "
            + ", ".join(leftover)
        )
    return leftover


def _disable_denied_tools(denied) -> None:
    try:
        from tools.registry import registry
    except Exception as exc:  # noqa: BLE001
        _warn_red(
            f"failed to import Hermes tool registry: {exc}; "
            f"denied tools NOT removed: {', '.join(sorted(denied))}"
        )
        return

    if getattr(registry, "_dramaclaw_denied_tools", None) == denied:
        return

    original_register = registry.register

    def register_without_denied(*args, **kwargs):
        name = kwargs.get("name")
        if name is None and args:
            name = args[0]
        if name in denied:
            return None
        return original_register(*args, **kwargs)

    registry.register = register_without_denied
    setattr(registry, "_dramaclaw_denied_tools", denied)

    for name in sorted(denied):
        _pop_registered_tool(registry, name)

    # Tool modules keep registering while Hermes finishes importing, after
    # this hook has run. Re-check once the process has settled; silence means
    # the cleanup held.
    timer = threading.Timer(
        20.0, _verify_denied_tools_removed, args=(registry, denied)
    )
    timer.daemon = True
    timer.start()


_DENIED_TOOLS = _denied_tool_names()
if _DENIED_TOOLS:
    _disable_denied_tools(_DENIED_TOOLS)
'''

_MANAGED_MODEL_ENV_KEYS = {
    "NEWAPI_API_KEY",
    "NEWAPI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_API_BASE",
    "OPENAI_BASE_URL",
}


def _remove_managed_model_env_values(path: Path) -> None:
    """Remove stale model credentials that can override the worker environment."""
    try:
        original = path.read_text(encoding="utf-8")
    except OSError:
        return
    kept: list[str] = []
    for line in original.splitlines(keepends=True):
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if match and match.group(1) in _MANAGED_MODEL_ENV_KEYS:
            continue
        kept.append(line)
    updated = "".join(kept)
    if updated != original:
        path.write_text(updated, encoding="utf-8")


def _state_root() -> Path:
    configured = os.environ.get("NOVELVIDEO_STATE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    global _warned_repo_state_fallback
    if not _warned_repo_state_fallback:
        _warned_repo_state_fallback = True
        _log.warning(
            "NOVELVIDEO_STATE_DIR is not set; Hermes workspace falls back to %s",
            DRAMACLAW_ROOT / "state",
        )
    return DRAMACLAW_ROOT / "state"


def _root_value(*names: str) -> str:
    """Read the first non-empty value among ``names`` from root .env then env."""
    env_path = DRAMACLAW_ROOT / ".env"
    try:
        root_values = _parse_env_assignments(env_path.read_text(encoding="utf-8"))
    except OSError:
        root_values = {}
    for name in names:
        value = (root_values.get(name) or os.environ.get(name, "")).strip()
        if value:
            return value
    return ""


def _effective_newapi_gateway() -> tuple[str, str]:
    """Return the independent LLM gateway used by Hermes."""
    from novelvideo.model_gateway_settings import get_effective_llm_config

    gateway = get_effective_llm_config()
    return gateway.api_key, gateway.base_url


def _newapi_base_url() -> str:
    return _effective_newapi_gateway()[1]


def effective_gateway_fingerprint() -> str:
    """Return a non-secret fingerprint of the gateway used by new Hermes workers."""
    api_key, base_url = _effective_newapi_gateway()
    material = f"{base_url}\n{api_key}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def effective_gateway_credentials() -> tuple[str, str]:
    """Return the NewAPI credentials injected into a newly spawned worker."""
    return _effective_newapi_gateway()


def _hermes_model_default() -> str:
    from novelvideo.model_gateway_settings import get_effective_llm_config
    from novelvideo.shared.runtime_env import is_ce_effective

    # Only CE resolves the route from its gateway settings database. EE keeps
    # the deployment environment in charge, so HERMES_MODEL selects the alias
    # and BrainClaw is reached by pointing it at the BrainClaw alias.
    if is_ce_effective() and get_effective_llm_config().is_brainclaw:
        return "brainclaw"
    return (
        _root_value(
            "HERMES_MODEL",
            "HERMES_MODEL_DEFAULT",
            "DRAMACLAW_HERMES_MODEL",
        )
        or _DEFAULT_HERMES_MODEL
    )


def _hermes_model_api_mode() -> str:
    return _root_value("HERMES_MODEL_API_MODE") or _DEFAULT_HERMES_MODEL_API_MODE


def _hermes_model_context_length() -> str:
    raw = _root_value("HERMES_MODEL_CONTEXT_LENGTH")
    if not raw:
        return _DEFAULT_HERMES_MODEL_CONTEXT_LENGTH
    try:
        value = int(raw)
    except ValueError:
        _log.warning("invalid HERMES_MODEL_CONTEXT_LENGTH=%r, using default", raw)
        return _DEFAULT_HERMES_MODEL_CONTEXT_LENGTH
    return str(value) if value > 0 else _DEFAULT_HERMES_MODEL_CONTEXT_LENGTH


def _default_config_yaml() -> str:
    return _CONFIG_YAML_TEMPLATE.format(
        model=_hermes_model_default(),
        base_url=_newapi_base_url(),
        api_mode=_hermes_model_api_mode(),
        context_length=_hermes_model_context_length(),
    )


def _default_freezone_config_yaml() -> str:
    return _FREEZONE_CONFIG_YAML_TEMPLATE.format(
        model=_hermes_model_default(),
        base_url=_newapi_base_url(),
        api_mode=_hermes_model_api_mode(),
        context_length=_hermes_model_context_length(),
    )


_DEFAULT_SOUL_MD = (
    "你是虾导。不要自称 Hermes Agent，不要提 Nous Research，"
    "也不要主动解释底层代理框架。自我介绍时只回答“我是虾导”，"
    "不要附加“DramaClaw 的小说转视频创作助手”之类的头衔或职能描述。"
    "你应当直接、清晰、务实，优先帮助用户完成 "
    "DramaClaw 项目进度查询、任务管理、剧本、配音、图片、视频生成与交付相关工作。\n"
)

_DEFAULT_MEMORY_MD = """虾导在 DramaClaw 会话中面向用户自称“虾导”，不要自称 Hermes Agent，不要提 Nous Research 或底层代理框架。不要在普通回复开头自报身份；只有用户明确问身份、名称或自我介绍时，才只回答“我是虾导”，不要附加“DramaClaw 的小说转视频创作助手”之类的头衔或职能描述。
§
DramaClaw 管理的虾导会话中 `terminal` 被禁用（在 config.yaml disabled_toolsets 中），curl 等 shell 命令会被直接拒绝。调用 DramaClaw API 时应使用已启用的 `hermes-acp` toolset 中的 DramaClaw 插件工具，不要用 curl。
"""

_FREEZONE_SOUL_MD = (
    "你是虾画助手，负责 Freezone/虾画中的创意咨询、画布节点、连线、资源和工作流操作。"
    "具体操作规则以每轮 FREEZONE_CANVAS_ASSISTANT 合同为准。"
    "不要在普通回复开头自报身份；用户问身份时，回答“我是虾画助手”。不要自称 Hermes Agent，不要提 Nous Research，"
    "也不要主动解释底层代理框架。\n"
)

_FREEZONE_MEMORY_MD = """虾画会话只使用 Freezone 画布能力；不得用 DramaClaw 主线工具改动画布或推进主线流水线。
"""

_OLD_SOUL_PREFIX = (
    "You are Hermes Agent, an intelligent AI assistant created by Nous Research. "
    "You are helpful, knowledgeable, and direct. You assist users with a wide range "
    "of tasks including answering questions, writing and editing code, analyzing "
    "information, creative work, and executing actions via your tools. You "
    "communicate clearly, admit uncertainty when appropriate, and prioritize being "
    "genuinely useful over being verbose unless otherwise directed below. Be targeted "
    "and efficient in your exploration and investigations."
)

_OLD_IDENTITY_MEMORY_LINE = (
    "虾导在 DramaClaw 会话中面向用户自称“虾导”，不要自称 Hermes Agent，"
    "不要提 Nous Research 或底层代理框架。用户问“你是谁 / 你叫什么 / "
    "你是什么助手 / 介绍一下你自己”时，直接回答“我是虾导，DramaClaw "
    "的小说转视频创作助手。”"
)

_IDENTITY_MEMORY_LINE = (
    "虾导在 DramaClaw 会话中面向用户自称“虾导”，不要自称 Hermes Agent，"
    "不要提 Nous Research 或底层代理框架。自我介绍时只回答“我是虾导”，"
    "不要附加“DramaClaw 的小说转视频创作助手”之类的头衔或职能描述。"
)

_OLD_MEMORY_LINE = (
    "DramaClaw 管理的 Hermes 会话中 `terminal` 被禁用（在 config.yaml "
    "disabled_toolsets 中），curl 等 shell 命令会被直接拒绝。调用 DramaClaw API "
    "时应使用已启用的 `dramaclaw` 插件 toolset 提供的内置 HTTP 工具，不要用 curl。"
)

_NEW_MEMORY_LINE = (
    "DramaClaw 管理的虾导会话中 `terminal` 被禁用（在 config.yaml "
    "disabled_toolsets 中），curl 等 shell 命令会被直接拒绝。调用 DramaClaw API "
    "时应使用已启用的 `hermes-acp` toolset 中的 DramaClaw 插件工具，不要用 curl。"
)

_OLD_SOUL_IDENTITY_TEXT = (
    "你是虾导，DramaClaw 的小说转视频创作助手。用户问“你是谁 / 你叫什么 / "
    "你是什么助手 / 介绍一下你自己”时，直接回答“我是虾导，"
    "DramaClaw 的小说转视频创作助手。”"
)


def ensure_user_hermes_workspace(
    username: str,
    *,
    profile: str = "director",
    project_state_dir: str | Path | None = None,
) -> Path:
    """Create / refresh a managed HERMES_HOME. Idempotent and cheap.

    Home-scoped agents keep the legacy per-user workspace. Project-scoped
    agents live below the authoritative project state directory so Hermes'
    native ``state.db`` and ``memories/`` follow the project across home-node
    backup and restore operations.

    Layout under ``state/{username}/.hermes/`` (home scope) or
    ``{project_state_dir}/agents/hermes/{profile}/`` (project scope):
        config.yaml         L1 toolset whitelist (overwritten only if missing)
        .env                compatibility file (model credentials are not stored)
        tmp/                per-user TMPDIR (sandbox writable)
        skills/
            _user/          per-user / hermes-learned skills (writable)
            <name>/         softlink → repo .hermes/skills/<name>

    Returns the HERMES_HOME path (caller passes as ``HERMES_HOME`` env var).
    """
    normalized_profile = "freezone" if profile == "freezone" else "director"
    if project_state_dir is not None:
        home = Path(project_state_dir) / "agents" / "hermes" / normalized_profile
    else:
        home_name = ".hermes-freezone" if normalized_profile == "freezone" else ".hermes"
        home = _state_root() / username / home_name
    home.mkdir(parents=True, exist_ok=True)
    try:
        home.chmod(0o700)
    except OSError:
        pass  # filesystem may not support (e.g. some mounts)

    # per-user TMPDIR (sandbox profile only allows write here)
    tmp_dir = home / "tmp"
    tmp_dir.mkdir(exist_ok=True)
    try:
        tmp_dir.chmod(0o700)
    except OSError:
        pass

    # skills layout
    skills_dir = home / "skills"
    skills_dir.mkdir(exist_ok=True)
    (skills_dir / "_user").mkdir(exist_ok=True)
    _materialize_skill_links(skills_dir, profile=normalized_profile)
    if normalized_profile == "freezone":
        _sync_freezone_workflow_skills(skills_dir, username)

    # plugins layout
    plugins_dir = home / "plugins"
    plugins_dir.mkdir(exist_ok=True)
    _materialize_plugin_links(plugins_dir, profile=normalized_profile)

    # hermes config (only write if missing — user may have customized)
    config_yaml = home / "config.yaml"
    if not config_yaml.exists():
        config_yaml.write_text(
            _default_freezone_config_yaml()
            if normalized_profile == "freezone"
            else _default_config_yaml(),
            encoding="utf-8",
        )
    if normalized_profile == "freezone":
        _ensure_freezone_config_policy(config_yaml)
        _ensure_freezone_python_hooks(home)
    else:
        _ensure_director_config_policy(config_yaml)
    _ensure_model_config_from_env(config_yaml)
    _ensure_model_gateway_config(config_yaml)
    _ensure_identity_context(home, profile=normalized_profile)

    # Hermes profile secret scoping reads this file, so keep the managed
    # NewAPI key synchronized with the UI-selected gateway.
    env_file = home / ".env"
    if not env_file.exists():
        env_file.write_text(_DEFAULT_ENV_TEMPLATE, encoding="utf-8")
        try:
            env_file.chmod(0o600)
        except OSError:
            pass
    _remove_managed_model_env_values(env_file)
    _ensure_gateway_env_file(env_file)

    return home


def list_freezone_hermes_workflow_skills(username: str) -> list[dict[str, object]]:
    """Return Workflow Skills materialized in the user's native Hermes profile."""
    home = ensure_user_hermes_workspace(username, profile="freezone")
    summaries: list[dict[str, object]] = []
    for skill_dir in sorted((home / "skills").iterdir(), key=lambda item: item.name):
        marker = skill_dir / _GENERATED_WORKFLOW_SKILL_MARKER
        if not skill_dir.is_dir() or not marker.is_file():
            continue
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(payload, dict) and payload.get("id"):
            summaries.append(payload)
    return summaries


def sync_freezone_hermes_workflow_skills(username: str) -> None:
    """Refresh generated Hermes wrappers for saved Freezone Workflow Skills."""
    ensure_user_hermes_workspace(username, profile="freezone")


def freezone_python_hook_dir(home: Path) -> Path:
    return home / FREEZONE_HERMES_PYTHON_HOOK_DIR


def _ensure_freezone_python_hooks(home: Path) -> None:
    hook_dir = freezone_python_hook_dir(home)
    hook_dir.mkdir(exist_ok=True)
    sitecustomize = hook_dir / "sitecustomize.py"
    if sitecustomize.exists():
        try:
            if sitecustomize.read_text(encoding="utf-8") == _FREEZONE_SITECUSTOMIZE_PY:
                return
        except OSError:
            pass
    sitecustomize.write_text(_FREEZONE_SITECUSTOMIZE_PY, encoding="utf-8")


def _parse_env_assignments(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key.removeprefix("export ").strip()
        if key:
            values[key] = value.strip().strip('"').strip("'")
    return values





def _ensure_gateway_env_file(env_file: Path) -> None:
    """Leave the workspace ``.env`` without a gateway credential.

    Kept as a named step rather than deleted at the call site so the intent
    stays visible: this file used to hold ``NEWAPI_API_KEY`` and
    ``OPENAI_API_KEY``, Hermes still reads it at startup, and a future change
    that puts a key back here would otherwise look like restoring a helpful
    default rather than reopening a hole.
    """
    # Never written. Workers authenticate per turn, unconditionally, so a key
    # here is exposure that buys nothing: `build_hermes_child_env` gives every
    # worker a placeholder and the per-turn latch, and no value in this file
    # will authenticate anything.
    #
    # A `legacy_environment` escape hatch used to live here and was worse than
    # none at all. It restored the real key to disk while the child environment
    # kept the placeholder and the latch, so a "legacy" deployment got the
    # exposure of the old design together with the behaviour of the new one:
    # the worker still failed closed, and now a live credential sat on disk as
    # well. Half a compatibility mode is more dangerous than none, because it
    # reads as a supported path.
    #
    # `_remove_managed_model_env_values` runs before this, so returning here
    # also migrates a workspace written before the rule existed.
    return


def _ensure_identity_context(home: Path, *, profile: str = "director") -> None:
    """Keep user-visible assistant identity consistent across all workspaces."""
    if profile == "freezone":
        _ensure_freezone_identity_context(home)
        return

    soul_file = home / "SOUL.md"
    try:
        if soul_file.exists():
            text = soul_file.read_text(encoding="utf-8")
            if _OLD_SOUL_PREFIX in text:
                text = text.replace(_OLD_SOUL_PREFIX, _DEFAULT_SOUL_MD.strip(), 1)
            elif "你是虾导" not in text:
                text = _DEFAULT_SOUL_MD.rstrip() + "\n\n" + text
            text = text.replace(_OLD_SOUL_IDENTITY_TEXT, "你是虾导。")
            soul_file.write_text(text.rstrip() + "\n", encoding="utf-8")
        else:
            soul_file.write_text(_DEFAULT_SOUL_MD, encoding="utf-8")
    except OSError:
        _log.warning("failed to ensure hermes SOUL.md at %s", soul_file)

    memories_dir = home / "memories"
    try:
        memories_dir.mkdir(exist_ok=True)
        memory_file = memories_dir / "MEMORY.md"
        if memory_file.exists():
            text = memory_file.read_text(encoding="utf-8")
            text = text.replace(_OLD_IDENTITY_MEMORY_LINE, _IDENTITY_MEMORY_LINE)
            text = text.replace(_OLD_MEMORY_LINE, _NEW_MEMORY_LINE)
            if _IDENTITY_MEMORY_LINE not in text:
                text = _IDENTITY_MEMORY_LINE + "\n§\n" + text.lstrip()
            memory_file.write_text(text.rstrip() + "\n", encoding="utf-8")
        else:
            memory_file.write_text(_DEFAULT_MEMORY_MD, encoding="utf-8")
    except OSError:
        _log.warning("failed to ensure hermes MEMORY.md under %s", memories_dir)


def _ensure_freezone_identity_context(home: Path) -> None:
    """Keep the Freezone assistant identity separate from the director profile."""
    soul_file = home / "SOUL.md"
    try:
        if not soul_file.exists():
            soul_file.write_text(_FREEZONE_SOUL_MD, encoding="utf-8")
    except OSError:
        _log.warning("failed to ensure freezone hermes SOUL.md at %s", soul_file)

    memories_dir = home / "memories"
    try:
        memories_dir.mkdir(exist_ok=True)
        memory_file = memories_dir / "MEMORY.md"
        if not memory_file.exists():
            memory_file.write_text(_FREEZONE_MEMORY_MD, encoding="utf-8")
    except OSError:
        _log.warning(
            "failed to ensure freezone hermes MEMORY.md under %s", memories_dir
        )


def _freezone_workflow_skill_items(username: str) -> list[dict]:
    try:
        from novelvideo.freezone.agent_config_store import list_user_agent_config_items

        items = list_user_agent_config_items(username, "skills")
    except Exception as exc:
        _log.warning(
            "failed to load Freezone Workflow Skills for %s: %s", username, exc
        )
        return []
    return [
        item
        for item in items
        if item.get("enabled") is not False
        and item.get("hidden") is not True
        and isinstance(
            item.get("allowed_recipe_ids") or item.get("allowedRecipeIds"),
            list,
        )
        and bool(item.get("allowed_recipe_ids") or item.get("allowedRecipeIds"))
    ]


def _workflow_skill_description(item: dict) -> str:
    description = str(item.get("description") or "").strip()
    triggers = item.get("triggers") if isinstance(item.get("triggers"), dict) else {}
    keywords = triggers.get("keywords") if isinstance(triggers, dict) else []
    keyword_text = (
        "、".join(str(value).strip() for value in keywords[:10] if str(value).strip())
        if isinstance(keywords, list)
        else ""
    )
    parts = [description]
    if keyword_text:
        parts.append(f"适用于：{keyword_text}。")
    parts.append("选择后使用虾画确定性工具生成动态工作流。")
    return " ".join(part for part in parts if part)[:1024]


def _render_workflow_skill(item: dict) -> tuple[str, dict[str, object]]:
    skill_id = str(item.get("id") or "").strip()
    display_name = str(
        item.get("name")
        or item.get("display_name")
        or item.get("displayName")
        or item.get("title")
        or skill_id
    ).strip()
    description = _workflow_skill_description(item)
    frontmatter = yaml.safe_dump(
        {"name": skill_id, "description": description},
        allow_unicode=True,
        sort_keys=False,
    ).strip()
    content = f"""---
{frontmatter}
---

# {display_name}

这是虾画 Workflow Skill `{skill_id}` 的 Hermes 原生选择入口。

## 执行规则

1. 本 Skill 已由用户明确选择。只调用一次 `freezone_get_workflow_skill`，固定传入 `skill_id=\"{skill_id}\"` 和 `compact=true`；不要再次选择或替换 Skill。只补充 `input_contract.missing_required`，不要重复询问已经推断或有默认值的参数。
2. 生成精简 `freezone_workflow_intent.v1`，以结构化 JSON 对象（不是字符串）调用 `freezone_prepare_workflow_draft`。工具会为这份确切 intent 返回报价；若需计费，展示确切报价并停止本轮，要求用户按工具返回的完整文本回复“确认规划费用 <quote_id>”；只有服务端确认该显式报价后签发可信 `confirmation_receipt`，才能用完全相同的参数重试。不要伪造凭证、传 `draft_id` 或调用 `execute_code`。
3. 返回草稿后，严格按预览向用户确认，同时展示创建工作流所需的 `agent_credit_estimate.display`，并说明图片、音频、视频等节点生成积分另计。
4. 用户调整方案时调用 `freezone_patch_workflow_draft`，只提交发生变化的字段；修改规划也必须按工具返回的报价等待用户回复“确认修改费用”，再携带服务端凭证重试，不能把修改请求本身视为扣费确认。
5. 用户确认方案后调用 `freezone_confirm_workflow_draft`；若需创建费用确认，等待用户回复“确认创建费用”并携带服务端凭证重试，始终使用已确认的 draft_id 和 revision。
6. Recipe 选择、节点展开、稳定 ID、连线、布局和合成全部交给工具；不要手写 WorkflowPlan 或逐节点创建。

## 业务说明

{description}
"""
    summary: dict[str, object] = {
        "id": skill_id,
        "name": display_name,
        "description": description,
        "category": str(item.get("category") or "").strip(),
        "source": "hermes_native_workflow_skill",
        "allowed_recipe_ids": list(
            item.get("allowed_recipe_ids") or item.get("allowedRecipeIds") or []
        ),
    }
    return content, summary


def _sync_freezone_workflow_skills(skills_dir: Path, username: str) -> None:
    desired: dict[str, tuple[str, dict[str, object]]] = {}
    for item in _freezone_workflow_skill_items(username):
        skill_id = str(item.get("id") or "").strip()
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,127}", skill_id):
            continue
        desired[skill_id] = _render_workflow_skill(item)

    for entry in skills_dir.iterdir():
        marker = entry / _GENERATED_WORKFLOW_SKILL_MARKER
        if entry.is_dir() and marker.is_file() and entry.name not in desired:
            try:
                shutil.rmtree(entry)
            except OSError:
                _log.warning("failed to remove stale generated Hermes Skill %s", entry)

    for skill_id, (content, summary) in desired.items():
        target = skills_dir / skill_id
        marker = target / _GENERATED_WORKFLOW_SKILL_MARKER
        if target.is_symlink() or (target.exists() and not marker.is_file()):
            _log.warning(
                "native Hermes Skill collision at %s; skipping generated wrapper",
                target,
            )
            continue
        try:
            target.mkdir(parents=True, exist_ok=True)
            skill_file = target / "SKILL.md"
            marker_text = json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
            if (
                not skill_file.exists()
                or skill_file.read_text(encoding="utf-8") != content
            ):
                skill_file.write_text(content, encoding="utf-8")
            if not marker.exists() or marker.read_text(encoding="utf-8") != marker_text:
                marker.write_text(marker_text, encoding="utf-8")
        except OSError as exc:
            _log.warning(
                "failed to materialize Hermes Workflow Skill %s: %s", skill_id, exc
            )


def _materialize_skill_links(skills_dir: Path, *, profile: str = "director") -> None:
    """Create / refresh symlinks from skills_dir/<name> → repo-pinned skills.

    The source of truth is ``DramaClaw/.hermes/skills/`` so a fresh checkout
    has the same Hermes skills on every machine.

    Idempotent: stale links to dirs that no longer exist in the source are
    removed; new skills are added; existing real directories are left alone.
    """
    src_skills = DRAMACLAW_ROOT / ".hermes" / "skills"
    if not src_skills.is_dir():
        _log.info(
            "hermes skills source not found at %s — skipping skill links",
            src_skills,
        )
        return

    env_name = (
        "ST_HERMES_FREEZONE_SKILLS" if profile == "freezone" else "ST_HERMES_SKILLS"
    )
    defaults = (
        FREEZONE_HERMES_SKILLS if profile == "freezone" else DEFAULT_HERMES_SKILLS
    )
    allowed = {
        name.strip()
        for name in os.environ.get(env_name, ",".join(sorted(defaults))).split(",")
        if name.strip()
    }
    want = {
        p.name: p.resolve()
        for p in src_skills.iterdir()
        if p.is_dir() and (not allowed or p.name in allowed)
    }

    # Add / refresh links
    for name, target in want.items():
        if name.startswith("_"):
            continue  # reserve `_user` for hermes-learned
        link = skills_dir / name
        if link.is_symlink():
            try:
                if link.resolve() == target:
                    continue
                link.unlink()  # stale → recreate
            except OSError:
                continue
        elif link.exists():
            # User-installed real dir with same name; do not clobber.
            _log.warning(
                "skill name collision at %s (not a symlink); leaving as-is",
                link,
            )
            continue
        try:
            link.symlink_to(target)
        except OSError as e:
            _log.warning("failed to link %s → %s: %s", link, target, e)

    # Remove stale symlinks (skill removed from repo mirror)
    for entry in skills_dir.iterdir():
        if entry.name == "_user" or not entry.is_symlink():
            continue
        if entry.name not in want:
            try:
                entry.unlink()
            except OSError:
                pass


def _ensure_default_plugin_enabled(config_yaml: Path) -> None:
    """Non-destructively add repo default plugins to legacy configs."""
    try:
        text = config_yaml.read_text(encoding="utf-8")
    except OSError:
        return
    missing = [
        name
        for name in sorted(DEFAULT_HERMES_PLUGINS)
        if not re.search(rf"(?m)^    - {re.escape(name)}(?:\s*(?:#.*)?)?$", text)
    ]
    if not missing:
        return
    if "plugins:" not in text:
        plugin_names = "\n".join(f"    - {name}" for name in missing)
        new_text = text.rstrip() + f"\nplugins:\n  enabled:\n{plugin_names}\n"
    elif re.search(r"(?m)^  enabled:\s*$", text):
        new_text = re.sub(
            r"(?m)^  enabled:\s*$",
            lambda m: (
                m.group(0)
                + "\n"
                + "".join(f"    - {name}\n" for name in missing).rstrip()
            ),
            text,
            count=1,
        )
    else:
        new_text = re.sub(
            r"(?m)^plugins:\s*$",
            lambda m: (
                m.group(0)
                + "\n  enabled:\n"
                + "".join(f"    - {name}\n" for name in missing).rstrip()
            ),
            text,
            count=1,
        )
    if new_text == text:
        return
    try:
        config_yaml.write_text(new_text.rstrip() + "\n", encoding="utf-8")
    except OSError:
        return


def _configured_max_turns(env_name: str, default: int) -> int:
    raw = _root_value(env_name)
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        _log.warning("invalid %s=%r, using default %d", env_name, raw, default)
        return default


def _configured_tool_search_mode() -> str:
    """Freezone Tool Search mode: "auto" (default) | "on" | "off".

    "auto" lets Hermes defer the freezone plugin tool schemas behind its
    tool_search/tool_describe/tool_call bridge when they would exceed the
    context-window threshold, instead of serializing all of them every turn.
    """
    raw = str(_root_value("HERMES_TOOL_SEARCH_MODE") or "").strip().lower()
    if raw in {"auto", "on", "off"}:
        return raw
    if raw:
        _log.warning("invalid HERMES_TOOL_SEARCH_MODE=%r, using default 'auto'", raw)
    return "auto"


def _ensure_director_config_policy(config_yaml: Path) -> None:
    """Keep the outer assistant on a small, DramaClaw-only agent surface."""
    try:
        text = config_yaml.read_text(encoding="utf-8")
    except OSError:
        return
    try:
        config = yaml.safe_load(text) or {}
    except yaml.YAMLError:
        _log.warning("failed to parse director hermes config yaml at %s", config_yaml)
        return
    if not isinstance(config, dict):
        config = {}

    config["enabled_toolsets"] = ["hermes-acp", "memory"]
    plugins = config.get("plugins")
    if not isinstance(plugins, dict):
        plugins = {}
    plugins["enabled"] = ["dramaclaw"]
    config["plugins"] = plugins

    agent = config.get("agent")
    if not isinstance(agent, dict):
        agent = {}
    agent["max_turns"] = _configured_max_turns("HERMES_DIRECTOR_MAX_TURNS", 4)
    config["agent"] = agent

    try:
        config_yaml.write_text(_dump_hermes_config_yaml(config), encoding="utf-8")
    except OSError:
        _log.warning("failed to enforce director hermes config policy at %s", config_yaml)


def _ensure_freezone_config_policy(config_yaml: Path) -> None:
    """Force the Freezone Hermes profile to expose only canvas-oriented tools."""
    try:
        text = config_yaml.read_text(encoding="utf-8")
    except OSError:
        return
    try:
        config = yaml.safe_load(text) or {}
    except yaml.YAMLError:
        _log.warning("failed to parse freezone hermes config yaml at %s", config_yaml)
        return
    if not isinstance(config, dict):
        config = {}

    config["enabled_toolsets"] = ["hermes-acp", "freezone-acp", "memory"]
    plugins = config.get("plugins")
    if not isinstance(plugins, dict):
        plugins = {}
    plugins["enabled"] = ["freezone"]
    config["plugins"] = plugins

    agent = config.get("agent")
    if not isinstance(agent, dict):
        agent = {}
    agent["max_turns"] = _configured_max_turns("HERMES_FREEZONE_MAX_TURNS", 12)
    # 虾画 worker 是画布 agent,不是 coding agent:关掉 Hermes 的 coding 姿态,
    # 否则每个 system prompt 多 ~3.9k 字符,且教模型用 registry 已禁用的
    # read_file/patch/terminal 等工具。
    agent["coding_context"] = "off"
    config["agent"] = agent

    tools = config.get("tools")
    if not isinstance(tools, dict):
        tools = {}
    tool_search = tools.get("tool_search")
    if not isinstance(tool_search, dict):
        tool_search = {}
    # Tool Search defaults to progressive disclosure so the Freezone plugin's
    # large schema catalog is not serialized on every model request. Operators
    # can set HERMES_TOOL_SEARCH_MODE=off for an explicit compatibility
    # rollback. skill_manage stays removed at registry level by sitecustomize
    # so Hermes cannot self-create project skills.
    tool_search["enabled"] = _configured_tool_search_mode()
    tools["tool_search"] = tool_search
    skill_manage = tools.get("skill_manage")
    if not isinstance(skill_manage, dict):
        skill_manage = {}
    skill_manage["enabled"] = "off"
    tools["skill_manage"] = skill_manage
    config["tools"] = tools

    disabled_toolsets = config.get("disabled_toolsets")
    if not isinstance(disabled_toolsets, list):
        disabled_toolsets = []
    disabled = [str(item).strip() for item in disabled_toolsets if str(item).strip()]
    for item in [
        "dramaclaw",
        "dramaclaw-acp",
        "bash",
        "shell",
        "terminal",
        "subprocess",
        "file_write",
        "file_read",
        "edit",
        "write",
        "read",
        "glob",
        "grep",
    ]:
        if item not in disabled:
            disabled.append(item)
    config["disabled_toolsets"] = disabled

    try:
        config_yaml.write_text(_dump_hermes_config_yaml(config), encoding="utf-8")
    except OSError:
        _log.warning(
            "failed to enforce freezone hermes config policy at %s", config_yaml
        )


def _ensure_default_toolsets_enabled(config_yaml: Path) -> None:
    """Non-destructively add repo default toolsets to legacy configs."""
    try:
        text = config_yaml.read_text(encoding="utf-8")
    except OSError:
        return
    original_text = text
    text = _migrate_acp_toolsets(text)
    missing = [
        name
        for name in sorted(DEFAULT_HERMES_TOOLSETS)
        if not re.search(rf"(?m)^  - {re.escape(name)}(?:\s*(?:#.*)?)?$", text)
    ]
    if not missing:
        if text == original_text:
            return
        try:
            config_yaml.write_text(text.rstrip() + "\n", encoding="utf-8")
        except OSError:
            return
        return
    if "enabled_toolsets:" not in text:
        addition = "enabled_toolsets:\n" + "".join(f"  - {name}\n" for name in missing)
        new_text = text.rstrip() + "\n\n" + addition
    else:
        new_text = re.sub(
            r"(?m)^enabled_toolsets:\s*$",
            lambda m: (
                m.group(0)
                + "\n"
                + "".join(f"  - {name}\n" for name in missing).rstrip()
            ),
            text,
            count=1,
        )
        if new_text == text:
            return
    try:
        config_yaml.write_text(new_text.rstrip() + "\n", encoding="utf-8")
    except OSError:
        return


def _migrate_acp_toolsets(text: str) -> str:
    """Collapse legacy plugin-specific toolsets into the ACP toolset."""
    if "enabled_toolsets:" not in text:
        return text
    legacy = DEFAULT_HERMES_PLUGINS
    lines = text.splitlines()
    out: list[str] = []
    in_toolsets = False
    inserted_acp = False
    saw_legacy = False
    saw_acp = False
    for line in lines:
        if re.match(r"^enabled_toolsets:\s*$", line):
            in_toolsets = True
            out.append(line)
            continue
        if in_toolsets:
            match = re.match(r"^(\s*)-\s*([^\s#]+)(.*)$", line)
            if match and len(match.group(1)) >= 2:
                name = match.group(2)
                if name in legacy:
                    saw_legacy = True
                    continue
                if name == "hermes-acp":
                    saw_acp = True
                out.append(line)
                continue
            if saw_legacy and not saw_acp and not inserted_acp:
                out.append("  - hermes-acp")
                inserted_acp = True
            in_toolsets = False
        out.append(line)
    if in_toolsets and saw_legacy and not saw_acp and not inserted_acp:
        out.append("  - hermes-acp")
    return "\n".join(out)


def _ensure_model_gateway_config(config_yaml: Path) -> None:
    """Reconcile the managed NewAPI provider without persisting its secret.

    Hermes 0.18 resolves ``custom_providers[].key_env`` from the subprocess
    environment. Existing workspaces are normalized lazily on their next spawn,
    so releases need no separate workspace migration.
    """
    try:
        text = config_yaml.read_text(encoding="utf-8")
    except OSError:
        return
    try:
        config = yaml.safe_load(text) or {}
    except yaml.YAMLError:
        _log.warning("failed to parse hermes config yaml at %s", config_yaml)
        return
    if not isinstance(config, dict):
        return
    model = config.get("model")
    if not isinstance(model, dict):
        model = {}
        config["model"] = model
    changed = False
    desired_model = {
        "default": _hermes_model_default(),
        "provider": _DRAMACLAW_HERMES_PROVIDER,
        "context_length": int(_hermes_model_context_length()),
    }
    for key, value in desired_model.items():
        if model.get(key) != value:
            model[key] = value
            changed = True
    for secret_or_legacy_key in ("api_key", "api", "base_url"):
        if secret_or_legacy_key in model:
            model.pop(secret_or_legacy_key, None)
            changed = True

    providers = config.get("custom_providers")
    if not isinstance(providers, list):
        providers = []
        config["custom_providers"] = providers
        changed = True
    managed_provider = next(
        (
            item
            for item in providers
            if isinstance(item, dict)
            and str(item.get("name") or "").strip().lower()
            == _DRAMACLAW_HERMES_PROVIDER_NAME
        ),
        None,
    )
    if managed_provider is None:
        managed_provider = {"name": _DRAMACLAW_HERMES_PROVIDER_NAME}
        providers.append(managed_provider)
        changed = True
    desired_provider = {
        "name": _DRAMACLAW_HERMES_PROVIDER_NAME,
        "base_url": _newapi_base_url(),
        "key_env": _DRAMACLAW_HERMES_KEY_ENV,
        "api_mode": _hermes_model_api_mode(),
    }
    for key, value in desired_provider.items():
        if managed_provider.get(key) != value:
            managed_provider[key] = value
            changed = True
    for secret_key in ("api_key", "api"):
        if secret_key in managed_provider:
            managed_provider.pop(secret_key, None)
            changed = True
    if not changed:
        return
    try:
        config_yaml.write_text(_dump_hermes_config_yaml(config), encoding="utf-8")
    except OSError:
        _log.warning("failed to sync managed model gateway into %s", config_yaml)


class _IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow, False)


def _dump_hermes_config_yaml(config: dict) -> str:
    return yaml.dump(
        config,
        Dumper=_IndentedSafeDumper,
        allow_unicode=True,
        sort_keys=False,
    )


def _ensure_model_config_from_env(config_yaml: Path) -> None:
    """Apply explicit Hermes model env overrides to existing config.yaml files."""
    overrides: dict[str, object] = {}
    model = _root_value(
        "HERMES_MODEL", "HERMES_MODEL_DEFAULT", "DRAMACLAW_HERMES_MODEL"
    )
    if model:
        overrides["default"] = model
    api_mode = _root_value("HERMES_MODEL_API_MODE")
    if api_mode:
        overrides["api_mode"] = api_mode
    context_length = _root_value("HERMES_MODEL_CONTEXT_LENGTH")
    if context_length:
        overrides["context_length"] = int(_hermes_model_context_length())
    if not overrides:
        return
    try:
        text = config_yaml.read_text(encoding="utf-8")
    except OSError:
        return
    try:
        config = yaml.safe_load(text) or {}
    except yaml.YAMLError:
        _log.warning("failed to parse hermes config yaml at %s", config_yaml)
        return
    if not isinstance(config, dict):
        return
    config_model = config.setdefault("model", {})
    if not isinstance(config_model, dict):
        config_model = {}
        config["model"] = config_model
    changed = False
    for key, value in overrides.items():
        if config_model.get(key) != value:
            config_model[key] = value
            changed = True
    if not changed:
        return
    try:
        config_yaml.write_text(_dump_hermes_config_yaml(config), encoding="utf-8")
    except OSError:
        _log.warning("failed to apply hermes model env overrides to %s", config_yaml)


def _materialize_plugin_links(plugins_dir: Path, *, profile: str = "director") -> None:
    """Create / refresh symlinks from plugins_dir/<name> → repo-pinned plugins."""
    src_plugins = DRAMACLAW_ROOT / ".hermes" / "plugins"
    if not src_plugins.is_dir():
        _log.info(
            "hermes plugins source not found at %s — skipping plugin links",
            src_plugins,
        )
        return

    env_name = (
        "ST_HERMES_FREEZONE_PLUGINS" if profile == "freezone" else "ST_HERMES_PLUGINS"
    )
    defaults = (
        FREEZONE_HERMES_PLUGINS if profile == "freezone" else DEFAULT_HERMES_PLUGINS
    )
    allowed = {
        name.strip()
        for name in os.environ.get(env_name, ",".join(sorted(defaults))).split(",")
        if name.strip()
    }
    want = {
        p.name: p.resolve()
        for p in src_plugins.iterdir()
        if p.is_dir() and (not allowed or p.name in allowed)
    }

    for name, target in want.items():
        if name.startswith("_"):
            continue
        link = plugins_dir / name
        if link.is_symlink():
            try:
                if link.resolve() == target:
                    continue
                link.unlink()
            except OSError:
                continue
        elif link.exists():
            _log.warning(
                "plugin name collision at %s (not a symlink); leaving as-is",
                link,
            )
            continue
        try:
            link.symlink_to(target)
        except OSError as e:
            _log.warning("failed to link %s → %s: %s", link, target, e)

    for entry in plugins_dir.iterdir():
        if not entry.is_symlink():
            continue
        if entry.name not in want:
            try:
                entry.unlink()
            except OSError:
                pass


__all__ = [
    "effective_gateway_credentials",
    "effective_gateway_fingerprint",
    "ensure_user_hermes_workspace",
    "list_freezone_hermes_workflow_skills",
    "sync_freezone_hermes_workflow_skills",
    "freezone_python_hook_dir",
]
