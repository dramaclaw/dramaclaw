"""Reusable API responses with explicit temporary-file ownership."""

from contextlib import suppress
from pathlib import Path

from fastapi.responses import FileResponse


class TemporaryFileResponse(FileResponse):
    """Delete the response file after delivery, failure, or cancellation."""

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with suppress(OSError):
                Path(self.path).unlink(missing_ok=True)
