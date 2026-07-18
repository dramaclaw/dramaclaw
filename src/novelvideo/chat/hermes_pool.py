"""Per-user Hermes worker pool.

Each user gets at most one HermesSdkClient instance (and one persistent
HermesSdkThread session that accumulates cross-project memory). Clients
are lazily spawned on first chat message and reaped after idle timeout
to control memory use.

Token lifecycle is managed here:
- Issue a fresh control-plane agent session on spawn (~2h TTL, scoped).
- Rotate the worker before its token expires because subprocess env cannot
  be updated in place.
- Revoke that agent session on thread close (subprocess death, idle reap, or shutdown).

The pool is intentionally simple (dict + asyncio.Lock); for multi-machine
deployment this should move behind the task worker/runtime boundary.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from novelvideo.chat.hermes_sdk import HermesSdkClient, HermesSdkThread
from novelvideo.chat.hermes_workspace import (
    effective_gateway_credentials,
    effective_gateway_fingerprint,
    ensure_user_hermes_workspace,
)
from novelvideo.ports import get_auth_session_port
from novelvideo.ports.auth_contract import AgentSessionToken

_log = logging.getLogger(__name__)

DEFAULT_IDLE_KILL_SECS = 30 * 60  # 30 min
DEFAULT_MAX_WORKERS = 50
DEFAULT_TOKEN_TTL_SECS = 2 * 3600  # 2 hours
DEFAULT_TOKEN_RENEW_SKEW_SECS = 15 * 60  # rotate 15 min before expiry
DEFAULT_API_URL = "http://127.0.0.1:8780"
DRAMACLAW_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_HERMES_VERSION = "0.18.0"
_checked_hermes_versions: dict[Path, str] = {}


def _load_api_url() -> str:
    explicit = os.environ.get("DRAMACLAW_API_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")

    dedicated = os.environ.get("NOVELVIDEO_API_URL", "").strip()
    if dedicated:
        return dedicated.rstrip("/")

    api_port = os.environ.get("NOVELVIDEO_API_PORT", "").strip()
    if api_port:
        host = os.environ.get("NOVELVIDEO_API_HOST", "127.0.0.1").strip() or "127.0.0.1"
        if host in {"0.0.0.0", "::"}:
            host = "127.0.0.1"
        return f"http://{host}:{api_port}"

    legacy = os.environ.get("SUPERTALE_API_URL", "").strip()
    if legacy:
        return legacy.rstrip("/")

    return DEFAULT_API_URL

# Scopes hermes worker tokens get by default. require_scope() factory
# enforces these on write endpoints.
HERMES_DEFAULT_SCOPES = [
    "projects:read",
    "projects:write",
    "tasks:submit",
    "tasks:poll",
    "media:read",
    "assets:read",
]


def _hermes_cli_path() -> Path:
    """Resolve the hermes binary. uv-tool install puts it in ~/.local/bin."""
    override = os.environ.get("HERMES_CLI_PATH", "").strip()
    if override:
        return Path(override)
    resolved = shutil.which("hermes")
    if resolved:
        return Path(resolved)
    return Path.home() / ".local" / "bin" / "hermes"


def is_hermes_backend_available() -> bool:
    return _hermes_cli_path().exists()


def _parse_hermes_version(output: str) -> tuple[int, int, int] | None:
    match = re.search(r"Hermes Agent v(\d+)\.(\d+)\.(\d+)", output)
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def _required_hermes_version() -> tuple[str, tuple[int, int, int]]:
    raw = os.environ.get("DRAMACLAW_HERMES_VERSION", "").strip()
    if not raw:
        try:
            raw = (DRAMACLAW_ROOT / ".hermes-version").read_text(encoding="utf-8").strip()
        except OSError:
            raw = DEFAULT_HERMES_VERSION
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", raw)
    if not match:
        raise RuntimeError(f"invalid DramaClaw Hermes version requirement: {raw!r}")
    return raw, tuple(int(part) for part in match.groups())


def _ensure_supported_hermes_version(cli_path: Path) -> None:
    if cli_path in _checked_hermes_versions:
        return
    required_text, required_version = _required_hermes_version()
    try:
        proc = subprocess.run(
            [str(cli_path), "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001 - surface a clear startup error
        raise RuntimeError(f"failed to check hermes version at {cli_path}: {exc}") from exc
    output = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
    version = _parse_hermes_version(output)
    if proc.returncode != 0 or version is None:
        raise RuntimeError(
            f"unable to determine hermes version from `{cli_path} --version`: {output[:500]}"
        )
    if version != required_version:
        current = ".".join(str(part) for part in version)
        raise RuntimeError(
            f"hermes {current} does not match DramaClaw's pinned version {required_text}. "
            "Run `scripts/setup-hermes.sh` and restart the API."
        )
    _checked_hermes_versions[cli_path] = output.splitlines()[0] if output else str(version)
    _log.info("using %s", _checked_hermes_versions[cli_path])


def _workspace_profile_for_agent(agent_profile: str, tool_mode: str, surface: str | None) -> str:
    if str(surface or "").strip() == "freezone":
        return "freezone"
    if (agent_profile or "").strip().startswith("freezone"):
        return "freezone"
    if (tool_mode or "").strip() == "freezone_canvas":
        return "freezone"
    return "director"


def canvas_bridge_dir_for_profile(home: Path, agent_profile: str) -> Path:
    base = home / "tmp" / "supertale_canvas_command_bridge"
    profile = (agent_profile or "").strip()
    if not profile.startswith("freezone:"):
        return base
    safe_profile = "".join(
        ch if ch.isalnum() or ch in {"-", "_"} else "_"
        for ch in profile
    ).strip("_")
    return base / (safe_profile or "freezone_main")


@dataclass
class _WorkerSlot:
    """One per active user."""

    username: str
    client: HermesSdkClient
    thread: HermesSdkThread
    token: AgentSessionToken
    model: str | None = None
    agent_profile: str = "main"
    tool_mode: str = "default"
    scope_kind: str = "home"
    project_id: str | None = None
    surface: str | None = None
    canvas_id: str | None = None
    gateway_fingerprint: str = ""
    last_used: float = field(default_factory=time.time)


class HermesPool:
    """Process-wide pool of per-user hermes workers.

    Single instance per DramaClaw process (see ``pool`` singleton at module bottom).
    """

    def __init__(
        self,
        *,
        idle_kill_secs: int = DEFAULT_IDLE_KILL_SECS,
        max_workers: int = DEFAULT_MAX_WORKERS,
        api_url: str | None = None,
        token_ttl_secs: int = DEFAULT_TOKEN_TTL_SECS,
        token_renew_skew_secs: int = DEFAULT_TOKEN_RENEW_SKEW_SECS,
    ) -> None:
        self._slots: dict[str, _WorkerSlot] = {}
        self._session_ids: dict[str, dict[tuple[str, str, str | None, str | None], str]] = {}
        self._lock = asyncio.Lock()
        self._idle_kill_secs = idle_kill_secs
        self._max_workers = max_workers
        self._api_url = (api_url or _load_api_url()).rstrip("/")
        self._token_ttl_secs = token_ttl_secs
        self._token_renew_skew_secs = token_renew_skew_secs
        self._cleanup_task: asyncio.Task | None = None
        self._warm_tasks: set[asyncio.Task] = set()

    async def get_for_user(
        self,
        username: str,
        *,
        model: str | None = None,
        agent_profile: str = "main",
        tool_mode: str = "default",
        scope_kind: str = "home",
        project_id: str | None = None,
        surface: str | None = None,
        canvas_id: str | None = None,
    ) -> HermesSdkThread:
        """Lazily create / return the per-user hermes thread.

        Bumps last_used so idle reaper resets the clock. Caller should
        ``await thread.stream(prompt)`` to send messages.
        """
        slot_key = self._slot_key(username, agent_profile)
        normalized_surface = (
            str(surface or "").strip()
            or ("freezone" if _workspace_profile_for_agent(agent_profile, tool_mode, surface) == "freezone" else "")
            or None
        )
        normalized_canvas_id = str(canvas_id or "").strip() or None
        async with self._lock:
            slot = self._slots.get(slot_key)
            if slot is not None:
                if bool(getattr(slot.thread, "is_closed", False)):
                    slot = await self._rotate_slot_locked(
                        slot,
                        model=model,
                        agent_profile=agent_profile,
                        tool_mode=tool_mode,
                        scope_kind=scope_kind,
                        project_id=project_id,
                        surface=normalized_surface,
                        canvas_id=normalized_canvas_id,
                        reason="thread-closed",
                    )
                elif slot.gateway_fingerprint != effective_gateway_fingerprint():
                    slot = await self._rotate_slot_locked(
                        slot,
                        model=model,
                        agent_profile=agent_profile,
                        tool_mode=tool_mode,
                        scope_kind=scope_kind,
                        project_id=project_id,
                        surface=normalized_surface,
                        canvas_id=normalized_canvas_id,
                        reason="model-gateway-change",
                    )
                elif self._token_needs_renewal(slot):
                    slot = await self._rotate_slot_locked(
                        slot,
                        model=model,
                        agent_profile=agent_profile,
                        tool_mode=tool_mode,
                        scope_kind=scope_kind,
                        project_id=project_id,
                        surface=normalized_surface,
                        canvas_id=normalized_canvas_id,
                        reason="agent-session-renewal",
                    )
                elif (
                    slot.scope_kind != scope_kind
                    or slot.project_id != project_id
                    or slot.agent_profile != agent_profile
                    or slot.tool_mode != tool_mode
                    or slot.surface != normalized_surface
                    or slot.canvas_id != normalized_canvas_id
                ):
                    slot = await self._rotate_slot_locked(
                        slot,
                        model=model,
                        agent_profile=agent_profile,
                        tool_mode=tool_mode,
                        scope_kind=scope_kind,
                        project_id=project_id,
                        surface=normalized_surface,
                        canvas_id=normalized_canvas_id,
                        reason="scope-env-change",
                    )
                else:
                    await self._update_scope_locked(slot, scope_kind, project_id)
                slot.last_used = time.time()
                return slot.thread

            await self._evict_lru_if_full()
            slot = await self._spawn_locked(
                username,
                model=model,
                agent_profile=agent_profile,
                tool_mode=tool_mode,
                scope_kind=scope_kind,
                project_id=project_id,
                surface=normalized_surface,
                canvas_id=normalized_canvas_id,
            )
            self._slots[slot_key] = slot
            # Ensure background reaper is running
            if self._cleanup_task is None or self._cleanup_task.done():
                self._cleanup_task = asyncio.create_task(self._reaper_loop())
            return slot.thread

    async def _spawn_locked(
        self,
        username: str,
        *,
        model: str | None,
        agent_profile: str,
        tool_mode: str,
        scope_kind: str,
        project_id: str | None,
        surface: str | None,
        canvas_id: str | None,
        resume_session_id: str | None = None,
    ) -> _WorkerSlot:
        cli_path = _hermes_cli_path()
        if not cli_path.exists():
            raise RuntimeError(
                f"hermes CLI not found at {cli_path}. " "Run `uv tool install 'hermes-agent[acp]'`."
            )
        _ensure_supported_hermes_version(cli_path)
        home = ensure_user_hermes_workspace(
            username,
            profile=_workspace_profile_for_agent(agent_profile, tool_mode, surface),
        )
        worker_id = f"hermes-{uuid.uuid4().hex}"
        token = await get_auth_session_port().create_agent_session(
            username=username,
            scopes=HERMES_DEFAULT_SCOPES,
            ttl_seconds=self._token_ttl_secs,
            agent_kind="hermes" if agent_profile == "main" else f"hermes-{agent_profile}",
            worker_id=worker_id,
            current_scope_kind=scope_kind,
            current_project_id=project_id,
        )
        project_env = await self._project_env(username, project_id)
        env = self._build_env(
            home,
            username,
            token,
            agent_profile=agent_profile,
            project_id=project_id,
            project_env=project_env,
            tool_mode=tool_mode,
            surface=surface,
            canvas_id=canvas_id,
        )
        client = HermesSdkClient(
            cli_path=cli_path,
            cwd=home,
            env=env,
            model=model,
            username=username,
        )
        session_id = (
            resume_session_id
            or self._session_id_for(username, scope_kind, project_id, agent_profile, canvas_id)
            or ""
        ).strip()
        thread = client.thread_resume(session_id) if session_id else client.thread_start()
        _log.info(
            "spawned hermes worker for user=%s home=%s agent_session=%s resumed_session=%s",
            username,
            home,
            token.session_id,
            bool(session_id),
        )
        return _WorkerSlot(
            username=username,
            client=client,
            thread=thread,
            token=token,
            model=model,
            agent_profile=agent_profile,
            tool_mode=tool_mode,
            scope_kind=scope_kind,
            project_id=project_id,
            surface=surface,
            canvas_id=canvas_id,
            gateway_fingerprint=effective_gateway_fingerprint(),
        )

    def _token_needs_renewal(self, slot: _WorkerSlot) -> bool:
        renew_at = int(time.time()) + max(0, self._token_renew_skew_secs)
        return slot.token.exp <= renew_at

    @staticmethod
    def _slot_key(username: str, agent_profile: str = "main") -> str:
        profile = (agent_profile or "main").strip() or "main"
        return username if profile == "main" else f"{username}:{profile}"

    @staticmethod
    def _scope_key(
        scope_kind: str,
        project_id: str | None,
        agent_profile: str = "main",
        canvas_id: str | None = None,
    ) -> tuple[str, str, str | None, str | None]:
        kind = (scope_kind or "home").strip() or "home"
        profile = (agent_profile or "main").strip() or "main"
        scoped_canvas = str(canvas_id or "").strip() or None
        if not profile.startswith("freezone"):
            scoped_canvas = None
        return profile, kind, project_id if kind != "home" else None, scoped_canvas

    def _session_id_for(
        self,
        username: str,
        scope_kind: str,
        project_id: str | None,
        agent_profile: str = "main",
        canvas_id: str | None = None,
    ) -> str | None:
        return self._session_ids.get(username, {}).get(
            self._scope_key(scope_kind, project_id, agent_profile, canvas_id)
        )

    def _remember_session(self, slot: _WorkerSlot) -> None:
        session_id = str(getattr(slot.thread, "id", "") or "").strip()
        if not session_id:
            return
        self._session_ids.setdefault(slot.username, {})[
            self._scope_key(slot.scope_kind, slot.project_id, slot.agent_profile, slot.canvas_id)
        ] = session_id

    async def _rotate_slot_locked(
        self,
        slot: _WorkerSlot,
        *,
        model: str | None,
        agent_profile: str,
        tool_mode: str,
        scope_kind: str,
        project_id: str | None,
        surface: str | None,
        canvas_id: str | None,
        reason: str,
    ) -> _WorkerSlot:
        """Replace a running worker with a fresh token/session.

        Agent tokens live in the subprocess environment, so scope updates can
        happen server-side but credential renewal requires a worker restart.
        Spawn first; if control-plane issuance fails, keep the old worker alive.
        Track the replacement before closing the old slot so a cancelled request
        cannot leave the fresh token unmanaged.
        """
        self._remember_session(slot)
        same_scope = self._scope_key(
            slot.scope_kind,
            slot.project_id,
            slot.agent_profile,
            slot.canvas_id,
        ) == self._scope_key(scope_kind, project_id, agent_profile, canvas_id)
        resume_session_id = slot.thread.id if same_scope else None
        replacement = await self._spawn_locked(
            slot.username,
            model=model if model is not None else slot.model,
            agent_profile=agent_profile,
            tool_mode=tool_mode,
            scope_kind=scope_kind,
            project_id=project_id,
            surface=surface,
            canvas_id=canvas_id,
            resume_session_id=resume_session_id,
        )
        _log.info(
            "rotating hermes worker for user=%s old_agent_session=%s new_agent_session=%s reason=%s",
            slot.username,
            slot.token.session_id,
            replacement.token.session_id,
            reason,
        )
        self._slots[self._slot_key(slot.username, agent_profile)] = replacement
        await asyncio.shield(self._close_slot(slot))
        return replacement

    async def _update_scope_locked(
        self,
        slot: _WorkerSlot,
        scope_kind: str,
        project_id: str | None,
    ) -> None:
        await get_auth_session_port().update_agent_session_scope(
            slot.token.value,
            scope_kind=scope_kind,
            project_id=project_id,
        )

    async def _project_env(self, username: str, project_id: str | None) -> dict[str, str]:
        if not project_id:
            return {}
        try:
            from novelvideo.project_context import require_project_home_node, resolve_project_context

            ctx = await resolve_project_context(
                user={"username": username},
                project_id=project_id,
                required_role="viewer",
            )
            require_project_home_node(ctx, operation="resolve hermes project files")
            return {
                "DRAMACLAW_PROJECT_NAME": ctx.project_name,
                "DRAMACLAW_PROJECT_OWNER": ctx.owner_username,
                "DRAMACLAW_PROJECT_OUTPUT_DIR": str(ctx.output_dir),
                "DRAMACLAW_PROJECT_STATE_DIR": str(ctx.state_dir),
                "DRAMACLAW_PROJECT_RUNTIME_DIR": str(ctx.runtime_dir),
                "SUPERTALE_PROJECT_NAME": ctx.project_name,
                "SUPERTALE_PROJECT_OWNER": ctx.owner_username,
                "SUPERTALE_PROJECT_OUTPUT_DIR": str(ctx.output_dir),
                "SUPERTALE_PROJECT_STATE_DIR": str(ctx.state_dir),
                "SUPERTALE_PROJECT_RUNTIME_DIR": str(ctx.runtime_dir),
            }
        except Exception as exc:
            _log.warning("failed to resolve hermes project env for project=%s user=%s: %s", project_id, username, exc)
            return {}

    def _build_env(
        self,
        home: Path,
        username: str,
        token: AgentSessionToken,
        *,
        agent_profile: str = "main",
        project_id: str | None,
        tool_mode: str = "default",
        surface: str | None = None,
        canvas_id: str | None = None,
        project_env: dict[str, str] | None = None,
    ) -> dict[str, str]:
        """Build the strict environment passed only to this Hermes worker."""
        env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
            "HOME": str(home),
            "HERMES_HOME": str(home),
            "TMPDIR": str(home / "tmp"),
            "ST_EDITION": os.environ.get("ST_EDITION", ""),
            "ST_CONTROL_PLANE_DSN": os.environ.get("ST_CONTROL_PLANE_DSN", ""),
            "DRAMACLAW_USER": username,
            "DRAMACLAW_AGENT_TOKEN": token.value,
            "DRAMACLAW_AGENT_TOKEN_TYPE": "Bearer",
            "DRAMACLAW_AGENT_TOKEN_SESSION_ID": token.session_id,
            "DRAMACLAW_AGENT_TOKEN_EXPIRES_AT": str(token.exp),
            "DRAMACLAW_API_URL": self._api_url,
            "DRAMACLAW_TOOL_MODE": tool_mode,
            "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR": str(canvas_bridge_dir_for_profile(home, agent_profile)),
            "SUPERTALE_USER": username,
            "SUPERTALE_AGENT_TOKEN": token.value,
            "SUPERTALE_AGENT_TOKEN_TYPE": "Bearer",
            "SUPERTALE_AGENT_TOKEN_SESSION_ID": token.session_id,
            "SUPERTALE_AGENT_TOKEN_EXPIRES_AT": str(token.exp),
            "SUPERTALE_API_URL": self._api_url,
        }
        if surface:
            env["DRAMACLAW_CHAT_SURFACE"] = surface
            env["SUPERTALE_CHAT_SURFACE"] = surface
        if canvas_id:
            env["DRAMACLAW_CANVAS_ID"] = canvas_id
            env["SUPERTALE_CANVAS_ID"] = canvas_id
        if project_id:
            env["DRAMACLAW_PROJECT_ID"] = project_id
            env["DRAMACLAW_PROJECT"] = project_id
            env["SUPERTALE_PROJECT_ID"] = project_id
            # Backward-compatible alias for older skill references.
            env["SUPERTALE_PROJECT"] = project_id
        if project_env:
            env.update(project_env)
        api_key, _base_url = effective_gateway_credentials()
        if api_key:
            env["NEWAPI_API_KEY"] = api_key
        return env

    async def _evict_lru_if_full(self) -> None:
        if len(self._slots) < self._max_workers:
            return
        # Evict least-recently-used
        victim = min(self._slots.values(), key=lambda s: s.last_used)
        _log.info("hermes pool full (%d); evicting LRU user=%s", self._max_workers, victim.username)
        await self._close_slot(victim)
        self._slots.pop(self._slot_key(victim.username, victim.agent_profile), None)

    async def _close_slot(self, slot: _WorkerSlot) -> None:
        self._remember_session(slot)
        try:
            await slot.thread.close()
        except Exception as e:
            _log.warning("error closing hermes thread for %s: %s", slot.username, e)
        try:
            await get_auth_session_port().revoke_agent_session(slot.token.value)
        except Exception as e:
            _log.warning(
                "error revoking hermes agent session %s: %s",
                slot.token.session_id,
                e,
            )

    async def _reaper_loop(self) -> None:
        """Background task: kill idle workers."""
        try:
            while True:
                await asyncio.sleep(60)
                cutoff = time.time() - self._idle_kill_secs
                async with self._lock:
                    victims = [s for s in self._slots.values() if s.last_used < cutoff]
                    for v in victims:
                        _log.info("hermes worker idle-killed: user=%s", v.username)
                        await self._close_slot(v)
                        self._slots.pop(self._slot_key(v.username, v.agent_profile), None)
                    if not self._slots:
                        # Pool empty — exit reaper; next spawn will restart it
                        return
        except asyncio.CancelledError:
            return

    async def close_user(self, username: str) -> bool:
        """Programmatically tear down one user's worker (e.g. on logout)."""
        async with self._lock:
            keys = [key for key, slot in self._slots.items() if slot.username == username]
            if not keys:
                return False
            for key in keys:
                slot = self._slots.pop(key, None)
                if slot is not None:
                    await self._close_slot(slot)
            return True

    async def close_user_profile(self, username: str, agent_profile: str) -> bool:
        """Programmatically tear down one user's worker for a single profile."""
        profile = (agent_profile or "main").strip() or "main"
        async with self._lock:
            key = self._slot_key(username, profile)
            slot = self._slots.pop(key, None)
            if slot is None:
                return False
            await self._close_slot(slot)
            return True

    async def resolve_permission(
        self,
        username: str,
        agent_profile: str,
        request_id: str | int,
        option_id: str,
    ) -> bool:
        """Resolve an ACP permission request on an existing worker profile."""
        profile = (agent_profile or "main").strip() or "main"
        async with self._lock:
            slot = self._slots.get(self._slot_key(username, profile))
            if slot is None:
                return False
            return await slot.thread.resolve_permission(request_id, option_id)

    async def prewarm(
        self,
        username: str,
        *,
        agent_profile: str = "main",
        tool_mode: str = "default",
        scope_kind: str = "home",
        project_id: str | None = None,
        surface: str | None = None,
        canvas_id: str | None = None,
    ) -> None:
        """Proactively spawn + warm the user's worker for the given scope.

        Called when the user opens a chat / switches project so the first real
        message hits a ready session instead of paying the ~cold-start latency
        (spawn → initialize → session/new with its startup probes). Best-effort:
        the worker is selected synchronously (so scope rotation lands before the
        first message) and the slow warm-up runs in the background.
        """
        try:
            thread = await self.get_for_user(
                username,
                agent_profile=agent_profile,
                tool_mode=tool_mode,
                scope_kind=scope_kind,
                project_id=project_id,
                surface=surface,
                canvas_id=canvas_id,
            )
        except Exception as e:  # noqa: BLE001 - prewarm must never break chat
            _log.debug("prewarm get_for_user failed for user=%s: %s", username, e)
            return
        task = asyncio.create_task(thread.warm())
        self._warm_tasks.add(task)
        task.add_done_callback(self._warm_tasks.discard)

    async def set_scope_for_user(
        self,
        username: str,
        *,
        agent_profile: str = "main",
        scope_kind: str,
        project_id: str | None,
    ) -> bool:
        """Update an already-running worker's server-side active scope."""
        async with self._lock:
            slot = self._slots.get(self._slot_key(username, agent_profile))
            if slot is None:
                return False
            await self._update_scope_locked(slot, scope_kind, project_id)
            slot.last_used = time.time()
            return True

    async def close_all(self) -> None:
        """Tear down every worker (graceful shutdown)."""
        async with self._lock:
            for slot in list(self._slots.values()):
                await self._close_slot(slot)
            self._slots.clear()
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            self._cleanup_task = None

    def stats(self) -> dict:
        return {
            "active_workers": len(self._slots),
            "users": sorted(self._slots.keys()),
            "max_workers": self._max_workers,
            "idle_kill_secs": self._idle_kill_secs,
            "token_renew_skew_secs": self._token_renew_skew_secs,
        }


# Process-wide singleton
pool = HermesPool()


__all__ = ["HermesPool", "pool", "is_hermes_backend_available", "_hermes_cli_path"]
