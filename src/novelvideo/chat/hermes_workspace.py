"""Per-user Hermes workspace initialization.

Owns one job: idempotently materialize ``state/{user}/.hermes/`` to be a
working HERMES_HOME — with sandbox-friendly tmpdir, repo-pinned skill
softlinks, a starter config.yaml, and a .env template for LLM credentials.

Kept separate from chat_service.py so the latter stays small. Designed to be
safe to call on every HermesPool.spawn() (cheap when already initialized).
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

import yaml

_log = logging.getLogger(__name__)

DRAMACLAW_ROOT = Path(__file__).resolve().parents[3]
STATE_ROOT = DRAMACLAW_ROOT / "state"
DEFAULT_HERMES_SKILLS = {"dramaclaw"}
DEFAULT_HERMES_PLUGINS = {"dramaclaw"}
DEFAULT_HERMES_TOOLSETS = {"hermes-acp"}
_warned_repo_state_fallback = False


_DEFAULT_HERMES_MODEL = "qwen-plus"
_DEFAULT_HERMES_MODEL_PROVIDER = "custom"
_DEFAULT_HERMES_MODEL_API_MODE = "chat_completions"
_DEFAULT_HERMES_MODEL_CONTEXT_LENGTH = "131072"

_CONFIG_YAML_TEMPLATE = """# DramaClaw-managed hermes config.
# Toolset whitelist enforces L1 defense (no direct file write / shell).
#
# Edit with care; this file may be regenerated.
#
# Model routes through the selected NewAPI gateway (OpenAI-compatible), unified
# with the video/image generators. The `custom` provider reads its endpoint from
# `base_url` and its key from `api_key` below. Both are sourced from the CE
# effective model gateway config: settings.db first, root .env as fallback.

model:
  default: {model}
  provider: {provider}
  base_url: {base_url}
  api_key: {api_key}
  api_mode: {api_mode}
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


_DEFAULT_ENV_TEMPLATE = """# LLM provider credentials for this user's hermes worker.
# Hermes reads these on startup.  Host environment variables are NOT inherited
# (HermesSdkClient strictly whitelists env), so put your keys here.
#
# Unified on the new-api gateway: OPENAI_API_KEY here is filled from the CE
# effective model gateway config so sandboxed Hermes sees the same selected
# credentials as the UI and video/image generators.

# OPENAI_API_KEY=
# OPENROUTER_API_KEY=
# ANTHROPIC_API_KEY=
# NOUS_PORTAL_KEY=
"""

# Per-user hermes .env var  ->  ordered root-.env var names to source it from.
# We re-expose the root NEWAPI_API_KEY as OPENAI_API_KEY because the hermes
# `custom` provider only reads OPENAI_API_KEY (it has no NEWAPI_* awareness).
# The sandboxed worker never inherits the host env, so this rename is local to
# the workspace .env and cannot collide with the host's real OPENAI_API_KEY.
_ROOT_ENV_KEYS_FOR_HERMES = {
    "OPENAI_API_KEY": ("NEWAPI_API_KEY",),
}


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
    """Return effective NewAPI ``(api_key, base_url)`` for Hermes.

    The official gateway URL is fixed in code. Root .env values are only used
    as key/custom-gateway fallback, and settings.db wins when the UI selected a
    custom NewAPI channel.
    """
    from novelvideo.model_gateway_settings import get_effective_newapi_config
    from novelvideo.model_gateway_settings import MODE_CUSTOM
    from novelvideo.model_gateway_settings import normalize_relay_base_url
    from novelvideo.official_defaults import OFFICIAL_NEWAPI_BASE_URL

    root_base_url = _root_value("NEWAPI_BASE_URL")
    root_api_key = _root_value("NEWAPI_API_KEY")
    gateway = get_effective_newapi_config(
        official_base_url=OFFICIAL_NEWAPI_BASE_URL,
        official_api_key=root_api_key,
    )
    if gateway.mode == MODE_CUSTOM and gateway.base_url:
        return gateway.api_key, gateway.base_url
    if root_base_url:
        return root_api_key, normalize_relay_base_url(root_base_url)
    return gateway.api_key, gateway.base_url


