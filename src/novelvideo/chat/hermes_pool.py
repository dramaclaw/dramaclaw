"""Per-user Hermes worker pool.

Each user gets at most one live HermesSdkClient per agent profile. Conversation
sessions are separated by profile, home/project scope, project, and Freezone
canvas where applicable. Project sessions place Hermes' native session and
memory state in the project's authoritative state directory; home sessions keep
the legacy per-user workspace. Clients are lazily spawned and reaped after idle
timeout.

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
import hashlib
import json
import logging
import os
import shutil
import time
import uuid
from urllib.parse import urlsplit
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from novelvideo import config
from novelvideo.chat.hermes_sdk import HermesSdkClient, HermesSdkThread
from novelvideo.chat import evidence_metrics
from novelvideo.chat.hermes_fork_requirement import require_hermes_fork
from novelvideo.chat.hermes_egress import (
    PER_TURN_CREDENTIAL_PLACEHOLDER,
    EgressBoundaryError,
    HermesTurnAuthorization,
    build_hermes_child_env,
)
from novelvideo.chat.hermes_workspace import (
    FREEZONE_HERMES_TOOL_DENY,
    effective_gateway_credentials,
    ensure_user_hermes_workspace,
    freezone_python_hook_dir,
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
    home: Path | None = None
    model: str | None = None
    agent_profile: str = "main"
    tool_mode: str = "default"
    scope_kind: str = "home"
    project_id: str | None = None
    surface: str | None = None
    canvas_id: str | None = None
    gateway_fingerprint: str = ""
    last_used: float = field(default_factory=time.time)
    state: str = "active"
    active_turns: int = 0
    authz_generation: int = 0
    one_shot: bool = False
    # 出网身份，与上面的会话身份 (`scope_kind`/`project_id`) 是两套东西。
    # 记在 slot 上只为一件事：`_rotate_slot_locked` 重建 worker 时必须带着它们，
    # 否则替换出来的 worker 走 `authorization is None` 分支，静默退回部署级
    # `NEWAPI_API_KEY`——组织身份被洗掉，不报错也不留痕（OI-54 同一种病）。
    egress_project_id: str | None = None
    requester_user_id: str | None = None
    # No authorization is kept. It carries a real API key, and a slot outlives
    # the turn that produced it: organisation A's credential would still be
    # sitting here when B reused the worker, and a rotation would replay it.
    # Rotation needs only the gateway origin, which is not a secret.


class GatewayOriginMismatch(RuntimeError):
    """Raised when a turn's credential belongs to a different gateway.

    Workers are shared by origin. Sending one tenant's key to a gateway the
    platform configured, rather than the one that issued it, would authenticate
    against the wrong deployment — so the mismatch is refused instead.
    """


def _resolve_turn_gateway_api_key(
    authorization: HermesTurnAuthorization | None,
) -> str | None:
    """The model-gateway key for this turn, platform or organisation alike.

    Both are passed per turn. A platform turn used to rely on the worker's
    environment, which is what made a shared worker unsafe: an organisation turn
    landing on a platform-started worker could fall back to the platform key.
    """
    configured_key, configured_base_url = effective_gateway_credentials()
    if authorization is None:
        return configured_key or None
    credential = authorization.credential
    if _origin_of(credential.base_url) != _origin_of(configured_base_url):
        evidence_metrics.observe("foreign_endpoint_refused")
        raise GatewayOriginMismatch(
            "the turn credential targets a different gateway origin than the "
            "worker is configured for")
    return credential.api_key


def _origin_of(url: str | None) -> tuple[str, str]:
    parts = urlsplit((url or "").strip())
    return parts.scheme.lower(), parts.netloc.lower()


def gateway_origin_fingerprint() -> str:
    """Fingerprint the gateway a worker talks to, deliberately excluding the key.

    Rotating a worker is expensive — a new subprocess, a fresh ACP session, a
    cold connection pool — and the key is no longer a property of the worker.
    It now arrives with each turn, so two turns that differ only by credential
    can share one worker; only a change of endpoint requires a new one.

    ``hermes_workspace.effective_gateway_fingerprint`` still hashes the key and
    is left untouched: that module is frozen pending a recovery review, and this
    is the one call site that needed the narrower key.
    """
    _, base_url = effective_gateway_credentials()
    parts = urlsplit((base_url or "").strip())
    origin = f"{parts.scheme.lower()}://{parts.netloc.lower()}"
    return hashlib.sha256(origin.encode("utf-8")).hexdigest()


class _ManagedHermesThread:
    """Thread facade that lets the pool observe complete turn boundaries.

    It also carries this turn's gateway credential. A fresh facade is handed out
    per ``get_for_user`` call and the key lives only on it, never on the shared
    ``_WorkerSlot`` — so one pooled worker can serve several tenants, and a call
    site cannot silently omit the credential and fall back to a platform key,
    because it never passes one explicitly.
    """

    def __init__(self, owner: "HermesPool", slot: _WorkerSlot,
                 gateway_api_key: str | None = None) -> None:
        self._owner = owner
        self._slot = slot
        self._gateway_api_key = gateway_api_key

    def __getattr__(self, name: str) -> Any:
        return getattr(self._slot.thread, name)

    async def stream(
        self,
        prompt: str,
        *,
        current_project: str | None = None,
        trajectory_id: str | None = None,
        project_id: str | None = None,
        gateway_api_key: str | None = None,
    ):
        # Defaults to the credential this facade was created with, so an
        # ordinary caller never passes one and never forgets one.
        gateway_api_key = gateway_api_key or self._gateway_api_key
        # The signature is explicit rather than **kwargs, so anything the caller
        # passes has to be named here to reach the worker. trajectory_id and
        # project_id were silently swallowed until this was widened, which made
        # the egress capability unmintable on the real chat path while every
        # unit test still passed.
        await self._owner._begin_turn(self._slot)
        try:
            async for event in self._slot.thread.stream(
                prompt,
                current_project=current_project,
                trajectory_id=trajectory_id,
                project_id=project_id,
                gateway_api_key=gateway_api_key,
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
        self._session_ids: dict[str, dict[tuple[str, str, str | None, str | None], str]] = {}
        self._dirty_profiles: set[str] = set()
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
        agent_profile: str = "main",
        tool_mode: str = "default",
        scope_kind: str = "home",
        project_id: str | None = None,
        surface: str | None = None,
        canvas_id: str | None = None,
        egress_project_id: str | None = None,
        requester_user_id: str | None = None,
        authorization: HermesTurnAuthorization | None = None,
    ) -> HermesSdkThread:
        """Lazily create / return the per-user hermes thread.

        Bumps last_used so idle reaper resets the clock. Caller should
        ``await thread.stream(prompt)`` to send messages.

        ``egress_project_id`` and ``requester_user_id`` carry the *egress*
        identity of this turn and are only consumed when ``authorization`` is
        present. They come from the caller — never from the authorization's own
        context — so the admission re-check in ``build_hermes_child_env`` keeps
        an independent source to compare against.
        """
        slot_key = self._slot_key(username, agent_profile)
        normalized_surface = (
            str(surface or "").strip()
            or ("freezone" if _workspace_profile_for_agent(agent_profile, tool_mode, surface) == "freezone" else "")
            or None
        )
        normalized_canvas_id = str(canvas_id or "").strip() or None
        # P, A and B all travel the same way: an organisation turn uses its
        # resolved credential, a platform turn uses the configured one. Neither
        # reaches the worker's environment.
        turn_gateway_api_key = _resolve_turn_gateway_api_key(authorization)
        authz_generation = await self._authz_generation(username)
        async with self._lock:
            slot = self._slots.get(slot_key)
            # An organisation credential used to drain the worker here, because
            # the key could only reach the child through its environment. It now
            # travels with the turn, so the same worker serves platform and
            # organisation traffic without a rollout. Genuine rotation reasons —
            # an authz generation change, a scope change, a closed thread —
            # still apply below.
            if slot is not None:
                if authz_generation > slot.authz_generation:
                    slot.state = "draining"
                    if slot.active_turns == 0 and await self._close_slot(
                        slot, strict=True
                    ):
                        slot.state = "closed"
                        self._slots.pop(slot_key, None)
                if slot.state != "active":
                    raise HermesDrainingError()
                slot.authz_generation = authz_generation
                if slot_key in self._dirty_profiles:
                    self._dirty_profiles.discard(slot_key)
                    slot = await self._rotate_slot_locked(
                        slot,
                        model=model,
                        agent_profile=agent_profile,
                        tool_mode=tool_mode,
                        scope_kind=scope_kind,
                        project_id=project_id,
                        surface=normalized_surface,
                        canvas_id=normalized_canvas_id,
                        reason="profile-dirty",
                        resume_existing_session=False,
                    )
                elif bool(getattr(slot.thread, "is_closed", False)):
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
                elif slot.gateway_fingerprint != gateway_origin_fingerprint():
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
                return _ManagedHermesThread(self, slot, turn_gateway_api_key)  # type: ignore[return-value]

            await self._evict_lru_if_full()
            self._dirty_profiles.discard(slot_key)
            slot = await self._spawn_locked(
                username,
                model=model,
                agent_profile=agent_profile,
                tool_mode=tool_mode,
                scope_kind=scope_kind,
                session_project_id=project_id,
                surface=normalized_surface,
                canvas_id=normalized_canvas_id,
                egress_project_id=egress_project_id,
                requester_user_id=requester_user_id,
                authorization=authorization,
            )
            slot.authz_generation = authz_generation
            self._slots[slot_key] = slot
            # Ensure background reaper is running
            if self._cleanup_task is None or self._cleanup_task.done():
                self._cleanup_task = asyncio.create_task(self._reaper_loop())
            return _ManagedHermesThread(self, slot, turn_gateway_api_key)  # type: ignore[return-value]

    async def _begin_turn(self, slot: _WorkerSlot) -> None:
        authz_generation = await self._authz_generation(slot.username)
        slot_key = self._slot_key(slot.username, slot.agent_profile)
        async with self._lock:
            if authz_generation > slot.authz_generation:
                slot.state = "draining"
                if slot.active_turns == 0 and await self._close_slot(slot, strict=True):
                    slot.state = "closed"
                    self._slots.pop(slot_key, None)
            if self._slots.get(slot_key) is not slot or slot.state != "active":
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
                    slot_key = self._slot_key(slot.username, slot.agent_profile)
                    if self._slots.get(slot_key) is slot:
                        self._slots.pop(slot_key, None)

    async def reset_for_user(
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
        """Discard a cached Hermes session and start a fresh one for this scope."""
        slot_key = self._slot_key(username, agent_profile)
        normalized_surface = (
            str(surface or "").strip()
            or ("freezone" if _workspace_profile_for_agent(agent_profile, tool_mode, surface) == "freezone" else "")
            or None
        )
        normalized_canvas_id = str(canvas_id or "").strip() or None
        async with self._lock:
            old_slot = self._slots.pop(slot_key, None)
            self._forget_session(
                username,
                scope_kind,
                project_id,
                agent_profile,
                normalized_canvas_id,
                home=getattr(old_slot, "home", None),
            )
            await self._evict_lru_if_full()
            new_slot = await self._spawn_locked(
                username,
                model=model if model is not None else getattr(old_slot, "model", None),
                agent_profile=agent_profile,
                tool_mode=tool_mode,
                scope_kind=scope_kind,
                session_project_id=project_id,
                surface=normalized_surface,
                canvas_id=normalized_canvas_id,
                resume_session_id="",
                resume_persisted_session=False,
            )
            self._slots[slot_key] = new_slot
            if self._cleanup_task is None or self._cleanup_task.done():
                self._cleanup_task = asyncio.create_task(self._reaper_loop())
        if old_slot is not None:
            await asyncio.shield(self._close_slot(old_slot, remember_session=False))
        return new_slot.thread

    def mark_user_profile_dirty(self, username: str, agent_profile: str = "main") -> None:
        """Restart this user's cached worker profile before the next prompt.

        This lets catalog/Skill changes take effect without interrupting the
        currently streaming turn that may have produced the change.
        """
        self._dirty_profiles.add(self._slot_key(username, agent_profile))

    def mark_user_freezone_profiles_dirty(self, username: str) -> None:
        """Restart all cached Freezone worker profiles for this user on next use."""
        prefix = f"{username}:freezone:"
        for key in self._slots:
            if key.startswith(prefix):
                self._dirty_profiles.add(key)

    async def _spawn_locked(
        self,
        username: str,
        *,
        model: str | None,
        agent_profile: str,
        tool_mode: str,
        scope_kind: str,
        session_project_id: str | None,
        surface: str | None,
        canvas_id: str | None,
        egress_project_id: str | None = None,
        requester_user_id: str | None = None,
        resume_session_id: str | None = None,
        resume_persisted_session: bool = True,
        authorization: HermesTurnAuthorization | None = None,
    ) -> _WorkerSlot:
        """Spawn a worker slot.

        ``session_project_id`` carries the session/workspace project identity
        (NULL in home scope). ``egress_project_id`` carries only the identity
        compared against a trusted egress context; the two cannot be the same
        parameter because home scope requires NULL for the former and a
        non-empty value for the latter. ``requester_user_id`` is the caller's
        own copy of the egress user identity, kept separate for the same reason.
        """
        cli_path = _hermes_cli_path()
        if not cli_path.exists():
            raise RuntimeError(
                f"hermes CLI not found at {cli_path}. "
                "Run `uv tool install 'hermes-agent[acp]'`."
            )
        # No version gate. A version string cannot distinguish the fork from
        # stock — the fork keeps upstream's version, so `hermes --version`
        # reads identically for a build that carries the per-turn contract and
        # one that silently drops it. It checked the weaker property while
        # costing a manual edit on every upstream alignment.
        #
        # `require_hermes_fork` below checks the property we actually depend
        # on, by behaviour: whether `_meta` survives the ACP router. Hermes is
        # installed from this project's own fork branch, so which upstream
        # release it carries is an installation fact, not a runtime check.
        # Checked before the subprocess exists, so a mismatched pair fails here
        # with a cause rather than at the first turn as a connection error.
        require_hermes_fork(cli_path)
        project_env = await self._project_env(username, session_project_id)
        project_state_dir = project_env.get("DRAMACLAW_PROJECT_STATE_DIR")
        if session_project_id and not project_state_dir:
            raise RuntimeError(
                f"Hermes project state is unavailable for project {session_project_id}"
            )
        home = ensure_user_hermes_workspace(
            username,
            profile=_workspace_profile_for_agent(agent_profile, tool_mode, surface),
            project_state_dir=project_state_dir,
        )
        worker_id = f"hermes-{uuid.uuid4().hex}"
        token = await get_auth_session_port().create_agent_session(
            username=username,
            scopes=HERMES_DEFAULT_SCOPES,
            ttl_seconds=self._token_ttl_secs,
            agent_kind="hermes" if agent_profile == "main" else f"hermes-{agent_profile}",
            worker_id=worker_id,
            current_scope_kind=scope_kind,
            current_project_id=session_project_id,
        )
        env = self._build_env(
            home,
            username,
            token,
            agent_profile=agent_profile,
            project_id=session_project_id,
            egress_project_id=egress_project_id,
            requester_user_id=requester_user_id,
            project_env=project_env,
            tool_mode=tool_mode,
            surface=surface,
            canvas_id=canvas_id,
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
            or self._session_id_for(
                username, scope_kind, session_project_id, agent_profile, canvas_id
            )
            or (
                self._persisted_session_id_for(
                    home,
                    scope_kind,
                    session_project_id,
                    agent_profile,
                    canvas_id,
                )
                if resume_persisted_session
                else None
            )
            or ""
        ).strip()
        resumed_session = bool(session_id)
        if session_id:
            try:
                thread = client.thread_resume(session_id)
            except Exception as exc:  # noqa: BLE001 - stale Hermes sessions should not break a new turn
                _log.warning(
                    "failed to resume hermes session %s for user=%s profile=%s scope=%s project=%s canvas=%s; "
                    "starting a fresh session: %s",
                    session_id,
                    username,
                    agent_profile,
                    scope_kind,
                    session_project_id,
                    canvas_id,
                    exc,
                )
                self._forget_session(
                    username,
                    scope_kind,
                    session_project_id,
                    agent_profile,
                    canvas_id,
                    home=home,
                )
                thread = client.thread_start()
                resumed_session = False
        else:
            thread = client.thread_start()
        _log.info(
            "spawned hermes worker for user=%s home=%s agent_session=%s resumed_session=%s",
            username,
            home,
            token.session_id,
            resumed_session,
        )
        evidence_metrics.observe("worker_spawned")
        return _WorkerSlot(
            username=username,
            client=client,
            thread=thread,
            token=token,
            home=home,
            model=model,
            agent_profile=agent_profile,
            tool_mode=tool_mode,
            scope_kind=scope_kind,
            project_id=session_project_id,
            surface=surface,
            canvas_id=canvas_id,
            gateway_fingerprint=gateway_origin_fingerprint(),
            one_shot=False,
            egress_project_id=egress_project_id,
            requester_user_id=requester_user_id,
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

    @classmethod
    def _persisted_session_id_for(
        cls,
        home: Path,
        scope_kind: str,
        project_id: str | None,
        agent_profile: str = "main",
        canvas_id: str | None = None,
    ) -> str | None:
        path = home / "dramaclaw_sessions.json"
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        key = json.dumps(
            cls._scope_key(scope_kind, project_id, agent_profile, canvas_id),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return str(payload.get(key) or "").strip() or None

    @classmethod
    def _persist_session_id(
        cls,
        home: Path,
        scope_kind: str,
        project_id: str | None,
        agent_profile: str,
        canvas_id: str | None,
        session_id: str | None,
    ) -> None:
        from novelvideo.utils.state_index_files import index_file_lock, write_json_atomic

        path = home / "dramaclaw_sessions.json"
        key = json.dumps(
            cls._scope_key(scope_kind, project_id, agent_profile, canvas_id),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        with index_file_lock(path):
            try:
                payload = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            except (OSError, json.JSONDecodeError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            normalized = str(session_id or "").strip()
            if normalized:
                payload[key] = normalized
            else:
                payload.pop(key, None)
            write_json_atomic(path, payload)

    def _forget_session(
        self,
        username: str,
        scope_kind: str,
        project_id: str | None,
        agent_profile: str = "main",
        canvas_id: str | None = None,
        home: Path | None = None,
    ) -> None:
        sessions = self._session_ids.get(username)
        if sessions:
            sessions.pop(
                self._scope_key(scope_kind, project_id, agent_profile, canvas_id),
                None,
            )
            if not sessions:
                self._session_ids.pop(username, None)
        if home is not None:
            self._persist_session_id(
                home,
                scope_kind,
                project_id,
                agent_profile,
                canvas_id,
                None,
            )

    def _remember_session(self, slot: _WorkerSlot) -> None:
        session_id = str(getattr(slot.thread, "id", "") or "").strip()
        if not session_id:
            return
        self._session_ids.setdefault(slot.username, {})[
            self._scope_key(slot.scope_kind, slot.project_id, slot.agent_profile, slot.canvas_id)
        ] = session_id
        if slot.home is not None:
            self._persist_session_id(
                slot.home,
                slot.scope_kind,
                slot.project_id,
                slot.agent_profile,
                slot.canvas_id,
                session_id,
            )

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
        resume_existing_session: bool = True,
    ) -> _WorkerSlot:
        """Replace a running worker with a fresh token/session.

        Agent tokens live in the subprocess environment, so scope updates can
        happen server-side but credential renewal requires a worker restart.
        Spawn first; if control-plane issuance fails, keep the old worker alive.
        Track the replacement before closing the old slot so a cancelled request
        cannot leave the fresh token unmanaged.

        The replacement inherits the *egress* identity of the slot it replaces.
        Rotation is triggered by callers that carry no authorization of their own
        (``prewarm``, a home-scope turn, a second browser tab), and an org slot
        always rotates on the first such touch because ``gateway_fingerprint`` is
        left empty for it. Dropping the identity here would hand that user's
        resumed session to a worker credentialed with the deployment-level
        ``NEWAPI_API_KEY`` — the platform paying for the org's compute, silently.
        The session identity still follows the caller's scope; only the egress
        identity is inherited, which is exactly why S3 split the two parameters.
        """
        evidence_metrics.observe(f"worker_rotated:{reason}")
        if resume_existing_session:
            self._remember_session(slot)
        else:
            self._forget_session(
                slot.username,
                slot.scope_kind,
                slot.project_id,
                slot.agent_profile,
                slot.canvas_id,
                home=slot.home,
            )
        same_scope = self._scope_key(
            slot.scope_kind,
            slot.project_id,
            slot.agent_profile,
            slot.canvas_id,
        ) == self._scope_key(scope_kind, project_id, agent_profile, canvas_id)
        resume_session_id = slot.thread.id if same_scope and resume_existing_session else None
        replacement = await self._spawn_locked(
            slot.username,
            model=model if model is not None else slot.model,
            agent_profile=agent_profile,
            tool_mode=tool_mode,
            scope_kind=scope_kind,
            session_project_id=project_id,
            surface=surface,
            canvas_id=canvas_id,
            egress_project_id=slot.egress_project_id,
            requester_user_id=slot.requester_user_id,
            resume_session_id=resume_session_id,
            resume_persisted_session=resume_existing_session,
        )
        _log.info(
            "rotating hermes worker for user=%s old_agent_session=%s new_agent_session=%s reason=%s",
            slot.username,
            slot.token.session_id,
            replacement.token.session_id,
            reason,
        )
        self._slots[self._slot_key(slot.username, agent_profile)] = replacement
        await asyncio.shield(self._close_slot(slot, remember_session=False))
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
        egress_project_id: str | None = None,
        requester_user_id: str | None = None,
        project_env: dict[str, str] | None = None,
        authorization: HermesTurnAuthorization | None = None,
    ) -> dict[str, str]:
        """Build the strict environment passed only to this Hermes worker.

        ``project_id`` feeds the child process environment; ``egress_project_id``
        and ``requester_user_id`` feed only the trusted-context admission check
        and must both be supplied whenever an authorization is present.
        """
        if authorization is not None:
            if not egress_project_id:
                raise EgressBoundaryError("TASK_ENVELOPE_INVALID")
            # 身份复核要有独立来源才叫复核。取 `authorization.context` 自己的值，
            # `build_hermes_child_env` 里那次 `_strict_admission` 就退化成 `x != x`
            # 恒真通过。缺了就拒，**不得回落成 `authorization.context.requester_user_id`**
            # ——那等于把刚修好的洞原样填回去。
            if not requester_user_id:
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
                requester_user_id=requester_user_id,
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
            "NOVELVIDEO_OUTPUT_DIR": str(config.OUTPUT_DIR),
            "NOVELVIDEO_STATE_DIR": str(config.STATE_DIR),
            "NOVELVIDEO_RUNTIME_DIR": str(config.RUNTIME_DIR),
            "ST_EDITION": os.environ.get("ST_EDITION", "ce"),
            "DRAMACLAW_FREEZONE_TOOL_RESULT_DIR": str(home / "tmp" / "freezone-tool-results"),
            # 绝不把控制面数据库凭据传进 Hermes 子进程:worker 只经短期 agent token
            # 走 HTTP API,拿到 DSN 会让插件/依赖的任意代码执行缺陷绕开业务鉴权直连库。
            # (凭据化启动路径 build_hermes_child_env 本就不带 DSN,这里对齐旧分支。)
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
        if agent_profile.startswith("freezone"):
            hook_dir = freezone_python_hook_dir(home)
            existing_pythonpath = os.environ.get("PYTHONPATH", "").strip()
            env["PYTHONPATH"] = (
                f"{hook_dir}{os.pathsep}{existing_pythonpath}" if existing_pythonpath else str(hook_dir)
            )
            env["DRAMACLAW_DISABLE_HERMES_SKILL_MANAGE"] = "1"
            env["DRAMACLAW_HERMES_TOOL_DENY"] = ",".join(FREEZONE_HERMES_TOOL_DENY)
        if project_id:
            env["DRAMACLAW_PROJECT_ID"] = project_id
            env["DRAMACLAW_PROJECT"] = project_id
            env["SUPERTALE_PROJECT_ID"] = project_id
            # Backward-compatible alias for older skill references.
            env["SUPERTALE_PROJECT"] = project_id
        if project_env:
            env.update(project_env)
        # Debug tracing: when the backend opts in, Hermes writes every model
        # request payload (messages + tool schemas, secrets redacted) to
        # logs/request_dump_*.json in the worker home, for token-consumption
        # analysis via scripts/dev/analyze_hermes_requests.py.
        dump_requests = os.environ.get("HERMES_DUMP_REQUESTS", "").strip()
        if dump_requests:
            env["HERMES_DUMP_REQUESTS"] = dump_requests
        _api_key, base_url = effective_gateway_credentials()
        # Both spawn paths look identical from here on. A worker started by a
        # platform turn used to carry the real platform key with no latch, so an
        # organisation turn reusing that worker would fall back to the platform
        # account the moment its _meta went missing — the exact cross-tenant
        # failure the per-turn credential removes. Neither path holds a key now.
        env["NEWAPI_API_KEY"] = PER_TURN_CREDENTIAL_PLACEHOLDER
        # Hermes can restore older custom-provider sessions through its generic
        # OpenAI-compatible path, which still reads this alias.
        env["OPENAI_API_KEY"] = PER_TURN_CREDENTIAL_PLACEHOLDER
        env["DRAMACLAW_GATEWAY_CREDENTIAL_MODE"] = "per_turn_required"
        if base_url:
            env["NEWAPI_BASE_URL"] = base_url
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
        self._slots.pop(self._slot_key(victim.username, victim.agent_profile), None)

    async def _revoke_agent_session(self, token: str) -> None:
        await get_auth_session_port().revoke_agent_session(token)

    async def _close_slot(
        self,
        slot: _WorkerSlot,
        *,
        remember_session: bool = True,
        strict: bool = False,
    ) -> bool:
        if remember_session:
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

    async def drain_user(self, username: str) -> bool:
        """Reject new turns and close after the current turn boundary."""
        async with self._lock:
            drained = False
            keys = [key for key, slot in self._slots.items() if slot.username == username]
            for key in keys:
                slot = self._slots.get(key)
                if slot is None or slot.state == "closed":
                    continue
                if slot.state == "draining":
                    if slot.active_turns == 0 and await self._close_slot(slot, strict=True):
                        slot.state = "closed"
                        self._slots.pop(key, None)
                    continue
                slot.state = "draining"
                if slot.active_turns == 0 and await self._close_slot(slot, strict=True):
                    slot.state = "closed"
                    self._slots.pop(key, None)
                drained = True
            return drained

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
