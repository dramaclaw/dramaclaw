"""Langfuse sink. The only module that imports the ``langfuse`` SDK."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

from novelvideo.llm_call_log.settings import LlmCallLogSettings

logger = logging.getLogger("novelvideo.llm_call_log")

_GENERATION_KINDS = frozenset({"text", "image", "audio", "video"})


@dataclass
class Attribution:
    user_id: str = ""
    project_id: str = ""
    resource_kind: str = ""


@dataclass
class Finish:
    output: Any = None
    status_code: int | None = None
    error: str = ""
    usage: dict[str, int] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class Sink(Protocol):
    def make_media(self, data: bytes, mime: str) -> Any: ...

    def start(
        self,
        *,
        name: str,
        kind: str,
        model: str,
        input: Any,
        metadata: dict[str, Any],
        attribution: Attribution,
    ) -> Any: ...

    def finish(self, handle: Any, result: Finish) -> None: ...

    def flush(self) -> None: ...


def _safe_str(value: str, limit: int = 190) -> str:
    # Langfuse propagated attributes must be US-ASCII and <=200 chars.
    return value.encode("ascii", "ignore").decode("ascii")[:limit]


class LangfuseSink:
    def __init__(self, settings: LlmCallLogSettings) -> None:
        from langfuse import Langfuse  # lazy: only needed when logging is on

        self._client = Langfuse(
            public_key=settings.public_key,
            secret_key=settings.secret_key,
            host=settings.host,
            environment=settings.environment,
        )

    def make_media(self, data: bytes, mime: str) -> Any:
        from langfuse.media import LangfuseMedia

        return LangfuseMedia(content_bytes=data, content_type=mime)  # type: ignore[arg-type]

    def start(
        self,
        *,
        name: str,
        kind: str,
        model: str,
        input: Any,
        metadata: dict[str, Any],
        attribution: Attribution,
    ) -> Any:
        from langfuse import propagate_attributes

        as_type = (
            "generation"
            if kind in _GENERATION_KINDS
            else "embedding"
            if kind == "embedding"
            else "span"
        )
        tags = [t for t in (kind, attribution.resource_kind) if t]
        trace_meta = {"kind": kind}
        if attribution.project_id:
            trace_meta["project_id"] = _safe_str(attribution.project_id)
        with propagate_attributes(
            user_id=_safe_str(attribution.user_id) or None,
            session_id=_safe_str(attribution.project_id) or None,
            tags=[_safe_str(t) for t in tags] or None,
            metadata=trace_meta,
            trace_name=_safe_str(name),
        ):
            kwargs: dict[str, Any] = {
                "name": name,
                "as_type": as_type,
                "input": input,
                "metadata": metadata,
            }
            if as_type != "span" and model:
                kwargs["model"] = model
            return self._client.start_observation(**kwargs)

    def finish(self, handle: Any, result: Finish) -> None:
        update: dict[str, Any] = {"output": result.output, "metadata": result.metadata}
        if result.usage:
            update["usage_details"] = result.usage
        if result.error:
            update["level"] = "ERROR"
            update["status_message"] = result.error[:500]
        handle.update(**update)
        handle.end()

    def flush(self) -> None:
        self._client.flush()
