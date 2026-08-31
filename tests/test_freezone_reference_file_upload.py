from __future__ import annotations

from io import BytesIO

import pytest
from fastapi import HTTPException, UploadFile

from novelvideo.api.routes.freezone import _read_upload_contents


@pytest.mark.asyncio
async def test_read_reference_file_accepts_exact_limit() -> None:
    upload = UploadFile(filename="reference.pdf", file=BytesIO(b"1234"))

    assert await _read_upload_contents(upload, max_bytes=4) == b"1234"


@pytest.mark.asyncio
async def test_read_reference_file_rejects_over_limit() -> None:
    upload = UploadFile(filename="reference.pdf", file=BytesIO(b"12345"))

    with pytest.raises(HTTPException) as exc_info:
        await _read_upload_contents(upload, max_bytes=4)

    assert exc_info.value.status_code == 413
    assert exc_info.value.detail == "reference file must be 100 MB or smaller"
