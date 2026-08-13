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
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from novelvideo.chat.hermes_sdk import HermesSdkClient, HermesSdkThread
from novelvideo.chat.hermes_egress import (
    EgressBoundaryError,
    HermesLaunchAuthorization,
    build_hermes_child_env,
)
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


class HermesDrainingError(RuntimeError):
    """A revoked worker cannot accept another turn."""

    def __init__(self) -> None:
        super().__init__("hermes worker is draining")


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


@dataclass
class _WorkerSlot:
    """One per active user."""

    username: str
    client: HermesSdkClient
    thread: HermesSdkThread
    token: AgentSessionToken
    model: str | None = None
    scope_kind: str = "home"
    project_id: str | None = None
    gateway_fingerprint: str = ""
    last_used: float = field(default_factory=time.time)
    state: str = "active"
    active_turns: int = 0
    authz_generation: int = 0
    one_shot: bool = False


class _ManagedHermesThread:
    """Thread facade that lets the pool observe complete turn boundaries."""

    def __init__(self, owner: "HermesPool", slot: _WorkerSlot) -> None:
        self._owner = owner
        self._slot = slot

    def __getattr__(self, name: str) -> Any:
        return getattr(self._slot.thread, name)

    async def stream(self, prompt: str, *, current_project: str | None = None):
        await self._owner._begin_turn(self._slot)
        try:
            async for event in self._slot.thread.stream(
                prompt,
                current_project=current_project,
            ):
                yield event
        finally:
            await asyncio.shield(self._owner._finish_turn(self._slot))


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
        self._session_ids: dict[str, dict[tuple[str, str | None], str]] = {}
        self._lock = asyncio.Lock()
        self._idle_kill_secs = idle_kill_secs
        self._max_workers = max_workers
        self._api_url = (api_url or _load_api_url()).rstrip("/")
        self._token_ttl_secs = token_ttl_secs
        self._token_renew_skew_secs = token_renew_skew_secs
        self._cleanup_task: asyncio.Task | None = None
        self._warm_tasks: set[asyncio.Task] = set()
        self._authz_generation_reader: Callable[[str], Awaitable[int]] | None = None

    def set_authz_generation_reader(
        self,
        reader: Callable[[str], Awaitable[int]] | None,
    ) -> None:
        """Install the EE generation preflight; CE leaves this unset."""
        self._authz_generation_reader = reader

    async def _authz_generation(self, username: str) -> int:
        if self._authz_generation_reader is None:
            return 0
        try:
            generation = await self._authz_generation_reader(username)
        except asyncio.CancelledError:
            raise
        except GeneratorExit:
            raise
        except Exception:
            raise HermesDrainingError() from None
        if type(generation) is not int or generation < 0:
            raise HermesDrainingError()
        return generation

    async def get_for_user(
        self,
        username: str,
        *,
        model: str | None = None,
        scope_kind: str = "home",
        project_id: str | None = None,
        authorization: HermesLaunchAuthorization | None = None,
    ) -> HermesSdkThread:
        """Lazily create / return the per-user hermes thread.

        Bumps last_used so idle reaper resets the clock. Caller should
        ``await thread.stream(prompt)`` to send messages.
        """
        authz_generation = await self._authz_generation(username)
        async with self._lock:
            slot = self._slots.get(username)
            if slot is not None and authorization is not None:
                slot.state = "draining"
                if slot.active_turns or not await self._close_slot(slot, strict=True):
                    raise HermesDrainingError()
                slot.state = "closed"
                self._slots.pop(username, None)
                slot = None
            if slot is not None:
                if authz_generation > slot.authz_generation:
                    slot.state = "draining"
                    if slot.active_turns == 0 and await self._close_slot(
                        slot, strict=True
                    ):
                        slot.state = "closed"
                        self._slots.pop(username, None)
                if slot.state != "active":
                    raise HermesDrainingError()
                slot.authz_generation = authz_generation
                if bool(getattr(slot.thread, "is_closed", False)):
                    slot = await self._rotate_slot_locked(
                        slot,
                        model=model,
                        scope_kind=scope_kind,
                        project_id=project_id,
                        reason="thread-closed",
                    )
                elif slot.gateway_fingerprint != effective_gateway_fingerprint():
                    slot = await self._rotate_slot_locked(
                        slot,
                        model=model,
                        scope_kind=scope_kind,
                        project_id=project_id,
                        reason="model-gateway-change",
                    )
                elif self._token_needs_renewal(slot):
                    slot = await self._rotate_slot_locked(
                        slot,
                        model=model,
                        scope_kind=scope_kind,
                        project_id=project_id,
                        reason="agent-session-renewal",
                    )
                elif slot.scope_kind != scope_kind or slot.project_id != project_id:
                    slot = await self._rotate_slot_locked(
                        slot,
                        model=model,
                        scope_kind=scope_kind,
                        project_id=project_id,
                        reason="scope-env-change",
                    )
                else:
                    await self._update_scope_locked(slot, scope_kind, project_id)
                slot.last_used = time.time()
                return _ManagedHermesThread(self, slot)  # type: ignore[return-value]

            await self._evict_lru_if_full()
            slot = await self._spawn_locked(
                username,
                model=model,
                scope_kind=scope_kind,
                session_project_id=project_id,
                authorization=authorization,
            )
            slot.authz_generation = authz_generation
            self._slots[username] = slot
            # Ensure background reaper is running
            if self._cleanup_task is None or self._cleanup_task.done():
                self._cleanup_task = asyncio.create_task(self._reaper_loop())
            return _ManagedHermesThread(self, slot)  # type: ignore[return-value]

    async def _begin_turn(self, slot: _WorkerSlot) -> None:
        authz_generation = await self._authz_generation(slot.username)
        async with self._lock:
            if authz_generation > slot.authz_generation:
                slot.state = "draining"
                if slot.active_turns == 0 and await self._close_slot(slot, strict=True):
                    slot.state = "closed"
                    self._slots.pop(slot.username, None)
            if self._slots.get(slot.username) is not slot or slot.state != "active":
                raise HermesDrainingError()
            slot.authz_generation = authz_generation
            slot.active_turns += 1
            slot.last_used = time.time()

    async def _finish_turn(self, slot: _WorkerSlot) -> None:
        async with self._lock:
            if slot.active_turns > 0:
                slot.active_turns -= 1
            if slot.one_shot:
                slot.state = "draining"
            if slot.state == "draining" and slot.active_turns == 0:
                if await self._close_slot(slot, strict=True):
                    slot.state = "closed"
                    if self._slots.get(slot.username) is slot:
                        self._slots.pop(slot.username, None)

    async def _spawn_locked(
        self,
        username: str,
        *,
        model: str | None,
        scope_kind: str,
        session_project_id: str | None,
        egress_project_id: str | None = None,
        resume_session_id: str | None = None,
        authorization: HermesLaunchAuthorization | None = None,
    ) -> _WorkerSlot:
        """Spawn a worker slot.

        ``session_project_id`` carries the session/workspace project identity
        (NULL in home scope). ``egress_project_id`` carries only the identity
        compared against a trusted egress context; the two cannot be the same
        parameter because home scope requires NULL for the former and a
        non-empty value for the latter.
        """
        cli_path = _hermes_cli_path()
        if not cli_path.exists():
            raise RuntimeError(
                f"hermes CLI not found at {cli_path}. "
                "Run `uv tool install 'hermes-agent[acp]'`."
            )
        home = ensure_user_hermes_workspace(username)
        worker_id = f"hermes-{uuid.uuid4().hex}"
        token = await get_auth_session_port().create_agent_session(
            username=username,
            scopes=HERMES_DEFAULT_SCOPES,
            ttl_seconds=self._token_ttl_secs,
            agent_kind="hermes",
            worker_id=worker_id,
            current_scope_kind=scope_kind,
            current_project_id=session_project_id,
        )
        project_env = await self._project_env(username, session_project_id)
        env = self._build_env(
            home,
            username,
            token,
            project_id=session_project_id,
            egress_project_id=egress_project_id,
            project_env=project_env,
            authorization=authorization,
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
            or self._session_id_for(username, scope_kind, session_project_id)
            or ""
        ).strip()
        thread = (
            client.thread_resume(session_id) if session_id else client.thread_start()
        )
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
            scope_kind=scope_kind,
            project_id=session_project_id,
            gateway_fingerprint=(
                "" if authorization is not None else effective_gateway_fingerprint()
            ),
            one_shot=authorization is not None,
        )

    def _token_needs_renewal(self, slot: _WorkerSlot) -> bool:
        renew_at = int(time.time()) + max(0, self._token_renew_skew_secs)
        return slot.token.exp <= renew_at

    @staticmethod
    def _scope_key(scope_kind: str, project_id: str | None) -> tuple[str, str | None]:
        kind = (scope_kind or "home").strip() or "home"
        return kind, project_id if kind != "home" else None

    def _session_id_for(
        self,
        username: str,
        scope_kind: str,
        project_id: str | None,
    ) -> str | None:
        return self._session_ids.get(username, {}).get(
            self._scope_key(scope_kind, project_id)
        )

    def _remember_session(self, slot: _WorkerSlot) -> None:
        session_id = str(getattr(slot.thread, "id", "") or "").strip()
        if not session_id:
            return
        self._session_ids.setdefault(slot.username, {})[
            self._scope_key(slot.scope_kind, slot.project_id)
        ] = session_id

    async def _rotate_slot_locked(
        self,
        slot: _WorkerSlot,
        *,
        model: str | None,
        scope_kind: str,
        project_id: str | None,
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
            slot.scope_kind, slot.project_id
        ) == self._scope_key(
            scope_kind,
            project_id,
        )
        resume_session_id = slot.thread.id if same_scope else None
        replacement = await self._spawn_locked(
            slot.username,
            model=model if model is not None else slot.model,
            scope_kind=scope_kind,
            session_project_id=project_id,
            resume_session_id=resume_session_id,
        )
        _log.info(
            "rotating hermes worker for user=%s old_agent_session=%s new_agent_session=%s reason=%s",
            slot.username,
            slot.token.session_id,
            replacement.token.session_id,
            reason,
        )
        self._slots[slot.username] = replacement
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

    async def _project_env(
        self, username: str, project_id: str | None
    ) -> dict[str, str]:
        if not project_id:
            return {}
        try:
            from novelvideo.project_context import (
                require_project_home_node,
                resolve_project_context,
            )

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
            _log.warning(
                "failed to resolve hermes project env for project=%s user=%s: %s",
                project_id,
                username,
                exc,
            )
            return {}

    def _build_env(
        self,
        home: Path,
        username: str,
        token: AgentSessionToken,
        *,
        project_id: str | None,
        egress_project_id: str | None = None,
        project_env: dict[str, str] | None = None,
        authorization: HermesLaunchAuthorization | None = None,
    ) -> dict[str, str]:
        """Build the strict environment passed only to this Hermes worker.

        ``project_id`` feeds the child process environment; ``egress_project_id``
        feeds only the trusted-context admission check and must be supplied
        whenever an authorization is present.
        """
        if authorization is not None:
            if not egress_project_id:
                raise EgressBoundaryError("TASK_ENVELOPE_INVALID")
            agent_token_env = {
                "DRAMACLAW_AGENT_TOKEN": token.value,
                "DRAMACLAW_AGENT_TOKEN_TYPE": "Bearer",
                "DRAMACLAW_AGENT_TOKEN_SESSION_ID": token.session_id,
                "DRAMACLAW_AGENT_TOKEN_EXPIRES_AT": str(token.exp),
                "SUPERTALE_AGENT_TOKEN": token.value,
                "SUPERTALE_AGENT_TOKEN_TYPE": "Bearer",
                "SUPERTALE_AGENT_TOKEN_SESSION_ID": token.session_id,
                "SUPERTALE_AGENT_TOKEN_EXPIRES_AT": str(token.exp),
            }
            return build_hermes_child_env(
                home=home,
                username=username,
                requester_user_id=authorization.context.requester_user_id,
                api_url=self._api_url,
                agent_token_env=agent_token_env,
                project_id=project_id,
                egress_project_id=egress_project_id,
                project_env=project_env,
                authorization=authorization,
            )
        env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
            "HOME": str(home),
            "HERMES_HOME": str(home),
            "TMPDIR": str(home / "tmp"),
            "DRAMACLAW_USER": username,
            "DRAMACLAW_AGENT_TOKEN": token.value,
            "DRAMACLAW_AGENT_TOKEN_TYPE": "Bearer",
            "DRAMACLAW_AGENT_TOKEN_SESSION_ID": token.session_id,
            "DRAMACLAW_AGENT_TOKEN_EXPIRES_AT": str(token.exp),
            "DRAMACLAW_API_URL": self._api_url,
            "SUPERTALE_USER": username,
            "SUPERTALE_AGENT_TOKEN": token.value,
            "SUPERTALE_AGENT_TOKEN_TYPE": "Bearer",
            "SUPERTALE_AGENT_TOKEN_SESSION_ID": token.session_id,
            "SUPERTALE_AGENT_TOKEN_EXPIRES_AT": str(token.exp),
            "SUPERTALE_API_URL": self._api_url,
        }
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
        _log.info(
            "hermes pool full (%d); evicting LRU user=%s",
            self._max_workers,
            victim.username,
        )
        await self._close_slot(victim)
        self._slots.pop(victim.username, None)

    async def _revoke_agent_session(self, token: str) -> None:
        await get_auth_session_port().revoke_agent_session(token)

    async def _close_slot(self, slot: _WorkerSlot, *, strict: bool = False) -> bool:
        self._remember_session(slot)
        failed = False
        try:
            await slot.thread.close()
        except Exception:
            failed = True
            _log.warning("error closing hermes thread")
        try:
            await self._revoke_agent_session(slot.token.value)
        except Exception:
            failed = True
            _log.warning("error revoking hermes agent session")
        if failed and strict:
            return False
        return not failed

    async def _reaper_loop(self) -> None:
        """Background task: kill idle workers."""
        try:
            while True:
                await asyncio.sleep(60)
                cutoff = time.time() - self._idle_kill_secs
                async with self._lock:
                    victims = [
                        slot
                        for slot in self._slots.values()
                        if (slot.state == "draining" and slot.active_turns == 0)
                        or slot.last_used < cutoff
                    ]
                    for v in victims:
                        _log.info("hermes worker idle-killed: user=%s", v.username)
                        await self._close_slot(v)
                        self._slots.pop(v.username, None)
                    if not self._slots:
                        # Pool empty — exit reaper; next spawn will restart it
                        return
        except asyncio.CancelledError:
            return

    async def close_user(self, username: str) -> bool:
        """Programmatically tear down one user's worker (e.g. on logout)."""
        async with self._lock:
            slot = self._slots.pop(username, None)
            if slot is None:
                return False
            await self._close_slot(slot)
            return True

    async def drain_user(self, username: str) -> bool:
        """Reject new turns and close after the current turn boundary."""
        async with self._lock:
            slot = self._slots.get(username)
            if slot is None or slot.state == "closed":
                return False
            if slot.state == "draining":
                if slot.active_turns == 0 and await self._close_slot(slot, strict=True):
                    slot.state = "closed"
                    self._slots.pop(username, None)
                return False
            slot.state = "draining"
            if slot.active_turns == 0 and await self._close_slot(slot, strict=True):
                slot.state = "closed"
                self._slots.pop(username, None)
            return True

    async def prewarm(
        self,
        username: str,
        *,
        scope_kind: str = "home",
        project_id: str | None = None,
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
                username, scope_kind=scope_kind, project_id=project_id
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
        scope_kind: str,
        project_id: str | None,
    ) -> bool:
        """Update an already-running worker's server-side active scope."""
        async with self._lock:
            slot = self._slots.get(username)
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
            "states": {username: slot.state for username, slot in self._slots.items()},
        }


# Process-wide singleton
pool = HermesPool()


__all__ = [
    "HermesDrainingError",
    "HermesPool",
    "pool",
    "is_hermes_backend_available",
    "_hermes_cli_path",
]
