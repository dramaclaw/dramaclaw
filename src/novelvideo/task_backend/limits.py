"""Project-level task admission limits."""

from __future__ import annotations

import os
from dataclasses import dataclass

from novelvideo.task_backend.queues import normalize_queue_kind

PROJECT_LANE_LIMIT_DEFAULTS = {
    "default": 12,
    "video": 4,
    "world": 2,
    "ffmpeg": 2,
}

PROJECT_LANE_MIN_DEFAULTS = {
    "default": 3,
    "video": 1,
    "world": 1,
    "ffmpeg": 1,
}

PROJECT_USER_LANE_LIMIT_DEFAULTS = {
    "default": 3,
    "video": 1,
    "world": 1,
    "ffmpeg": 1,
}

GLOBAL_LANE_CONCURRENCY_DEFAULTS = {
    "default": 8,
    "video": 2,
    "world": 1,
    "ffmpeg": 1,
}

GLOBAL_LANE_QUEUE_LIMIT_DEFAULTS = {
    "default": 512,
    "video": 128,
    "world": 64,
    "ffmpeg": 64,
}


@dataclass
class ProjectTaskLimitExceeded(RuntimeError):
    project_id: str
    queue_kind: str
    limit: int
    active: int

    def __post_init__(self) -> None:
        super().__init__(self.project_id, self.queue_kind, self.limit, self.active)

    def __str__(self) -> str:
        return (
            f"project {self.project_id} {self.queue_kind} lane is full "
            f"({self.active}/{self.limit})"
        )


@dataclass
class ProjectUserTaskLimitExceeded(RuntimeError):
    project_id: str
    requester_user_id: str
    queue_kind: str
    limit: int
    active: int

    def __post_init__(self) -> None:
        super().__init__(
            self.project_id,
            self.requester_user_id,
            self.queue_kind,
            self.limit,
            self.active,
        )

    def __str__(self) -> str:
        return (
            f"user {self.requester_user_id} in project {self.project_id} "
            f"{self.queue_kind} lane is full ({self.active}/{self.limit})"
        )


@dataclass
class GlobalLaneQueueLimitExceeded(RuntimeError):
    project_id: str
    queue_kind: str
    limit: int
    queued: int

    def __post_init__(self) -> None:
        super().__init__(self.project_id, self.queue_kind, self.limit, self.queued)

    def __str__(self) -> str:
        return (
            f"global {self.queue_kind} lane queue is full for project {self.project_id} "
            f"({self.queued}/{self.limit})"
        )


@dataclass
class ChannelTaskLimitExceeded(RuntimeError):
    """Channel (organization or platform pool) in-flight lane limit.

    ``scope_kind`` is ``"platform"`` for the shared pool (``org_id is None``)
    and ``"organization"`` for a sold channel. The HTTP ``limit_scope`` is
    derived from it in the app-level handler, not stored here — same as the
    three project-level classes above.
    """

    scope_kind: str
    org_id: str | None
    queue_kind: str
    limit: int
    active: int

    def __post_init__(self) -> None:
        super().__init__(
            self.scope_kind,
            self.org_id,
            self.queue_kind,
            self.limit,
            self.active,
        )

    def __str__(self) -> str:
        return (
            f"channel {self.org_id or self.scope_kind} {self.queue_kind} lane is full "
            f"({self.active}/{self.limit})"
        )


@dataclass
class UserTaskLimitExceeded(RuntimeError):
    """Per-user in-flight lane limit inside a channel (not scoped to a project)."""

    requester_user_id: str
    queue_kind: str
    limit: int
    active: int

    def __post_init__(self) -> None:
        super().__init__(
            self.requester_user_id,
            self.queue_kind,
            self.limit,
            self.active,
        )

    def __str__(self) -> str:
        return (
            f"user {self.requester_user_id} {self.queue_kind} lane is full "
            f"({self.active}/{self.limit})"
        )


def _lane_active_limit(
    queue_kind: str | None,
    *,
    env_prefix: str,
    defaults: dict[str, int],
) -> int | None:
    lane = normalize_queue_kind(queue_kind)
    env_name = f"{env_prefix}_{lane.upper()}_TASKS"
    raw = os.environ.get(env_name)
    default = defaults[lane]
    if raw is None or not raw.strip():
        return default
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else None


def _positive_lane_int(
    queue_kind: str | None,
    *,
    env_prefix: str,
    defaults: dict[str, int],
) -> int:
    lane = normalize_queue_kind(queue_kind)
    env_name = f"{env_prefix}_{lane.upper()}_TASKS"
    raw = os.environ.get(env_name)
    default = defaults[lane]
    if raw is None or not raw.strip():
        return default
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return default
    return max(parsed, 1)


def project_lane_active_limit(queue_kind: str | None) -> int | None:
    return _lane_active_limit(
        queue_kind,
        env_prefix="ST_PROJECT_MAX_ACTIVE",
        defaults=PROJECT_LANE_LIMIT_DEFAULTS,
    )


def project_lane_min_active_limit(queue_kind: str | None) -> int:
    lane = normalize_queue_kind(queue_kind)
    env_name = f"ST_PROJECT_MIN_ACTIVE_{lane.upper()}_TASKS"
    raw = os.environ.get(env_name)
    default = PROJECT_LANE_MIN_DEFAULTS[lane]
    if raw is None or not raw.strip():
        return default
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return default
    return max(parsed, 0)


def project_user_lane_active_limit(queue_kind: str | None) -> int | None:
    return _lane_active_limit(
        queue_kind,
        env_prefix="ST_PROJECT_USER_MAX_ACTIVE",
        defaults=PROJECT_USER_LANE_LIMIT_DEFAULTS,
    )


def project_lane_effective_active_limit(
    queue_kind: str | None,
    *,
    eligible_user_count: int,
) -> int | None:
    hard_limit = project_lane_active_limit(queue_kind)
    user_limit = project_user_lane_active_limit(queue_kind)
    if hard_limit is None:
        return None
    if user_limit is None:
        return hard_limit
    member_count = max(int(eligible_user_count), 1)
    computed = max(project_lane_min_active_limit(queue_kind), member_count * user_limit)
    return min(hard_limit, computed)


def global_lane_concurrency(queue_kind: str | None) -> int:
    """CE inline execution slots per lane, distinct from per-project admission."""
    return _positive_lane_int(
        queue_kind,
        env_prefix="ST_CE_GLOBAL_MAX_ACTIVE",
        defaults=GLOBAL_LANE_CONCURRENCY_DEFAULTS,
    )


def global_lane_queue_limit(queue_kind: str | None) -> int:
    """CE inline pending queue bound per lane."""
    return _positive_lane_int(
        queue_kind,
        env_prefix="ST_CE_GLOBAL_MAX_QUEUED",
        defaults=GLOBAL_LANE_QUEUE_LIMIT_DEFAULTS,
    )