def _newapi_base_url() -> str:
    return _root_value("HERMES_MODEL_BASE_URL") or _effective_newapi_gateway()[1]


def _hermes_model_default() -> str:
    return _root_value(
        "HERMES_MODEL",
        "HERMES_MODEL_DEFAULT",
        "DRAMACLAW_HERMES_MODEL",
    ) or _DEFAULT_HERMES_MODEL


def _hermes_model_provider() -> str:
    return _root_value("HERMES_MODEL_PROVIDER") or _DEFAULT_HERMES_MODEL_PROVIDER


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
    api_key, _base_url = _effective_newapi_gateway()
    return _CONFIG_YAML_TEMPLATE.format(
        model=_hermes_model_default(),
        provider=_hermes_model_provider(),
        base_url=_newapi_base_url(),
        api_key=api_key,
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

_DEFAULT_MEMORY_MD = """虾导在 DramaClaw 会话中面向用户自称“虾导”，不要自称 Hermes Agent，不要提 Nous Research 或底层代理框架。自我介绍时只回答“我是虾导”，不要附加“DramaClaw 的小说转视频创作助手”之类的头衔或职能描述。
§
DramaClaw 管理的虾导会话中 `terminal` 被禁用（在 config.yaml disabled_toolsets 中），curl 等 shell 命令会被直接拒绝。调用 DramaClaw API 时应使用已启用的 `hermes-acp` toolset 中的 DramaClaw 插件工具，不要用 curl。
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


def ensure_user_hermes_workspace(username: str) -> Path:
    """Create / refresh per-user HERMES_HOME. Idempotent and cheap.

    Layout under ``state/{username}/.hermes/``:
        config.yaml         L1 toolset whitelist (overwritten only if missing)
        .env                LLM provider credentials template (user-managed)
        tmp/                per-user TMPDIR (sandbox writable)
        skills/
            _user/          per-user / hermes-learned skills (writable)
            <name>/         softlink → repo .hermes/skills/<name>

    Returns the HERMES_HOME path (caller passes as ``HERMES_HOME`` env var).
    """
    home = _state_root() / username / ".hermes"
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
    _materialize_skill_links(skills_dir)

    # plugins layout
    plugins_dir = home / "plugins"
    plugins_dir.mkdir(exist_ok=True)
    _materialize_plugin_links(plugins_dir)

    # hermes config (only write if missing — user may have customized)
    config_yaml = home / "config.yaml"
    if not config_yaml.exists():
        config_yaml.write_text(_default_config_yaml(), encoding="utf-8")
    _ensure_default_plugin_enabled(config_yaml)
    _ensure_default_toolsets_enabled(config_yaml)
    _ensure_model_config_from_env(config_yaml)
    _ensure_model_api_key(config_yaml)
    _ensure_identity_context(home)

    # .env template (only write if missing — never overwrite user's keys)
    env_file = home / ".env"
    if not env_file.exists():
        env_file.write_text(_env_template_with_root_defaults(), encoding="utf-8")
        try:
            env_file.chmod(0o600)
        except OSError:
            pass
    else:
        _ensure_root_env_defaults(env_file)

    return home


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


def _root_env_defaults() -> dict[str, str]:
    """Map root-.env credentials into per-user hermes .env names.

    Returns ``{hermes_env_var: value}`` so the worker .env carries the keys the
    hermes provider expects, while the secret of record stays in the root .env.
    """
    defaults: dict[str, str] = {}
    api_key, _base_url = _effective_newapi_gateway()
    if api_key:
        defaults["OPENAI_API_KEY"] = api_key
    return defaults


def _env_template_with_root_defaults() -> str:
    defaults = _root_env_defaults()
    if not defaults:
        return _DEFAULT_ENV_TEMPLATE
    lines = _DEFAULT_ENV_TEMPLATE.rstrip().splitlines()
    for key, value in defaults.items():
        commented = f"# {key}="
        plain = f"{key}="
        for index, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith(commented) or stripped.startswith(plain):
                lines[index] = f"{key}={value}"
                break
        else:
            lines.append(f"{key}={value}")
    return "\n".join(lines).rstrip() + "\n"


def _ensure_root_env_defaults(env_file: Path) -> None:
    defaults = _root_env_defaults()
    if not defaults:
        return
    try:
        text = env_file.read_text(encoding="utf-8")
    except OSError:
        return
    current = _parse_env_assignments(text)
    missing = {key: value for key, value in defaults.items() if not current.get(key)}
    if not missing:
        return
    suffix = "\n" if text.endswith("\n") else "\n\n"
    additions = "\n".join(f"{key}={value}" for key, value in missing.items())
    try:
        env_file.write_text(
            text.rstrip() + suffix + "# Filled from DramaClaw root .env\n" + additions + "\n",
            encoding="utf-8",
        )
    except OSError:
        _log.warning("failed to fill hermes .env defaults at %s", env_file)


def _ensure_identity_context(home: Path) -> None:
    """Keep user-visible assistant identity consistent across all workspaces."""
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


def _materialize_skill_links(skills_dir: Path) -> None:
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

    allowed = {
        name.strip()
        for name in os.environ.get(
            "ST_HERMES_SKILLS",
            ",".join(sorted(DEFAULT_HERMES_SKILLS)),
        ).split(",")
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
    """Non-destructively add the repo default plugin block to legacy configs."""
    try:
        text = config_yaml.read_text(encoding="utf-8")
    except OSError:
        return
    if "plugins:" in text:
        return
    plugin_names = "\n".join(f"    - {name}" for name in sorted(DEFAULT_HERMES_PLUGINS))
    addition = f"\nplugins:\n  enabled:\n{plugin_names}\n"
    try:
        config_yaml.write_text(text.rstrip() + addition + "\n", encoding="utf-8")
    except OSError:
        return


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
            lambda m: m.group(0) + "\n" + "".join(f"  - {name}\n" for name in missing).rstrip(),
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


def _ensure_model_api_key(config_yaml: Path) -> None:
    """Sync server-owned custom-provider endpoint/key into existing configs.

    Hermes >=0.15 reads the ``custom`` provider's key from ``model.api_key`` in
    config.yaml, NOT from the workspace .env. These endpoint/key fields are
    server-owned and sourced from the effective NewAPI gateway, so existing user
    workspaces must follow UI channel changes, key rotation, and gateway moves.
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
        return
    if str(model.get("provider") or "").strip() != "custom":
        return
    changed = False
    api_key, _base_url = _effective_newapi_gateway()
    if api_key and model.get("api_key") != api_key:
        model["api_key"] = api_key
        changed = True
    base_url = _newapi_base_url()
    if base_url and model.get("base_url") != base_url:
        model["base_url"] = base_url
        changed = True
    if not changed:
        return
    try:
        config_yaml.write_text(_dump_hermes_config_yaml(config), encoding="utf-8")
    except OSError:
        _log.warning("failed to sync model endpoint/key into %s", config_yaml)


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
    model = _root_value("HERMES_MODEL", "HERMES_MODEL_DEFAULT", "DRAMACLAW_HERMES_MODEL")
    if model:
        overrides["default"] = model
    provider = _root_value("HERMES_MODEL_PROVIDER")
    if provider:
        overrides["provider"] = provider
    base_url = _root_value("HERMES_MODEL_BASE_URL")
    if base_url:
        overrides["base_url"] = base_url
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


def _materialize_plugin_links(plugins_dir: Path) -> None:
    """Create / refresh symlinks from plugins_dir/<name> → repo-pinned plugins."""
    src_plugins = DRAMACLAW_ROOT / ".hermes" / "plugins"
    if not src_plugins.is_dir():
        _log.info(
            "hermes plugins source not found at %s — skipping plugin links",
            src_plugins,
        )
        return

    allowed = {
        name.strip()
        for name in os.environ.get(
            "ST_HERMES_PLUGINS",
            ",".join(sorted(DEFAULT_HERMES_PLUGINS)),
        ).split(",")
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


__all__ = ["ensure_user_hermes_workspace"]
